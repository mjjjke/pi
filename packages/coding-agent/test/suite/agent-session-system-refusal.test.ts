import {
	type Api,
	fauxAssistantMessage,
	fauxToolCall,
	lazyApi,
	type Model,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, type Harness } from "./harness.ts";
import { createRpcHarness, type RpcHarness } from "./rpc-harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	onRawStdoutBroken: vi.fn(() => () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const REFUSAL = "does not support mid-conversation system messages";

/** Route the session's faux stream through `lazyApi`, as real providers are; `capable` sets the compat flag. */
function useLazyApi(session: AgentSession, capable: (model: Model<Api>) => boolean): void {
	const original = session.agent.streamFunction as unknown as ProviderStreams["streamSimple"];
	const api = lazyApi(async () => ({ stream: original, streamSimple: original }) as ProviderStreams);
	session.agent.streamFunction = (model, context, options) =>
		api.streamSimple(
			{ ...(model as Model<Api>), compat: { supportsMidConvoSystemMessages: capable(model as Model<Api>) } },
			context,
			options,
		);
}

/** An extension that narrows the active tools at run `changeFrom` (that run then carries a section patch and a tool delta). */
function changingPrompt(state: { runs: number; changeFrom: number }) {
	return (pi: ExtensionAPI) => {
		pi.on("before_agent_start", () => {
			state.runs++;
			if (state.runs === state.changeFrom) pi.setActiveTools(["read"]);
		});
		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary: "summary",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {},
			},
		}));
	};
}

function lastError(session: AgentSession): string | undefined {
	const last = session.messages.at(-1);
	return last?.role === "assistant" && last.stopReason === "error" ? last.errorMessage : undefined;
}

describe("AgentSession on a model without mid-conversation system messages", () => {
	const harnesses: Harness[] = [];
	const rpcHarnesses: RpcHarness[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (rpcHarnesses.length > 0) await rpcHarnesses.pop()?.cleanup();
	});

	async function setup(factories: Array<(pi: ExtensionAPI) => void>): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 100000, maxTokens: 100 },
				{ id: "faux-capable", contextWindow: 100000, maxTokens: 100 },
			],
			settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			extensionFactories: factories,
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		useLazyApi(harness.session, (model) => model.id === "faux-capable");
		return harness;
	}

	it("the first run passes; a later section patch is refused with no provider call and no retry; /compact recovers", async () => {
		const harness = await setup([changingPrompt({ runs: 0, changeFrom: 2 })]);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("three")]);

		await harness.session.prompt("first");
		expect(harness.faux.state.callCount).toBe(1);
		expect(lastError(harness.session)).toBeUndefined();

		await harness.session.prompt("second");
		expect(harness.faux.state.callCount).toBe(1);
		expect(lastError(harness.session)).toContain(REFUSAL);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);

		await harness.session.compact();
		await harness.session.prompt("third");
		expect(harness.faux.state.callCount).toBe(2);
		expect(lastError(harness.session)).toBeUndefined();
	});

	it("after switching to a capable model the refused update passes", async () => {
		const harness = await setup([changingPrompt({ runs: 0, changeFrom: 2 })]);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("three")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(lastError(harness.session)).toContain(REFUSAL);

		await harness.session.setModel(harness.getModel("faux-capable")!);
		await harness.session.prompt("third");
		expect(harness.faux.state.callCount).toBe(2);
		expect(lastError(harness.session)).toBeUndefined();
	});

	it("a tool registered mid-run is refused at the next request", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await setup([
			(pi) => {
				api = pi;
				pi.registerTool({
					name: "register_late",
					label: "register_late",
					description: "register_late",
					parameters: Type.Object({}),
					execute: async () => {
						api!.registerTool({
							name: "late",
							label: "late",
							description: "late",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "late" }], details: {} }),
						});
						return { content: [{ type: "text", text: "registered" }], details: {} };
					},
				});
			},
		]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("register_late", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("never"),
		]);

		await harness.session.prompt("go");

		expect(harness.faux.state.callCount).toBe(1);
		expect(lastError(harness.session)).toContain(REFUSAL);
	});

	it("RPC: the refused run's message_end carries errorMessage", async () => {
		const state = { runs: 0, changeFrom: 2 };
		const harness = await createRpcHarness(rpcIo, { extensionFactory: changingPrompt(state) });
		rpcHarnesses.push(harness);
		useLazyApi(harness.runtime.session, () => false);
		harness.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("never")]);

		harness.send({ id: "p1", type: "prompt", message: "first" });
		await harness.waitForResponse("p1");
		await harness.runtime.session.waitForIdle();
		harness.send({ id: "p2", type: "prompt", message: "second" });
		await harness.waitForResponse("p2");
		await harness.runtime.session.waitForIdle();

		const ends = harness
			.records()
			.filter(
				(record) =>
					record.type === "message_end" && (record.message as { role?: string } | undefined)?.role === "assistant",
			);
		expect((ends.at(-1)?.message as { errorMessage?: string }).errorMessage).toContain(REFUSAL);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("print mode exits 1 when the request is refused", async () => {
		const harness = await setup([changingPrompt({ runs: 0, changeFrom: 2 })]);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("never")]);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const host = {
			session: harness.session,
			newSession: vi.fn(async () => undefined),
			fork: vi.fn(async () => ({ selectedText: "" })),
			switchSession: vi.fn(async () => undefined),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		};

		const exitCode = await runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], {
			mode: "text",
			messages: ["first", "second"],
		});

		expect(exitCode).toBe(1);
		expect(harness.faux.state.callCount).toBe(1);
	});
});
