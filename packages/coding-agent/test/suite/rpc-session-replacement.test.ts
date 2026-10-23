import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { getMessageText } from "./harness.ts";
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

type Command = "new_session" | "switch_session" | "fork" | "clone";

describe("RPC session replacement binds once (recheck N1)", () => {
	const harnesses: RpcHarness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function setup(onStart: (pi: ExtensionAPI, reason: string) => void) {
		const starts: Array<{ reason: string; sessionId: string }> = [];
		const harness = await createRpcHarness(rpcIo, {
			extensionFactory: (pi) => {
				pi.on("session_start", (event, ctx) => {
					starts.push({ reason: event.reason, sessionId: ctx.sessionManager.getSessionId() });
					onStart(pi, event.reason);
				});
			},
		});
		harnesses.push(harness);
		return { harness, starts };
	}

	/** Prepare a prior conversation, then return the command that replaces the session. */
	async function prepare(harness: RpcHarness, command: Command): Promise<Record<string, unknown>> {
		harness.faux.setResponses([fauxAssistantMessage("first")]);
		harness.send({ id: "p0", type: "prompt", message: "first prompt" });
		await harness.waitForResponse("p0");
		await harness.runtime.session.waitForIdle();
		const sessionManager = harness.runtime.session.sessionManager;
		switch (command) {
			case "new_session":
				return { type: "new_session" };
			case "switch_session": {
				const path = sessionManager.getSessionFile();
				harness.send({ id: "n0", type: "new_session" });
				await harness.waitForResponse("n0");
				return { type: "switch_session", sessionPath: path };
			}
			case "fork": {
				const user = sessionManager
					.getEntries()
					.find((entry) => entry.type === "message" && entry.message.role === "user");
				return { type: "fork", entryId: user!.id };
			}
			case "clone":
				return { type: "clone" };
		}
	}

	it.each(["new_session", "switch_session", "fork", "clone"] as const)(
		"%s emits session_start exactly once for the new session",
		async (command) => {
			const { harness, starts } = await setup(() => {});
			const replace = await prepare(harness, command);
			const before = starts.length;
			harness.send({ id: "r", ...replace });
			const response = await harness.waitForResponse("r");
			expect(response.success).toBe(true);
			const newId = harness.runtime.session.sessionManager.getSessionId();
			expect(starts.slice(before).filter((start) => start.sessionId === newId)).toHaveLength(1);
			expect(starts.slice(before)).toHaveLength(1);
		},
	);

	it.each(["new_session", "switch_session", "fork", "clone"] as const)(
		"%s: a session_start handler that starts a run reports success and sends the startup content once",
		async (command) => {
			let armed = false;
			const { harness } = await setup((pi, reason) => {
				if (!armed || reason === "startup") return;
				pi.sendMessage({ customType: "seed", content: "seed content", display: false });
				pi.sendUserMessage("kickoff");
			});
			const replace = await prepare(harness, command);
			const requests: string[][] = [];
			harness.faux.setResponses([
				((context) => {
					requests.push(context.messages.map((message) => `${message.role}:${getMessageText(message)}`));
					return fauxAssistantMessage("answer");
				}) satisfies FauxResponseFactory,
			]);
			armed = true;
			harness.send({ id: "r", ...replace });
			const response = await harness.waitForResponse("r");
			expect(response.success).toBe(true);
			await vi.waitFor(() => expect(requests).toHaveLength(1));
			await harness.runtime.session.waitForIdle();
			const last = requests[0]!;
			expect(last.filter((line) => line.includes("seed content"))).toHaveLength(1);
			expect(last.filter((line) => line === "user:kickoff")).toHaveLength(1);
		},
	);
});

describe("RPC session replacement surfaces load warnings", () => {
	it("switch_session prints the opened session's load warnings to stderr", async () => {
		const harness = await createRpcHarness(rpcIo, {});
		const stderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			stderr.push(String(chunk));
			return true;
		});
		try {
			harness.faux.setResponses([fauxAssistantMessage("first")]);
			harness.send({ id: "p0", type: "prompt", message: "first prompt" });
			await harness.waitForResponse("p0");
			await harness.runtime.session.waitForIdle();
			const path = harness.runtime.session.sessionManager.getSessionFile();
			harness.send({ id: "n0", type: "new_session" });
			await harness.waitForResponse("n0");
			const { SessionManager } = await import("../../src/core/session-manager.ts");
			vi.spyOn(SessionManager.prototype, "getLoadWarnings").mockReturnValue(["stray file kept in memory"]);

			harness.send({ id: "s0", type: "switch_session", sessionPath: path });
			await harness.waitForResponse("s0");

			expect(stderr.join("")).toContain("Warning: stray file kept in memory");
		} finally {
			vi.restoreAllMocks();
			await harness.cleanup();
		}
	});
});
