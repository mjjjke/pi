import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessageText } from "./harness.ts";
import { createRpcHarness, type RpcHarness, type RpcRecord } from "./rpc-harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
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

function isAck(record: RpcRecord, state: string): boolean {
	const entry = record.entry as { type?: string; customType?: string; data?: { state?: string } } | undefined;
	return (
		record.type === "entry_appended" &&
		entry?.type === "custom" &&
		entry.customType === "ack" &&
		entry.data?.state === state
	);
}

function messageRole(record: RpcRecord): string | undefined {
	return (record.message as { role?: string } | undefined)?.role;
}

describe("RPC: developer instruction queued by a command mid-run", () => {
	const harnesses: RpcHarness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("acks pending before the command response and committed at the next provider request", async () => {
		let releaseBarrier = () => {};
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const harness = await createRpcHarness(rpcIo, {
			extensionFactory: (pi) => {
				pi.registerTool({
					name: "barrier",
					label: "barrier",
					description: "Blocks until released",
					parameters: Type.Object({}),
					execute: async () => {
						markStarted();
						await new Promise<void>((resolve) => {
							releaseBarrier = resolve;
						});
						return { content: [{ type: "text", text: "released" }], details: {} };
					},
				});
				pi.registerCommand("mode", {
					description: "Queue a boundary",
					handler: async (_args, ctx) => {
						const result = ctx.queueDeveloperMessage("Plan boundary.", {
							onCommit: (entryId) => pi.appendEntry("ack", { state: "committed", entryId }),
						});
						if (result.status === "pending") {
							pi.appendEntry("ack", { state: "pending", pendingId: result.pendingId });
						}
					},
				});
			},
		});
		harnesses.push(harness);
		const requests: string[][] = [];
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("barrier", {}), { stopReason: "toolUse" }),
			(context) => {
				requests.push(context.messages.map((message) => `${message.role}:${getMessageText(message)}`));
				return fauxAssistantMessage("done");
			},
		]);

		harness.send({ id: "p1", type: "prompt", message: "start" });
		await harness.waitForResponse("p1");
		await started;

		harness.send({ id: "cmd", type: "prompt", message: "/mode" });
		expect(await harness.waitForResponse("cmd")).toMatchObject({ success: true });
		expect(harness.records().some((record) => isAck(record, "committed"))).toBe(false);

		releaseBarrier();
		await vi.waitFor(() => expect(harness.records().some((record) => record.type === "agent_settled")).toBe(true));

		const records = harness.records();
		const pendingAck = records.findIndex((record) => isAck(record, "pending"));
		const cmdResponse = records.findIndex((record) => record.type === "response" && record.id === "cmd");
		const committedAck = records.findIndex((record) => isAck(record, "committed"));
		const developerStart = records.findIndex(
			(record) => record.type === "message_start" && messageRole(record) === "developer",
		);
		const toolResultEnd = records.findIndex(
			(record) => record.type === "message_end" && messageRole(record) === "toolResult",
		);
		const assistantEnds = records.flatMap((record, index) =>
			record.type === "message_end" && messageRole(record) === "assistant" ? [index] : [],
		);
		const finalAssistantEnd = assistantEnds.at(-1) ?? -1;
		expect(pendingAck).toBeGreaterThanOrEqual(0);
		expect(pendingAck).toBeLessThan(cmdResponse);
		expect(committedAck).toBeGreaterThan(toolResultEnd);
		expect(developerStart).toBeGreaterThan(committedAck);
		expect(finalAssistantEnd).toBeGreaterThan(developerStart);
		expect(requests[0]?.at(-1)).toBe("developer:Plan boundary.");

		const committed = records[committedAck]!.entry as { data: { entryId: string } };
		const entries = harness.runtime.session.sessionManager.getEntries();
		const developerEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "developer");
		expect(developerEntry?.id).toBe(committed.data.entryId);
	});
});
