import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness } from "./harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	onRawStdoutBroken: vi.fn(() => () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

// chmod does not stop root from writing.
const runsAsRoot = process.getuid?.() === 0;

function records(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe.skipIf(runsAsRoot)("RPC: a session write fails in a run's final drain (§3.6)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("emits one acceptance, one agent_end, the write error and agent_settled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-rpc-persistence-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		const harness = await createHarness({ sessionManager });
		harness.setResponses([fauxAssistantMessage("uno"), fauxAssistantMessage("dos")]);
		await harness.session.prompt("uno");
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected a session file path");
		cleanups.push(() => {
			chmodSync(file, 0o644);
			harness.cleanup();
		});
		harness.session.subscribe((event) => {
			if (event.type !== "agent_end") return;
			harness.session.recordBashResult("printf done", {
				output: "done",
				exitCode: 0,
				cancelled: false,
				truncated: false,
			});
			chmodSync(file, 0o444);
		});
		const host = { session: harness.session, setRebindSession() {}, dispose: async () => {} };
		void runRpcMode(host as unknown as AgentSessionRuntime);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

		rpcIo.lineHandler?.(JSON.stringify({ id: "late", type: "prompt", message: "dos" }));
		await vi.waitFor(() => expect(records().some((record) => record.type === "agent_settled")).toBe(true));

		const output = records();
		expect(output.filter((record) => record.id === "late")).toEqual([
			{ type: "response", id: "late", command: "prompt", success: true, data: { disposition: "started" } },
		]);
		expect(output.filter((record) => record.type === "agent_end")).toHaveLength(1);
		const failure = output.findIndex((record) => record.type === "extension_error");
		expect(output[failure]).toMatchObject({
			extensionPath: "<runtime>",
			event: "session_persistence",
			error: expect.stringMatching(/^Session file write failed \(EACCES\)/),
		});
		expect(failure).toBeGreaterThan(output.findIndex((record) => record.type === "agent_end"));
		expect(failure).toBeLessThan(output.findIndex((record) => record.type === "agent_settled"));
		expect(harness.session.isStreaming).toBe(false);
	});
});
