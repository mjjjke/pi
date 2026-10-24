import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionError } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

// chmod does not stop root from writing.
const runsAsRoot = process.getuid?.() === 0;

type Receipt = { message: AgentMessage; persisted: boolean };

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

	it("reports the start message's journal outcome through startPersisted (not persisted)", async () => {
		const { harness } = await setup();
		const receipts: Receipt[] = [];
		const starts: AgentMessage[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") starts.push(event.message);
		});

		await harness.session.prompt("dos", { startPersisted: (receipt) => receipts.push(receipt) });

		expect(receipts).toEqual([{ message: starts[0], persisted: false }]);
	});

	it("startPersisted reports true for a persisted start, and is not called for handled input", async () => {
		const { harness } = await setup({
			readOnly: false,
			extensionFactories: [
				(pi) => pi.on("input", (event) => (event.text === "handled" ? { action: "handled" } : undefined)),
			],
		});
		const receipts: Receipt[] = [];
		const dispositions: string[] = [];
		const options = {
			startPersisted: (receipt: Receipt) => receipts.push(receipt),
			preflightResult: (disposition: string) => dispositions.push(disposition),
		};

		await harness.session.prompt("handled", options);
		await harness.session.prompt("dos", options);

		expect(dispositions).toEqual(["handled", "started"]);
		expect(receipts.map((receipt) => receipt.persisted)).toEqual([true]);
	});

	it("startPersisted reports false when the first atomic file creation fails once (not sticky)", async () => {
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

		await harness.session.prompt("never persisted", { startPersisted: (receipt) => receipts.push(receipt) });

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
