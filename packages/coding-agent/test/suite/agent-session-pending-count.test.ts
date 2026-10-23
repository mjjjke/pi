import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
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

/** Stage a one-shot, a custom message and a bash result, and set a pending standing value, before the first run. */
function stageEverything(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		pi.queueDeveloperMessage("one-shot");
		pi.sendMessage({ customType: "handoff", content: "handoff", display: true });
		pi.setStandingInstruction("mode", "Plan");
	});
}

describe("pendingMessageCount ignores staged items and pending standing values (Astra M11)", () => {
	const harnesses: Harness[] = [];
	const rpcHarnesses: RpcHarness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (rpcHarnesses.length > 0) await rpcHarnesses.pop()?.cleanup();
	});

	it("SDK and extension context: zero with staged items; clearQueue leaves them staged", async () => {
		let ctxRef: ExtensionContext | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					stageEverything(pi);
					pi.on("session_start", (_event, ctx) => {
						ctxRef = ctx;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.session.recordBashResult("ls", { output: "file", exitCode: 0, cancelled: false, truncated: false });

		expect(harness.session.stagedMessages).toHaveLength(2);
		expect(harness.session.getStandingInstruction("mode")?.delivered).toBe(false);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(ctxRef?.hasPendingMessages()).toBe(false);

		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: [] });
		expect(harness.session.stagedMessages).toHaveLength(2);

		const requests: string[][] = [];
		harness.setResponses([
			(context) => {
				requests.push(context.messages.map((message) => message.role));
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("go");
		expect(requests[0]).toEqual(["system", "developer", "developer", "custom", "bashExecution", "user"].map(toWire));
	});

	it("RPC get_state.pendingMessageCount stays 0 with staged items; clear_queue leaves them", async () => {
		const harness = await createRpcHarness(rpcIo, { extensionFactory: stageEverything });
		rpcHarnesses.push(harness);

		harness.send({ id: "s1", type: "get_state" });
		const state = await harness.waitForResponse("s1");
		expect((state.data as { pendingMessageCount: number }).pendingMessageCount).toBe(0);
		harness.send({ id: "c1", type: "clear_queue" });
		await harness.waitForResponse("c1");
		expect(harness.runtime.session.stagedMessages).toHaveLength(1);
	});
});

/** Custom and bash messages reach the model as user-role text. */
function toWire(role: string): string {
	return role === "custom" || role === "bashExecution" ? "user" : role;
}
