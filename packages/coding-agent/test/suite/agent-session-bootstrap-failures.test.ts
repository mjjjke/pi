import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { createRuntimeHarness, type RuntimeHarness } from "./runtime-harness.ts";

function describeMessage(message: { role: string }): string {
	return message.role === "system" || message.role === "assistant"
		? message.role
		: `${message.role}:${getMessageText(message)}`;
}

function journal(harness: Harness): string[] {
	return harness.sessionManager.buildSessionProjection().messages.map(describeMessage);
}

function recordRequests(harness: Harness, count = 1): string[][] {
	const requests: string[][] = [];
	harness.setResponses(
		Array.from(
			{ length: count },
			(): FauxResponseFactory => (context) => {
				requests.push(context.messages.map(describeMessage));
				return fauxAssistantMessage("done");
			},
		),
	);
	return requests;
}

/** Make appendMessage throw for developer messages with the given text while `failing()` is true. */
function failDeveloperAppend(harness: Harness, text: string, failing: () => boolean) {
	const original = harness.sessionManager.appendMessage.bind(harness.sessionManager);
	return vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message, options) => {
		if (failing() && message.role === "developer" && getMessageText(message) === text) {
			throw new Error(`append failed: ${text}`);
		}
		return original(message, options);
	});
}

describe("AgentSession bootstrap commit failures", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		factories: Array<(pi: ExtensionAPI) => void> = [],
		sessionManager?: SessionManager,
		tools?: AgentTool[],
	): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: factories,
			sessionManager,
			tools,
			initialActiveToolNames: tools ? [] : undefined,
		});
		harnesses.push(harness);
		return harness;
	}

	it("B fails after developer A commits: A's onCommit runs once, no request, the rest stays staged; retries are exact (Astra M3)", async () => {
		const harness = await setup();
		const onA = vi.fn();
		const onB = vi.fn();
		let attempts = 0;
		harness.session.queueDeveloperMessage("A", { onCommit: onA });
		harness.session.queueDeveloperMessage("B", { onCommit: onB });
		const x = harness.session.queueDeveloperMessage("X");
		await harness.session.sendCustomMessage({ customType: "c", content: "content", display: false });
		await harness.session.sendCustomMessage(
			{ customType: "nt", content: "next", display: false },
			{ deliverAs: "nextTurn" },
		);
		failDeveloperAppend(harness, "B", () => attempts < 3);
		const snapshotEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "system") snapshotEvents.push("system");
		});
		const requests = recordRequests(harness);

		attempts++;
		await expect(harness.session.prompt("start")).rejects.toThrow("append failed: B");
		expect(requests).toHaveLength(0);
		expect(onA).toHaveBeenCalledTimes(1);
		expect(onB).not.toHaveBeenCalled();
		expect(snapshotEvents).toEqual(["system"]);
		expect(journal(harness)).toEqual(["system", "developer:A"]);
		expect(x.status).toBe("staged");
		if (x.status === "staged") expect(harness.session.cancelQueuedDeveloperMessage(x.pendingId)).toBe(true);

		attempts++;
		await expect(harness.session.prompt("start")).rejects.toThrow("append failed: B");
		expect(requests).toHaveLength(0);
		expect(onA).toHaveBeenCalledTimes(1);
		expect(snapshotEvents).toEqual(["system"]);
		expect(journal(harness)).toEqual(["system", "developer:A"]);

		attempts++;
		// An idle append while leftovers are staged stays behind them (FIFO).
		harness.session.appendDeveloperMessage("late");
		await harness.session.prompt("start");
		expect(requests).toEqual([
			["system", "developer:A", "developer:B", "developer:late", "user:content", "user:start", "user:next"],
		]);
		expect(onA).toHaveBeenCalledTimes(1);
		expect(onB).toHaveBeenCalledTimes(1);
		expect(snapshotEvents).toEqual(["system"]);
	});

	it("a preflight throw keeps staged items and nextTurn; preflight buffers move to staging", async () => {
		const harness = await setup([
			(pi) => {
				pi.on("before_agent_start", () => {
					pi.sendMessage({ customType: "pf", content: "preflight", display: false }, { triggerTurn: false });
				});
			},
		]);
		harness.session.queueDeveloperMessage("dev");
		await harness.session.sendCustomMessage(
			{ customType: "nt", content: "next", display: false },
			{ deliverAs: "nextTurn" },
		);
		const requests = recordRequests(harness);

		// Extension handler errors are reported, so force a failure through image normalization instead.
		const internals = harness.session as unknown as { _normalizePromptImages: () => Promise<unknown> };
		const spy = vi.spyOn(internals, "_normalizePromptImages").mockRejectedValueOnce(new Error("preflight failed"));
		await expect(harness.session.prompt("start")).rejects.toThrow("preflight failed");
		spy.mockRestore();
		expect(journal(harness)).toEqual([]);
		expect(harness.session.stagedMessages.map(describeMessage)).toEqual(["custom:preflight"]);

		await harness.session.prompt("again");
		expect(requests[0]).toEqual([
			"system",
			"developer:dev",
			"user:preflight",
			"user:preflight",
			"user:again",
			"user:next",
		]);
	});

	it("preflight custom messages emit message events once after B; idle-staged content emits none at B (Astra m13)", async () => {
		const harness = await setup([
			(pi) => {
				pi.on("before_agent_start", () => {
					pi.sendMessage({ customType: "pf", content: "preflight", display: false }, { triggerTurn: false });
				});
			},
		]);
		const counts = new Map<string, number>();
		let inPrompt = false;
		harness.session.subscribe((event) => {
			if ((event.type === "message_start" || event.type === "message_end") && inPrompt) {
				const key = `${event.type}:${describeMessage(event.message)}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		});
		await harness.session.sendCustomMessage({ customType: "idle", content: "idle", display: false });
		recordRequests(harness);
		inPrompt = true;
		await harness.session.prompt("go");

		expect(counts.get("message_start:custom:preflight")).toBe(1);
		expect(counts.get("message_end:custom:preflight")).toBe(1);
		expect(counts.get("message_start:custom:idle")).toBeUndefined();
	});

	it("an unannounced preflight item persisted before a failing append emits its events once; no listener runs between appends (recheck N7)", async () => {
		const existing = SessionManager.inMemory();
		const harness = await setup(
			[
				(pi) => {
					pi.on("before_agent_start", () => {
						pi.queueDeveloperMessage("fails");
					});
				},
			],
			existing,
		);
		let appending = false;
		const original = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		let failing = true;
		vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message, options) => {
			appending = true;
			try {
				if (failing && message.role === "developer") throw new Error("disk full");
				return original(message, options);
			} finally {
				appending = false;
			}
		});
		const insideLoop: string[] = [];
		const ends: string[] = [];
		harness.session.subscribe((event) => {
			if (appending) insideLoop.push(event.type);
			if (event.type === "message_end") ends.push(describeMessage(event.message));
		});
		recordRequests(harness);

		await expect(harness.session.prompt("go")).rejects.toThrow("disk full");
		expect(ends).toEqual(["system"]);
		failing = false;
		await harness.session.prompt("go");
		expect(ends.filter((end) => end === "system")).toHaveLength(1);
		expect(insideLoop).toEqual([]);
	});

	it("a throwing session listener does not stop B's remaining events and callbacks", async () => {
		const harness = await setup();
		const onCommit = vi.fn();
		harness.session.queueDeveloperMessage("dev", { onCommit });
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "system") throw new Error("listener failed");
		});
		const seen: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "system") seen.push("system");
		});
		recordRequests(harness);
		await harness.session.prompt("go");
		expect(seen).toEqual(["system"]);
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("tree navigation away from a pre-system point discards staged items without onCommit", async () => {
		const seeded = SessionManager.inMemory();
		const markerId = seeded.appendCustomEntry("marker", {});
		const systemId = seeded.appendMessage({ role: "system", content: "", sections: {}, timestamp: 0 });
		const harness = await setup([], seeded);
		await harness.session.navigateTree(markerId);
		const onCommit = vi.fn();
		const staged = harness.session.queueDeveloperMessage("dev", { onCommit });
		expect(staged.status).toBe("staged");
		await harness.session.sendCustomMessage({ customType: "c", content: "content", display: false });
		expect(harness.session.stagedMessages).toHaveLength(1);

		await harness.session.navigateTree(systemId);

		expect(harness.session.stagedMessages).toEqual([]);
		if (staged.status === "staged")
			expect(harness.session.cancelQueuedDeveloperMessage(staged.pendingId)).toBe(false);
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("abort during preflight: B still commits, the loop persists the start and the run ends aborted (parity)", async () => {
		let session: AgentSession | undefined;
		const harness = await setup([
			(pi) => {
				pi.on("before_agent_start", () => {
					void session!.abort();
				});
			},
		]);
		session = harness.session;
		const onCommit = vi.fn();
		harness.session.queueDeveloperMessage("dev", { onCommit });
		await harness.session.sendCustomMessage({ customType: "c", content: "content", display: false });
		recordRequests(harness);

		await harness.session.prompt("go");

		const last = harness.session.messages.at(-1);
		expect(last?.role === "assistant" && last.stopReason).toBe("aborted");
		expect(harness.session.isIdle).toBe(true);
		expect(journal(harness).slice(0, 4)).toEqual(["system", "developer:dev", "custom:content", "user:go"]);
		expect(harness.session.stagedMessages).toEqual([]);
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("an idle append while leftovers of a failed B are staged stays behind them (FIFO)", async () => {
		const harness = await setup();
		let failing = true;
		harness.session.queueDeveloperMessage("A");
		failDeveloperAppend(harness, "A", () => failing);
		const requests = recordRequests(harness);
		await expect(harness.session.prompt("first")).rejects.toThrow("append failed: A");
		expect(journal(harness)).toEqual(["system"]);

		// The branch has a system now, but leftovers keep later producers staging behind them.
		const late = harness.session.queueDeveloperMessage("late");
		expect(late.status).toBe("staged");
		harness.session.appendDeveloperMessage("appended");
		await harness.session.sendCustomMessage({ customType: "c", content: "content", display: false });
		expect(journal(harness)).toEqual(["system"]);
		failing = false;

		await harness.session.prompt("second");
		expect(requests[0]).toEqual([
			"system",
			"developer:A",
			"developer:late",
			"developer:appended",
			"user:content",
			"user:second",
		]);
	});

	it("run-end and request-boundary drains never commit staged items", async () => {
		const harness = await setup();
		const onCommit = vi.fn();
		let failing = true;
		harness.session.queueDeveloperMessage("A");
		const staged = harness.session.queueDeveloperMessage("staged", { onCommit });
		failDeveloperAppend(harness, "A", () => failing);
		const requests = recordRequests(harness, 2);
		await expect(harness.session.prompt("first")).rejects.toThrow("append failed: A");
		failing = false;

		// A run that bypasses the session's run start reaches the request boundary and the run-end drain
		// with the leftovers staged: neither commits them.
		await harness.session.agent.prompt({ role: "user", content: "direct", timestamp: Date.now() });
		(
			harness.session as unknown as { _commitPendingInstructionsAtRunEnd: () => void }
		)._commitPendingInstructionsAtRunEnd();

		expect(requests[0]).toEqual(["system", "user:direct"]);
		expect(journal(harness)).toEqual(["system", "user:direct", "assistant"]);
		expect(onCommit).not.toHaveBeenCalled();
		expect(staged.status).toBe("staged");

		// The next run start commits them through B, before its start message.
		await harness.session.prompt("second");
		expect(requests[1]?.slice(-3)).toEqual(["developer:A", "developer:staged", "user:second"]);
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("B fails on the second standing value: the first keeps its entry and one event; the next B writes the second before the one-shots", async () => {
		const delivered: string[] = [];
		const harness = await setup([
			(pi) => {
				pi.on("standing_instruction_delivered", (event) => {
					delivered.push(`${event.key}:${event.content}`);
				});
			},
		]);
		await harness.session.bindExtensions({});
		harness.session.setStandingInstruction("a", "A");
		harness.session.setStandingInstruction("b", "B");
		harness.session.queueDeveloperMessage("one-shot");
		const original = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		let failing = true;
		vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message, options) => {
			if (failing && options?.standingKey === "b") throw new Error("b failed");
			return original(message, options);
		});
		const requests = recordRequests(harness);

		await expect(harness.session.prompt("first")).rejects.toThrow("b failed");
		expect(requests).toHaveLength(0);
		expect(journal(harness)).toEqual(["system", "developer:A"]);
		expect(delivered).toEqual(["a:A"]);
		expect(harness.session.getStandingInstruction("a")?.delivered).toBe(true);
		expect(harness.session.getStandingInstruction("b")?.delivered).toBe(false);

		failing = false;
		await harness.session.prompt("second");
		expect(requests[0]).toEqual(["system", "developer:A", "developer:B", "developer:one-shot", "user:second"]);
		expect(delivered).toEqual(["a:A", "b:B"]);
	});

	describe("reentrant onCommit (§3.5)", () => {
		const cleanupDirs: string[] = [];
		afterEach(() => {
			for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		});
		const tool: AgentTool = {
			name: "late_tool",
			label: "late_tool",
			description: "late_tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};

		async function reentrant(action: (session: AgentSession) => void, sessionManager?: SessionManager) {
			const harness = await setup([], sessionManager, [tool]);
			const errors: string[] = [];
			harness.session.extensionRunner.onError((error) => errors.push(error.error));
			harness.session.queueDeveloperMessage("A", { onCommit: () => action(harness.session) });
			const requests: Array<Array<{ role: string } & Record<string, unknown>>> = [];
			harness.setResponses([
				(context) => {
					requests.push(context.messages as never);
					return fauxAssistantMessage("done");
				},
			]);
			const described = () => requests.map((request) => request.map(describeMessage));
			return { harness, errors, requests, described };
		}

		it("queueDeveloperMessage is pending and committed before the first request, after the start", async () => {
			let status: string | undefined;
			const { harness, described } = await reentrant((session) => {
				status = session.queueDeveloperMessage("queued").status;
			});
			await harness.session.prompt("go");
			expect(status).toBe("pending");
			expect(described()).toEqual([["system", "developer:A", "user:go", "developer:queued"]]);
		});

		it("appendDeveloperMessage throws and is reported", async () => {
			let thrown: unknown;
			const { harness, errors, described } = await reentrant((session) => {
				try {
					session.appendDeveloperMessage("appended");
				} catch (error) {
					thrown = error;
					throw error;
				}
			});
			await harness.session.prompt("go");
			expect(thrown).toBeInstanceOf(Error);
			expect(errors).toEqual([(thrown as Error).message]);
			expect(described()).toEqual([["system", "developer:A", "user:go"]]);
		});

		it("a passive send is buffered and delivered at the turn boundary, after the start message", async () => {
			const { harness, described } = await reentrant((session) => {
				void session.sendCustomMessage({ customType: "p", content: "passive", display: false });
			});
			await harness.session.prompt("go");
			expect(described()).toEqual([["system", "developer:A", "user:go", "user:passive"]]);
			expect(journal(harness)).toEqual(["system", "developer:A", "user:go", "custom:passive", "assistant"]);
		});

		it("cancelling a later staged item returns false: it is already committed", async () => {
			let laterId: string | undefined;
			let cancelled: boolean | undefined;
			const { harness, described } = await reentrant((session) => {
				cancelled = session.cancelQueuedDeveloperMessage(laterId!);
			});
			const later = harness.session.queueDeveloperMessage("B");
			if (later.status === "staged") laterId = later.pendingId;
			await harness.session.prompt("go");
			expect(cancelled).toBe(false);
			expect(described()).toEqual([["system", "developer:A", "developer:B", "user:go"]]);
		});

		it("a tool change is declared by the loop before the first request", async () => {
			const { harness, requests } = await reentrant((session) => {
				session.setActiveToolsByName(["late_tool"]);
			});
			await harness.session.prompt("go");
			const systems = (requests[0] ?? []).filter((message) => message.role === "system");
			const declared = (message: Record<string, unknown>) =>
				((message.toolsAdded as Array<{ name: string }> | undefined) ?? []).map((item) => item.name);
			expect(declared(systems[0]!)).not.toContain("late_tool");
			expect(systems.flatMap(declared)).toContain("late_tool");
		});

		it("dispose rejects the run before agent.prompt; the batch stays persisted and a new file stays unflushed", async () => {
			const dir = join(tmpdir(), `pi-reentrant-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			cleanupDirs.push(dir);
			const sessionManager = SessionManager.create(dir, dir);
			const { harness, described } = await reentrant((session) => {
				session.dispose();
			}, sessionManager);
			await harness.session.prompt("go").catch(() => {});
			expect(described()).toEqual([]);
			expect(journal(harness)).toEqual(["system", "developer:A"]);
			const file = sessionManager.getSessionFile();
			expect(file && existsSync(file)).toBeFalsy();
		});

		it("setStandingInstruction is pending and delivered at the first request boundary", async () => {
			const { harness, described } = await reentrant((session) => {
				session.setStandingInstruction("mode", "Plan");
			});
			await harness.session.prompt("go");
			expect(described()).toEqual([["system", "developer:A", "user:go", "developer:Plan"]]);
			expect(harness.session.getStandingInstruction("mode")?.delivered).toBe(true);
		});
	});

	describe("session replacement and file creation", () => {
		const runtimes: RuntimeHarness[] = [];

		afterEach(async () => {
			while (runtimes.length > 0) await runtimes.pop()?.cleanup();
		});

		async function runtimeSetup(): Promise<RuntimeHarness> {
			const harness = await createRuntimeHarness();
			runtimes.push(harness);
			harness.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
			return harness;
		}

		function stageItems(session: AgentSession) {
			const onCommit = vi.fn();
			const staged = session.queueDeveloperMessage("dev", { onCommit });
			expect(staged.status).toBe("staged");
			void session.sendCustomMessage({ customType: "c", content: "content", display: false });
			expect(session.stagedMessages).toHaveLength(1);
			return onCommit;
		}

		it("/new and /resume discard staged items without onCommit", async () => {
			const harness = await runtimeSetup();
			await harness.runtime.session.prompt("hello");
			const firstFile = harness.runtime.session.sessionFile!;

			await harness.runtime.newSession();
			const beforeResume = harness.runtime.session;
			const resumeCommit = stageItems(beforeResume);
			await harness.runtime.switchSession(firstFile);
			expect(beforeResume.stagedMessages).toEqual([]);
			expect(harness.runtime.session.stagedMessages).toEqual([]);

			await harness.runtime.newSession();
			const beforeNew = harness.runtime.session;
			const newCommit = stageItems(beforeNew);
			await harness.runtime.newSession();
			expect(beforeNew.stagedMessages).toEqual([]);
			const session = harness.runtime.session;
			expect(session.stagedMessages).toEqual([]);

			await session.prompt("fresh");
			expect(
				session.sessionManager.buildSessionProjection().messages.map((message) => describeMessage(message)),
			).toEqual(["system", "user:fresh", "assistant"]);
			expect(resumeCommit).not.toHaveBeenCalled();
			expect(newCommit).not.toHaveBeenCalled();
		});

		it("a new file is not created before the first prompt, and continueRecent picks the prior conversation", async () => {
			const harness = await runtimeSetup();
			await harness.runtime.session.prompt("hello");
			const firstFile = harness.runtime.session.sessionFile!;
			expect(existsSync(firstFile)).toBe(true);

			await harness.runtime.newSession({
				setup: async (sm) => {
					sm.appendCustomEntry("handoff-state", {});
				},
				withSession: async (ctx) => {
					await ctx.sendMessage({ customType: "handoff", content: "handoff", display: true });
					ctx.appendDeveloperMessage("notice");
				},
			});
			const session = harness.runtime.session;
			session.setStandingInstruction("mode", "Plan");
			const newFile = session.sessionFile!;
			expect(newFile).not.toBe(firstFile);
			expect(existsSync(newFile)).toBe(false);
			expect(SessionManager.continueRecent(harness.tempDir, harness.sessionDir).getSessionFile()).toBe(firstFile);

			await session.prompt("go");
			expect(existsSync(newFile)).toBe(true);
		});
	});

	it("reload drops extension-owned staged instructions but keeps SDK-owned ones and content", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await setup([
			(pi) => {
				api = pi;
			},
		]);
		await harness.session.bindExtensions({});
		const extensionCommit = vi.fn();
		api!.queueDeveloperMessage("from extension", { onCommit: extensionCommit });
		harness.session.queueDeveloperMessage("from sdk");
		await harness.session.sendCustomMessage({ customType: "c", content: "content", display: false });
		await harness.session.reload();
		expect(harness.session.stagedMessages.map(describeMessage)).toEqual(["custom:content"]);
		// The reload reset the API providers: check the journal written by B, not the request.
		await harness.session.prompt("go").catch(() => {});
		expect(journal(harness).slice(0, 3)).toEqual(["system", "developer:from sdk", "custom:content"]);
		expect(extensionCommit).not.toHaveBeenCalled();
	});
});
