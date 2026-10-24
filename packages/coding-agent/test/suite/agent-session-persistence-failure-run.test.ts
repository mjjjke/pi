import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StartMessagePersistence } from "../../src/core/agent-session.ts";
import type { ExtensionAPI, ExtensionError } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

// chmod does not stop root from writing.
const runsAsRoot = process.getuid?.() === 0;

type Receipt = StartMessagePersistence;

// The outcome is read-only for observers (compile-time check).
export function assignOutcome(outcome: StartMessagePersistence): void {
	// @ts-expect-error read-only field
	outcome.persisted = true;
}

describe.skipIf(runsAsRoot)("AgentSession: a session write fails during a run (§3.6)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function setup(
		options: { extensionFactories?: Array<(pi: ExtensionAPI) => void>; readOnly?: boolean } = {},
	): Promise<{ harness: Harness; file: string; sessionManager: SessionManager; errors: ExtensionError[] }> {
		const dir = mkdtempSync(join(tmpdir(), "pi-persistence-run-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		const harness = await createHarness({ sessionManager, extensionFactories: options.extensionFactories });
		const errors: ExtensionError[] = [];
		await harness.session.bindExtensions({ onError: (error) => errors.push(error) });
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected a session file path");
		harness.setResponses([fauxAssistantMessage("uno"), fauxAssistantMessage("dos"), fauxAssistantMessage("tres")]);
		await harness.session.prompt("uno");
		harness.events.length = 0;
		errors.length = 0;
		if (options.readOnly !== false) chmodSync(file, 0o444);
		cleanups.push(() => {
			chmodSync(file, 0o644);
			harness.cleanup();
		});
		return { harness, file, sessionManager, errors };
	}

	function eventTypes(harness: Harness): string[] {
		return harness.events.map((event) => event.type);
	}

	function assistantErrors(harness: Harness): string[] {
		return harness.events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "assistant" ? [event.message.errorMessage ?? ""] : [],
		);
	}

	/** Passive custom messages still buffered (private state: no public accessor exists). */
	function pendingCustomTypes(harness: Harness): string[] {
		const session = harness.session as unknown as { _pendingCustomMessages: Array<{ customType: string }> };
		return session._pendingCustomMessages.map((message) => message.customType);
	}

	function expectEndedOnce(harness: Harness): void {
		const types = eventTypes(harness);
		expect(types.filter((type) => type === "agent_start")).toHaveLength(1);
		expect(types.filter((type) => type === "turn_end")).toHaveLength(1);
		expect(types.filter((type) => type === "agent_end")).toHaveLength(1);
		expect(types.at(-1)).toBe("agent_settled");
		expect(assistantErrors(harness)).toHaveLength(1);
		expect(harness.session.isStreaming).toBe(false);
	}

	it("ends the run with turn_end and agent_end, reports the error once and resolves", async () => {
		const { harness, file, sessionManager } = await setup();
		const before = readFileSync(file, "utf8");

		await expect(harness.session.prompt("dos")).resolves.toBeUndefined();

		expect(sessionManager.getPersistenceError()?.code).toBe("EACCES");
		expectEndedOnce(harness);
		expect(assistantErrors(harness)[0]).toBe(sessionManager.getPersistenceError()?.message);
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("a later prompt is refused with the same text, before any run starts", async () => {
		const { harness } = await setup();
		await harness.session.prompt("dos");
		harness.events.length = 0;

		await expect(harness.session.prompt("tres")).rejects.toThrow(/^Session file write failed \(EACCES\)/);
		expect(eventTypes(harness)).not.toContain("agent_start");
	});

	it("reports the start message's journal outcome through onStartMessagePersistence (not persisted)", async () => {
		const { harness } = await setup();
		const receipts: Receipt[] = [];
		const starts: AgentMessage[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") starts.push(event.message);
		});

		await harness.session.prompt("dos", { onStartMessagePersistence: (receipt) => receipts.push(receipt) });

		expect(receipts).toEqual([{ message: starts[0], persisted: false }]);
	});

	it("onStartMessagePersistence reports true for a persisted start, and is not called for handled input", async () => {
		const { harness } = await setup({
			readOnly: false,
			extensionFactories: [
				(pi) => pi.on("input", (event) => (event.text === "handled" ? { action: "handled" } : undefined)),
			],
		});
		const receipts: Receipt[] = [];
		const dispositions: string[] = [];
		const options = {
			onStartMessagePersistence: (receipt: Receipt) => receipts.push(receipt),
			preflightResult: (disposition: string) => dispositions.push(disposition),
		};

		await harness.session.prompt("handled", options);
		await harness.session.prompt("dos", options);

		expect(dispositions).toEqual(["handled", "started"]);
		expect(receipts.map((receipt) => receipt.persisted)).toEqual([true]);
	});

	it("onStartMessagePersistence of a prompt deferred from agent_settled is called when its later run ends", async () => {
		const { harness } = await setup({ readOnly: false });
		const order: string[] = [];
		let deferred: Promise<void> | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "agent_settled") return;
			unsubscribe();
			deferred = harness.session
				.prompt("tres", { onStartMessagePersistence: (outcome) => order.push(`outcome:${outcome.persisted}`) })
				.then(() => {
					order.push("resolved");
				});
		});

		await harness.session.prompt("dos");
		await deferred;
		await harness.session.waitForIdle();

		expect(order).toEqual(["resolved", "outcome:true"]);
	});

	it("onStartMessagePersistence reports false when the first atomic file creation fails once (not sticky)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-persistence-atomic-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		const harness = await createHarness({ sessionManager });
		cleanups.push(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("never")]);
		vi.spyOn(sessionManager as unknown as { _writeWholeFile: () => void }, "_writeWholeFile").mockImplementationOnce(
			() => {
				throw Object.assign(new Error("temporary create failure"), { code: "EIO" });
			},
		);
		const receipts: Receipt[] = [];

		await harness.session.prompt("never persisted", {
			onStartMessagePersistence: (receipt) => receipts.push(receipt),
		});

		expect(sessionManager.getPersistenceError()).toBeUndefined();
		expect(receipts.map((receipt) => receipt.persisted)).toEqual([false]);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("does not continue into queued input once the session cannot write; the queue is kept", async () => {
		const { harness } = await setup();
		await harness.session.followUp("queued");

		await harness.session.prompt("dos");

		expectEndedOnce(harness);
		expect(harness.session.getFollowUpMessages()).toEqual(["queued"]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("turn_end handlers are not called for the unpersisted failure, and no boundary error is reported", async () => {
		const turnEnds: unknown[] = [];
		const agentEnds: unknown[] = [];
		const { harness, errors } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						turnEnds.push(event);
					});
					pi.on("agent_end", (event) => {
						agentEnds.push(event);
					});
				},
			],
		});
		turnEnds.length = 0;
		agentEnds.length = 0;

		await harness.session.prompt("dos");

		expect(errors).toEqual([]);
		expect(turnEnds).toHaveLength(0);
		expect(agentEnds).toHaveLength(1);
		expectEndedOnce(harness);
	});

	it("a wrapped persistence failure (standing delivery) still ends the run once and resolves", async () => {
		const { harness, file, sessionManager } = await setup({ readOnly: false });
		harness.session.setStandingInstruction("mode", "new mode", { apply: "next-request" });
		const append = sessionManager.appendMessage.bind(sessionManager);
		vi.spyOn(sessionManager, "appendMessage").mockImplementation((message, ...rest) => {
			const id = append(message, ...rest);
			if (message.role === "user") chmodSync(file, 0o444);
			return id;
		});

		await expect(harness.session.prompt("dos")).resolves.toBeUndefined();

		expect(sessionManager.getPersistenceError()).toBeDefined();
		expect(assistantErrors(harness)[0]).toMatch(/^Standing instruction "mode" could not be delivered: Session file/);
		expectEndedOnce(harness);
	});

	it("a message_end replacement of the error text does not bring back the lost agent_end", async () => {
		const { harness } = await setup({
			extensionFactories: [
				(pi) =>
					pi.on("message_end", (event) =>
						event.message.role === "assistant" && event.message.errorMessage
							? { message: { ...event.message, errorMessage: `prefix: ${event.message.errorMessage}` } }
							: undefined,
					),
			],
		});

		await expect(harness.session.prompt("dos")).resolves.toBeUndefined();
		expectEndedOnce(harness);
	});

	it("a pending passive custom message does not stop agent_end", async () => {
		const { harness } = await setup();
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") {
				void harness.session.sendCustomMessage(
					{ customType: "probe", content: "pending", display: false },
					{ triggerTurn: false },
				);
			}
		});

		await expect(harness.session.prompt("dos")).resolves.toBeUndefined();
		expectEndedOnce(harness);
	});

	it.each(["bash", "custom"] as const)(
		"a first write failure in the final %s drain still settles the run, keeps the item and reports it",
		async (kind) => {
			const { harness, file, sessionManager, errors } = await setup({ readOnly: false });
			harness.session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				// Recorded while the run is still active, so it waits for the run-end drain.
				if (kind === "bash") {
					harness.session.recordBashResult("printf done", {
						output: "done",
						exitCode: 0,
						cancelled: false,
						truncated: false,
					});
				} else {
					void harness.session.sendCustomMessage(
						{ customType: "late", content: "late", display: false },
						{ triggerTurn: false },
					);
				}
				chmodSync(file, 0o444);
			});
			const receipts: Receipt[] = [];

			await expect(
				harness.session.prompt("dos", { onStartMessagePersistence: (receipt) => receipts.push(receipt) }),
			).resolves.toBeUndefined();

			const types = eventTypes(harness);
			expect(types.filter((type) => type === "agent_end")).toHaveLength(1);
			expect(types.at(-1)).toBe("agent_settled");
			expect(harness.session.isStreaming).toBe(false);
			expect(sessionManager.getPersistenceError()?.code).toBe("EACCES");
			expect(receipts.map((receipt) => receipt.persisted)).toEqual([true]);
			if (kind === "bash") expect(harness.session.hasPendingBashMessages).toBe(true);
			else expect(pendingCustomTypes(harness)).toEqual(["late"]);
			expect(errors).toEqual([
				expect.objectContaining({
					extensionPath: "<runtime>",
					event: "session_persistence",
					error: sessionManager.getPersistenceError()?.message,
				}),
			]);
			await expect(harness.session.prompt("tres")).rejects.toThrow(/^Session file write failed \(EACCES\)/);
		},
	);

	it.each([
		{ failing: "first", written: [], kept: ["one", "two"] },
		{ failing: "second", written: ["one"], kept: ["two"] },
	])(
		"a failure on the $failing buffered custom message keeps it and the rest, without replays",
		async ({ failing, written, kept }) => {
			const { harness, file, sessionManager } = await setup({ readOnly: false });
			harness.session.subscribe((event) => {
				if (event.type === "message_start" && event.message.role === "user") {
					for (const customType of ["one", "two"]) {
						void harness.session.sendCustomMessage(
							{ customType, content: customType, display: false },
							{ triggerTurn: false },
						);
					}
				}
				// The turn_end drain runs after listeners: fail its first append.
				if (failing === "first" && event.type === "turn_end") chmodSync(file, 0o444);
			});
			if (failing === "second") {
				const append = sessionManager.appendCustomMessageEntry.bind(sessionManager);
				vi.spyOn(sessionManager, "appendCustomMessageEntry").mockImplementation((...args) => {
					const id = append(...args);
					chmodSync(file, 0o444);
					return id;
				});
			}

			await expect(harness.session.prompt("dos")).resolves.toBeUndefined();

			expect(sessionManager.getPersistenceError()?.code).toBe("EACCES");
			expect(eventTypes(harness).at(-1)).toBe("agent_settled");
			expect(pendingCustomTypes(harness)).toEqual(kept);
			const journal = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type: string; customType?: string });
			expect(journal.filter((entry) => entry.type === "custom_message").map((entry) => entry.customType)).toEqual(
				written,
			);
		},
	);

	it("a failure on a later buffered bash result keeps it without replaying the written one", async () => {
		const { harness, file, sessionManager } = await setup({ readOnly: false });
		harness.session.subscribe((event) => {
			if (event.type !== "agent_end") return;
			for (const command of ["echo one", "echo two"]) {
				harness.session.recordBashResult(command, { output: "", exitCode: 0, cancelled: false, truncated: false });
			}
		});
		const append = sessionManager.appendMessage.bind(sessionManager);
		vi.spyOn(sessionManager, "appendMessage").mockImplementation((message, ...rest) => {
			const id = append(message, ...rest);
			if (message.role === "bashExecution") chmodSync(file, 0o444);
			return id;
		});

		await expect(harness.session.prompt("dos")).resolves.toBeUndefined();

		expect(eventTypes(harness).at(-1)).toBe("agent_settled");
		const pending = (harness.session as unknown as { _pendingBashMessages: Array<{ command: string }> })
			._pendingBashMessages;
		expect(pending.map((message) => message.command)).toEqual(["echo two"]);
		const commands = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { message?: { role: string; command?: string } })
			.flatMap((entry) => (entry.message?.role === "bashExecution" ? [entry.message.command] : []));
		expect(commands).toEqual(["echo one"]);
	});

	it("agent_end does not advertise a retry once the session cannot write", async () => {
		const { harness } = await setup({
			extensionFactories: [
				(pi) =>
					pi.on("message_end", (event) =>
						event.message.role === "assistant" && event.message.errorMessage
							? { message: { ...event.message, errorMessage: `429 overloaded: ${event.message.errorMessage}` } }
							: undefined,
					),
			],
		});

		await harness.session.prompt("dos");

		const end = harness.events.find((event) => event.type === "agent_end");
		expect(end?.type === "agent_end" && end.willRetry).toBe(false);
		expectEndedOnce(harness);
	});

	it.each(["text", "json"] as const)("print mode (%s) exits 1 after the write failure", async (mode) => {
		const { harness } = await setup();
		const host = { session: harness.session, setRebindSession() {}, dispose: async () => {} };
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stdout, "write").mockImplementation((_chunk: unknown, ...rest: unknown[]) => {
			const callback = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
			callback?.();
			return true;
		});

		const code = await runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], {
			mode,
			initialMessage: "dos",
		});

		expect(code).toBe(1);
	});
});
