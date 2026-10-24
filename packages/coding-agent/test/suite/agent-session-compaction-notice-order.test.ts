import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Context,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

/**
 * Passive messages that `session_compact` handlers send while a run is active (pi-handoff's
 * post-compaction snapshot) are written at the next request boundary, so the order a request sends
 * equals the journal order and the next request keeps it as an unchanged prefix (F2).
 */

const NOTICE = "handoff-notice";

/**
 * Mimics pi-handoff: `session_compact` sends a passive snapshot notice, and the `context` hook projects
 * it into requests until the persisted copy appears in the context.
 */
function handoffLike(pi: ExtensionAPI): void {
	let pending: { id: string; timestamp: number } | undefined;
	let count = 0;
	const notice = (id: string) => ({
		customType: NOTICE,
		content: `SNAPSHOT ${id}`,
		display: false,
		details: { snapshotId: id },
	});
	pi.on("session_compact", () => {
		const id = `snap-${++count}`;
		pending = { id, timestamp: Date.now() };
		pi.sendMessage(notice(id), { triggerTurn: false });
	});
	pi.on("context", (event) => {
		const snapshot = pending;
		if (!snapshot) return;
		const persisted = event.messages.some(
			(message) =>
				message.role === "custom" &&
				(message.details as { snapshotId?: string } | undefined)?.snapshotId === snapshot.id,
		);
		if (persisted) {
			pending = undefined;
			return;
		}
		return {
			messages: [
				...event.messages,
				{ role: "custom" as const, ...notice(snapshot.id), timestamp: snapshot.timestamp },
			],
		};
	});
}

/** Compaction supplied by the extension; further automatic compactions are disabled. */
function compactOnce(harnessRef: { current?: Harness }, onCompact?: () => unknown) {
	return (pi: ExtensionAPI) => {
		pi.on("session_before_compact", async (event) => {
			await onCompact?.();
			harnessRef.current?.session.setAutoCompactionEnabled(false);
			return {
				compaction: {
					summary: "SUMMARY",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		});
	};
}

function label(message: Message | AgentMessage): string {
	const text = getMessageText(message);
	return `${message.role}:${text.slice(0, 24)}`;
}

function labels(messages: Array<Message | AgentMessage>): string[] {
	return messages.filter((message) => message.role !== "system" && message.role !== "developer").map(label);
}

function journalLabels(harness: Harness): string[] {
	return labels(convertToLlm(harness.sessionManager.buildSessionProjection().messages));
}

function noticeEvents(harness: Harness): number {
	return harness.events.filter(
		(event) => event.type === "message_end" && event.message.role === "custom" && event.message.customType === NOTICE,
	).length;
}

function noticeEntries(harness: Harness): number {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === NOTICE).length;
}

/** Complete provider messages of a request and the journal projection at the same instant, as JSON. */
interface RecordedRequest {
	request: string[];
	journal: string[];
}

const recorded = new WeakMap<string[], RecordedRequest>();

function messageJson(messages: Array<Message | AgentMessage>): string[] {
	return messages.map((message) => JSON.stringify(message));
}

/**
 * Each request's messages, recorded at the provider: readable labels (diagnostics) plus the complete
 * messages, system/developer and tool ids included, and the journal projection when it was sent.
 */
function recorder(harness: Harness) {
	const requests: string[][] = [];
	const answer =
		(text: string): FauxResponseStep =>
		(context: Context) => {
			const requestLabels = labels(context.messages);
			recorded.set(requestLabels, {
				request: messageJson(context.messages),
				journal: messageJson(convertToLlm(harness.sessionManager.buildSessionProjection().messages)),
			});
			requests.push(requestLabels);
			return fauxAssistantMessage(text);
		};
	return { requests, answer };
}

function complete(requestLabels: string[]): RecordedRequest {
	const entry = recorded.get(requestLabels);
	if (!entry) throw new Error("request was not recorded");
	return entry;
}

/** Both requests sent exactly the journal, and the later one repeats the earlier one unchanged. */
function expectPrefix(earlier: string[], later: string[]): void {
	expect(later.slice(0, earlier.length)).toEqual(earlier);
	const first = complete(earlier);
	const second = complete(later);
	expect(first.request).toEqual(first.journal);
	expect(second.request).toEqual(second.journal);
	expect(second.request.slice(0, first.request.length)).toEqual(first.request);
}

/** The final journal starts with the complete messages of `last`. */
function expectJournalExtends(harness: Harness, last: string[]): void {
	const journal = messageJson(convertToLlm(harness.sessionManager.buildSessionProjection().messages));
	expect(journal.slice(0, complete(last).request.length)).toEqual(complete(last).request);
}

const largeTool: AgentTool = {
	name: "large_result",
	label: "Large result",
	description: "Returns enough content to cross the compaction threshold",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: `TOOL-RESULT ${"x".repeat(8000)}` }], details: {} }),
};

