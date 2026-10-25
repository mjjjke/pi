import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionResult } from "../../src/core/compaction/index.ts";
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
	writeRawStdout: (line: string) => rpcIo.outputLines.push(line),
}));
vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const harnesses: RpcHarness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.cleanup();
});
async function setup() {
	let finish!: (result: CompactionResult) => void;
	const summary = new Promise<CompactionResult>((resolve) => {
		finish = resolve;
	});
	const h = await createRpcHarness(rpcIo, {
		extensionFactory: (pi) => {
			pi.on("session_before_compact", () => summary.then((compaction) => ({ compaction })));
		},
	});
	harnesses.push(h);
	const session = h.runtime.session;
	session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 10, reserveTokens: 1000 } });
	const manager = session.sessionManager;
	manager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
	manager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
	const model = session.model!;
	manager.appendMessage({ ...fauxAssistantMessage("old"), api: model.api, provider: model.provider, model: model.id });
	const kept = manager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 4 });
	session.refreshContext();
	return { h, finish: () => finish({ summary: "summary", firstKeptEntryId: kept, tokensBefore: 0 }) };
}

describe("RPC background compaction", () => {
	it("defaults to background, responds before summary, reuses and cancels by job id", async () => {
		const { h } = await setup();
		h.send({ id: "launch", type: "compact" });
		await vi.waitFor(() => expect(h.records().some((r) => r.type === "session_background_compaction")).toBe(true));
		expect(await h.waitForResponse("launch")).toMatchObject({ success: true, data: { status: "started" } });
		const jobId = h.runtime.session.getBackgroundCompaction()!.jobId;
		h.send({ id: "again", type: "compact", mode: "background" });
		expect(await h.waitForResponse("again")).toMatchObject({ data: { status: "already", jobId } });
		h.send({ id: "wrong", type: "cancel_background_compaction", jobId: "other" });
		expect(await h.waitForResponse("wrong")).toMatchObject({ data: { cancelled: false } });
		h.send({ id: "cancel", type: "cancel_background_compaction", jobId });
		expect(await h.waitForResponse("cancel")).toMatchObject({ data: { cancelled: true } });
		expect(
			h
				.records()
				.filter((r) => r.type === "session_background_compaction")
				.map((r) => r.phase),
		).toEqual(["started", "discarded"]);
		expect(h.records().some((r) => r.type === "compaction_start" || r.type === "session_compact_failed")).toBe(false);
	});

	it("now holds queued input; abort releases the wait, not the summary, then input delivers once", async () => {
		const { h, finish } = await setup();
		h.send({ id: "now", type: "compact", mode: "now" });
		await vi.waitFor(() => expect(h.records().some((r) => r.phase === "waiting")).toBe(true));
		h.send({ id: "queued", type: "prompt", message: "queued" });
		expect(await h.waitForResponse("queued")).toMatchObject({ success: true, data: { disposition: "queued" } });
		expect(h.records().some((r) => r.type === "agent_start")).toBe(false);
		h.send({ id: "abort", type: "abort" });
		expect(await h.waitForResponse("abort")).toMatchObject({ success: true });
		expect(await h.waitForResponse("now")).toMatchObject({ success: true, data: { status: "released" } });
		expect(h.runtime.session.getBackgroundCompaction()?.phase).toBe("summarizing");
		finish();
		await vi.waitFor(() => expect(h.runtime.session.getBackgroundCompaction()?.phase).toBe("ready"));
		h.faux.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("done queued")]);
		h.send({ id: "later", type: "prompt", message: "later" });
		await h.waitForResponse("later");
		await h.runtime.session.waitForIdle();
		const branch = h.runtime.session.sessionManager.getBranch();
		expect(branch.filter((e) => e.type === "compaction")).toHaveLength(1);
		expect(
			branch.filter(
				(e) =>
					e.type === "message" &&
					e.message.role === "user" &&
					JSON.stringify(e.message.content).includes("queued"),
			),
		).toHaveLength(1);
		expect(
			h.records().filter((r) => r.type === "session_background_compaction" && r.phase === "applied"),
		).toHaveLength(1);
	});

	it("now returns only the committed entry identity, not in-process job handles", async () => {
		const { h, finish } = await setup();
		h.send({ id: "now", type: "compact", mode: "now" });
		await vi.waitFor(() => expect(h.records().some((r) => r.phase === "waiting")).toBe(true));
		finish();
		const response = await h.waitForResponse("now");
		const entry = h.runtime.session.sessionManager.getBranch().find((e) => e.type === "compaction");
		expect(response.data).toEqual({ status: "applied", entryId: entry?.id });
		expect(h.records().filter((r) => r.phase === "applied")).toHaveLength(1);
	});

	it("now cancellation stops the waiter without a blocking restart or provider request", async () => {
		const { h, finish } = await setup();
		h.send({ id: "now", type: "compact", mode: "now" });
		await vi.waitFor(() => expect(h.records().some((r) => r.phase === "waiting")).toBe(true));
		h.send({ id: "cancel", type: "cancel_background_compaction" });
		expect(await h.waitForResponse("cancel")).toMatchObject({ data: { cancelled: true } });
		await h.waitForResponse("now");
		finish();
		await Promise.resolve();
		expect(h.runtime.session.isIdle).toBe(true);
		expect(h.records().some((r) => r.type === "agent_start" || r.type === "compaction_start")).toBe(false);
		expect(h.runtime.session.sessionManager.getBranch().some((e) => e.type === "compaction")).toBe(false);
	});
});