describe("AgentSession: passive messages from session_compact keep request order = journal order", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function setup(options: HarnessOptions, onCompact?: (harness: Harness) => unknown) {
		const ref: { current?: Harness } = {};
		const harness = await createHarness({
			...options,
			extensionFactories: [
				handoffLike,
				compactOnce(ref, () => onCompact?.(ref.current!)),
				...(options.extensionFactories ?? []),
			],
		});
		ref.current = harness;
		cleanups.push(() => harness.cleanup());
		await harness.session.bindExtensions({});
		return harness;
	}

	it("post-run threshold compaction with a queued follow-up: the snapshot follows the follow-up in both", async () => {
		const harness = await setup(
			{
				models: [{ id: "faux-1", contextWindow: 4000 }],
				settings: { compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 10 } },
				extensionFactories: [
					(pi) => {
						// An ordinary deferred passive message (not from session_compact) keeps the turn boundary.
						let sent = false;
						pi.on("agent_end", (event) => {
							const first = event.messages.some((message) => getMessageText(message) === "FIRST-ANSWER");
							if (sent || !first) return;
							sent = true;
							pi.sendMessage({ customType: "late", content: "LATE", display: false }, { triggerTurn: false });
						});
					},
				],
			},
			(harness) => harness.session.followUp("FOLLOW-UP"),
		);
		const { requests, answer } = recorder(harness);
		harness.setResponses([
			fauxAssistantMessage("SEED-ANSWER"),
			answer("FIRST-ANSWER"),
			answer("FOLLOW-UP-ANSWER"),
			answer("FINAL-ANSWER"),
		]);
		await harness.session.prompt("SEED");

		await harness.session.prompt(`FIRST-PROMPT ${"x".repeat(12000)}`);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		await harness.session.prompt("FINAL-PROMPT");

		expect(requests).toHaveLength(3);
		const [, second, third] = requests;
		// The first post-compaction request carries the fresh snapshot, right after the follow-up.
		expect(second.slice(-2)).toEqual(["user:FOLLOW-UP", "user:SNAPSHOT snap-1"]);
		expectPrefix(second, third);
		expect(third.slice(second.length)).toEqual(["assistant:FOLLOW-UP-ANSWER", "user:LATE", "user:FINAL-PROMPT"]);
		expect(journalLabels(harness)).toEqual([...third, "assistant:FINAL-ANSWER"]);
		expectJournalExtends(harness, third);
		expect(noticeEvents(harness)).toBe(1);
		expect(noticeEntries(harness)).toBe(1);
	});

	it("mid-run threshold compaction after a tool result: the snapshot follows the tool result in both", async () => {
		const harness = await setup({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [largeTool],
		});
		const { requests, answer } = recorder(harness);
		harness.setResponses([
			fauxAssistantMessage(`OLD ${"a".repeat(800)}`),
			fauxAssistantMessage(`RECENT ${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			answer("RESUMED-ANSWER"),
			answer("FINAL-ANSWER"),
		]);

		await harness.session.prompt("seed old");
		await harness.session.prompt("seed recent");
		await harness.session.prompt("run the large tool");
		expect(harness.eventsOfType("compaction_end").map((event) => event.reason)).toEqual(["threshold"]);
		await harness.session.prompt("FINAL-PROMPT");

		const [resumed, final] = requests;
		expect(resumed.slice(-2)).toEqual(["toolResult:TOOL-RESULT xxxxxxxxxxxx", "user:SNAPSHOT snap-1"]);
		expectPrefix(resumed, final);
		expect(final.slice(resumed.length)).toEqual(["assistant:RESUMED-ANSWER", "user:FINAL-PROMPT"]);
		expect(journalLabels(harness)).toEqual([...final, "assistant:FINAL-ANSWER"]);
		expectJournalExtends(harness, final);
		expect(noticeEvents(harness)).toBe(1);
		expect(noticeEntries(harness)).toBe(1);
	});

	it("pre-run compaction of a triggered custom run: the snapshot follows the trigger in both", async () => {
		const harness = await setup({
			models: [{ id: "faux-1", contextWindow: 4000 }],
			settings: { compaction: { enabled: false, reserveTokens: 2000, keepRecentTokens: 10 } },
		});
		const { requests, answer } = recorder(harness);
		harness.setResponses([
			fauxAssistantMessage("SEED-ANSWER"),
			answer("FIRST-ANSWER"),
			answer("TRIGGER-ANSWER"),
			answer("FINAL-ANSWER"),
		]);
		await harness.session.prompt("SEED");
		await harness.session.prompt(`FIRST-PROMPT ${"x".repeat(12000)}`);
		harness.session.setAutoCompactionEnabled(true);

		await harness.session.sendCustomMessage(
			{ customType: "trigger", content: "TRIGGER", display: false },
			{ triggerTurn: true },
		);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		await harness.session.prompt("FINAL-PROMPT");

		const [, triggered, final] = requests;
		expect(triggered.slice(-2)).toEqual(["user:TRIGGER", "user:SNAPSHOT snap-1"]);
		expectPrefix(triggered, final);
		expect(journalLabels(harness)).toEqual([...final, "assistant:FINAL-ANSWER"]);
		expectJournalExtends(harness, final);
		expect(noticeEvents(harness)).toBe(1);
	});

	it("post-run threshold compaction without queued input still writes the snapshot at run end", async () => {
		const harness = await setup({
			models: [{ id: "faux-1", contextWindow: 4000 }],
			settings: { compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 10 } },
		});
		const { requests, answer } = recorder(harness);
		harness.setResponses([fauxAssistantMessage("SEED-ANSWER"), answer("FIRST-ANSWER"), answer("FINAL-ANSWER")]);
		await harness.session.prompt("SEED");

		await harness.session.prompt(`FIRST-PROMPT ${"x".repeat(12000)}`);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(journalLabels(harness).at(-1)).toBe("user:SNAPSHOT snap-1");
		await harness.session.prompt("FINAL-PROMPT");

		expect(requests[1].slice(-2)).toEqual(["user:SNAPSHOT snap-1", "user:FINAL-PROMPT"]);
		expect(complete(requests[1]).request).toEqual(complete(requests[1]).journal);
		expect(noticeEvents(harness)).toBe(1);
	});

	it("virtual routing that compacts inside prepareRequest: the snapshot follows the prompt in both", async () => {
		const harness = await setup({
			models: [
				{ id: "small", contextWindow: 1000 },
				{ id: "large", contextWindow: 50_000, maxTokens: 4000, reasoning: true },
			],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						thinkingLevels: ["low", "high"],
						contextWindow: 1000,
						route: (request, ctx) =>
							request.thinkingLevel === "high"
								? { model: ctx.modelRegistry.find("faux", "large")!, thinkingLevel: "high" }
								: { model: ctx.modelRegistry.find("faux", "small")!, thinkingLevel: "off" },
					});
				},
			],
		});
		const runtime = harness.session.modelRuntime;
		harness.session.agent.streamFunction = (model, context, options) => runtime.streamSimple(model, context, options);
		await harness.session.setModel(runtime.getModel("router", "auto")!);
		harness.session.setThinkingLevel("high");
		const { requests, answer } = recorder(harness);
		harness.setResponses([fauxAssistantMessage("y".repeat(8000)), answer("SMALL-ANSWER"), answer("FINAL-ANSWER")]);
		await harness.session.prompt("hello");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);

		// About 2k tokens fit the large model that answered last, but not the small model's 1k window.
		harness.session.setThinkingLevel("low");
		await harness.session.prompt("NEXT-PROMPT");
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		await harness.session.prompt("FINAL-PROMPT");

		const [small, final] = requests;
		expect(small.slice(-2)).toEqual(["user:NEXT-PROMPT", "user:SNAPSHOT snap-1"]);
		expectPrefix(small, final);
		expect(journalLabels(harness)).toEqual([...final, "assistant:FINAL-ANSWER"]);
		expectJournalExtends(harness, final);
		expect(noticeEvents(harness)).toBe(1);
	});

	/** A file-backed session whose snapshot observer makes the next append fail and swallows the error. */
	async function setupObserverFailure(options: HarnessOptions, onCompact?: (harness: Harness) => unknown) {
		const dir = mkdtempSync(join(tmpdir(), "pi-compaction-notice-"));
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		let file = "";
		cleanups.push(() => {
			if (file) chmodSync(file, 0o644);
			rmSync(dir, { recursive: true, force: true });
		});
		const harness = await setup({ ...options, sessionManager }, onCompact);
		harness.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "custom" || event.message.customType !== NOTICE) {
				return;
			}
			file = sessionManager.getSessionFile()!;
			chmodSync(file, 0o444);
			// An SDK observer persists a delivery receipt; it catches its own failure.
			try {
				sessionManager.appendCustomEntry("notice-delivery-receipt", {});
			} catch {}
		});
		const refusedAtProvider: boolean[] = [];
		const answer =
			(text: string): FauxResponseStep =>
			() => {
				refusedAtProvider.push(sessionManager.getPersistenceError() !== undefined);
				return fauxAssistantMessage(text);
			};
		return { harness, sessionManager, refusedAtProvider, answer };
	}

	it.skipIf(process.getuid?.() === 0)(
		"virtual routing: no request leaves after a snapshot observer hit a sticky write failure",
		async () => {
			const { harness, sessionManager, refusedAtProvider, answer } = await setupObserverFailure({
				models: [
					{ id: "small", contextWindow: 1000 },
					{ id: "large", contextWindow: 50_000, maxTokens: 4000, reasoning: true },
				],
				settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
				extensionFactories: [
					(pi) => {
						pi.registerVirtualModel({
							provider: "router",
							id: "auto",
							name: "Auto",
							thinkingLevels: ["low", "high"],
							contextWindow: 1000,
							route: (request, ctx) =>
								request.thinkingLevel === "high"
									? { model: ctx.modelRegistry.find("faux", "large")!, thinkingLevel: "high" }
									: { model: ctx.modelRegistry.find("faux", "small")!, thinkingLevel: "off" },
						});
					},
				],
			});
			const runtime = harness.session.modelRuntime;
			harness.session.agent.streamFunction = (model, context, options) =>
				runtime.streamSimple(model, context, options);
			await harness.session.setModel(runtime.getModel("router", "auto")!);
			harness.session.setThinkingLevel("high");
			harness.setResponses([fauxAssistantMessage("y".repeat(8000)), answer("UNEXPECTED")]);
			await harness.session.prompt("hello");
			harness.session.setThinkingLevel("low");
			harness.events.length = 0;

			await expect(harness.session.prompt("NEXT-PROMPT")).resolves.toBeUndefined();

			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			expect(sessionManager.getPersistenceError()?.code).toBe("EACCES");
			expect(refusedAtProvider).toEqual([]);
			expect(noticeEvents(harness)).toBe(1);
			const types = harness.events.map((event) => event.type);
			expect(types.filter((type) => type === "agent_settled")).toEqual(["agent_settled"]);
			expect(harness.session.isStreaming).toBe(false);
		},
	);

	it.skipIf(process.getuid?.() === 0)(
		"queued follow-up: no request leaves after a snapshot observer hit a sticky write failure",
		async () => {
			const { harness, sessionManager, refusedAtProvider, answer } = await setupObserverFailure(
				{
					models: [{ id: "faux-1", contextWindow: 4000 }],
					settings: { compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 10 } },
				},
				(harness) => harness.session.followUp("FOLLOW-UP"),
			);
			harness.setResponses([
				fauxAssistantMessage("SEED-ANSWER"),
				fauxAssistantMessage("FIRST-ANSWER"),
				answer("UNEXPECTED"),
			]);
			await harness.session.prompt("SEED");
			harness.events.length = 0;

			await expect(harness.session.prompt(`FIRST-PROMPT ${"x".repeat(12000)}`)).resolves.toBeUndefined();

			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			expect(sessionManager.getPersistenceError()?.code).toBe("EACCES");
			expect(refusedAtProvider).toEqual([]);
			expect(noticeEvents(harness)).toBe(1);
			const types = harness.events.map((event) => event.type);
			expect(types.filter((type) => type === "agent_settled")).toEqual(["agent_settled"]);
			expect(harness.session.isStreaming).toBe(false);
		},
	);

	it.skipIf(process.getuid?.() === 0)(
		"a failed write of the snapshot at the request boundary refuses the request and keeps it buffered",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "pi-compaction-notice-"));
			const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
			let file = "";
			cleanups.push(() => {
				if (file) chmodSync(file, 0o644);
				rmSync(dir, { recursive: true, force: true });
			});
			const harness = await setup(
				{
					models: [{ id: "faux-1", contextWindow: 4000 }],
					settings: { compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 10 } },
					sessionManager,
				},
				(harness) => harness.session.followUp("FOLLOW-UP"),
			);
			file = sessionManager.getSessionFile()!;
			const append = sessionManager.appendMessage.bind(sessionManager);
			vi.spyOn(sessionManager, "appendMessage").mockImplementation((message, ...rest) => {
				const id = append(message, ...rest);
				// The follow-up is written; the next write (the snapshot) fails.
				if (message.role === "user" && getMessageText(message) === "FOLLOW-UP") chmodSync(file, 0o444);
				return id;
			});
			const { requests, answer } = recorder(harness);
			harness.setResponses([fauxAssistantMessage("SEED-ANSWER"), answer("FIRST-ANSWER"), answer("UNEXPECTED")]);
			await harness.session.prompt("SEED");
			harness.events.length = 0;

			await expect(harness.session.prompt(`FIRST-PROMPT ${"x".repeat(12000)}`)).resolves.toBeUndefined();

			expect(sessionManager.getPersistenceError()?.code).toBe("EACCES");
			expect(requests).toHaveLength(1);
			const pending = (harness.session as unknown as { _pendingCustomMessages: Array<{ customType: string }> })
				._pendingCustomMessages;
			expect(pending.map((message) => message.customType)).toEqual([NOTICE]);
			expect(noticeEvents(harness)).toBe(0);
			expect(noticeEntries(harness)).toBe(0);
			const types = harness.events.map((event) => event.type);
			expect(types.at(-1)).toBe("agent_settled");
			expect(types.filter((type) => type === "agent_settled")).toHaveLength(1);
			expect(harness.session.isStreaming).toBe(false);
		},
	);
});
