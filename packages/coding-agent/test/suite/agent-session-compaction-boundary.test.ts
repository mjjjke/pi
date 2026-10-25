import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Context, type FauxResponseStep, fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { COMPACTION_BOUNDARY_TEXT_V2, convertToLlm } from "../../src/core/messages.ts";
import type { CompactionEntry } from "../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

/**
 * Compaction boundary lifecycle (A4): the boundary follows the kept range in every request after a
 * marked compaction; it is not input (no turn, no input events, no next-input delivery, no extra run).
 */

const BOUNDARY_LABEL = "user:Compaction boundary (not";

function label(message: Message | AgentMessage): string {
	return `${message.role}:${getMessageText(message).slice(0, 24)}`;
}

function labels(messages: Array<Message | AgentMessage>): string[] {
	return messages.filter((message) => message.role !== "system" && message.role !== "developer").map(label);
}

function recorder() {
	const requests: string[][] = [];
	const full: Message[][] = [];
	const answer =
		(text: string): FauxResponseStep =>
		(context: Context) => {
			requests.push(labels(context.messages));
			full.push(structuredClone(context.messages));
			return fauxAssistantMessage(text);
		};
	return { requests, full, answer };
}

function summarize(pi: ExtensionAPI): void {
	pi.on("session_before_compact", (event) => ({
		compaction: {
			summary: "SUMMARY",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
		},
	}));
}

function boundaries(messages: Array<Message | AgentMessage>): number {
	return messages.filter((message) => getMessageText(message) === COMPACTION_BOUNDARY_TEXT_V2).length;
}

describe("AgentSession: compaction boundary lifecycle (A4)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function setup(options: HarnessOptions = {}): Promise<Harness> {
		const harness = await createHarness({
			...options,
			extensionFactories: [summarize, ...(options.extensionFactories ?? [])],
		});
		cleanups.push(() => harness.cleanup());
		await harness.session.bindExtensions({});
		return harness;
	}

	it("manual /compact: the next request has [summary, kept…, boundary, prompt]; the boundary is not input", async () => {
		const inputs: string[] = [];
		const harness = await setup({
			settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 10 } },
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputs.push(event.text);
					});
				},
			],
		});
		const { requests, answer } = recorder();
		harness.setResponses([fauxAssistantMessage("OLD-ANSWER"), fauxAssistantMessage("KEPT-ANSWER"), answer("NEW")]);
		await harness.session.prompt(`OLD ${"o".repeat(400)}`);
		await harness.session.prompt(`KEPT ${"k".repeat(100)}`);
		const messageStartsBefore = harness.eventsOfType("message_start").length;
		const turnStartsBefore = harness.eventsOfType("turn_start").length;
		const agentStartsBefore = harness.eventsOfType("agent_start").length;
		await harness.session.compact();
		// Compaction itself starts no run and emits no message events.
		expect(harness.eventsOfType("agent_start")).toHaveLength(agentStartsBefore);
		expect(harness.eventsOfType("turn_start")).toHaveLength(turnStartsBefore);
		expect(harness.eventsOfType("message_start")).toHaveLength(messageStartsBefore);
		await harness.session.prompt("NEW-PROMPT");

		expect(requests).toHaveLength(1);
		expect(requests[0]).toEqual([
			"user:The conversation history",
			"user:KEPT kkkkkkkkkkkkkkkkkkk",
			"assistant:KEPT-ANSWER",
			BOUNDARY_LABEL,
			"user:NEW-PROMPT",
		]);
		expect(inputs.map((text) => text.slice(0, 4))).toEqual(["OLD ", "KEPT", "NEW-"]);
		const boundaryEvents = harness.events.filter(
			(event) =>
				(event.type === "message_start" || event.type === "message_end") &&
				event.message.role === "compactionBoundary",
		);
		expect(boundaryEvents).toEqual([]);
		// Projection-only: the boundary is no entry of its own.
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(JSON.stringify(harness.sessionManager.getBranch())).not.toContain('"compactionBoundary"');
	});

	it("pre-run compaction of a user prompt and of a custom trigger: boundary before the starting message", async () => {
		for (const trigger of ["user", "custom"] as const) {
			const harness = await setup({
				models: [{ id: "faux-1", contextWindow: 4000 }],
				settings: { compaction: { enabled: false, reserveTokens: 2000, keepRecentTokens: 10 } },
			});
			const { requests, answer } = recorder();
			harness.setResponses([
				fauxAssistantMessage("SEED-ANSWER"),
				fauxAssistantMessage("BIG-ANSWER"),
				answer("NEXT"),
			]);
			await harness.session.prompt("SEED");
			await harness.session.prompt(`BIG ${"x".repeat(12000)}`);
			harness.session.setAutoCompactionEnabled(true);
			if (trigger === "user") await harness.session.prompt("START");
			else {
				await harness.session.sendCustomMessage(
					{ customType: "trigger", content: "START", display: false },
					{ triggerTurn: true },
				);
			}
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			expect(requests).toHaveLength(1);
			expect(requests[0].slice(-2)).toEqual([BOUNDARY_LABEL, "user:START"]);
			expect(boundaries(requests[0].length > 0 ? convertToLlm(harness.session.messages) : [])).toBe(1);
		}
	});

	it("post-run threshold compaction without queued input sends no further request", async () => {
		const harness = await setup({
			models: [{ id: "faux-1", contextWindow: 20000 }],
			settings: { compaction: { enabled: true, reserveTokens: 18000, keepRecentTokens: 10 } },
		});
		harness.setResponses([fauxAssistantMessage("SEED-ANSWER"), fauxAssistantMessage("BIG-ANSWER")]);
		await harness.session.prompt("SEED");
		const agentStarts = harness.eventsOfType("agent_start").length;
		await harness.session.prompt(`BIG ${"x".repeat(12000)}`);
		expect(harness.eventsOfType("compaction_end").map((event) => event.reason)).toEqual(["threshold"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("agent_start")).toHaveLength(agentStarts + 1);
		expect(harness.session.messages.at(-1)?.role).toBe("compactionBoundary");
		expect(harness.session.isStreaming).toBe(false);
	});

	it("overflow retry: the kept prompt precedes the boundary, one retry request, no extra input", async () => {
		const harness = await setup({
			models: [{ id: "faux-1", contextWindow: 100000 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 20 } },
		});
		const { requests, answer } = recorder();
		harness.setResponses([
			fauxAssistantMessage(`OLD-ANSWER ${"a".repeat(400)}`),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			answer("RETRIED"),
		]);
		await harness.session.prompt(`OLD ${"o".repeat(400)}`);
		const userStarts = harness.events.filter(
			(event) => event.type === "message_start" && event.message.role === "user",
		).length;
		await harness.session.prompt("OVERFLOWING-PROMPT");
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "overflow", willRetry: true });
		expect(requests).toHaveLength(1);
		expect(requests[0].slice(-2)).toEqual(["user:OVERFLOWING-PROMPT", BOUNDARY_LABEL]);
		expect(
			harness.events.filter((event) => event.type === "message_start" && event.message.role === "user"),
		).toHaveLength(userStarts + 1);
		expect(harness.session.getLastAssistantText()).toBe("RETRIED");
	});

	it("a next-input standing value set at a mid-run compaction is not delivered by the boundary", async () => {
		let set = false;
		const harness = await setup({
			models: [{ id: "faux-1", contextWindow: 100000 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_compact", () => {
						if (set) return;
						set = true;
						pi.setStandingInstruction("mode", "MASK");
					});
				},
			],
		});
		const { full, answer } = recorder();
		harness.setResponses([
			fauxAssistantMessage(`OLD-ANSWER ${"a".repeat(400)}`),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			answer("RETRIED"),
			answer("NEXT"),
		]);
		await harness.session.prompt(`OLD ${"o".repeat(400)}`);
		await harness.session.prompt("OVERFLOWING-PROMPT");
		await harness.session.prompt("NEXT-PROMPT");
		const developerTexts = (messages: Message[]) =>
			messages.filter((message) => message.role === "developer").map(getMessageText);
		// The retry has no input: the boundary does not deliver the next-input value.
		expect(developerTexts(full[0])).not.toContain("MASK");
		expect(developerTexts(full[1])).toContain("MASK");
	});

	it("getContextUsage stays unknown after the compaction until a post-compaction reply", async () => {
		const harness = await setup({
			settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 10 } },
		});
		harness.setResponses([
			fauxAssistantMessage("OLD-ANSWER"),
			fauxAssistantMessage("KEPT-ANSWER"),
			fauxAssistantMessage("NEW"),
		]);
		await harness.session.prompt(`OLD ${"o".repeat(400)}`);
		await harness.session.prompt(`KEPT ${"k".repeat(100)}`);
		await harness.session.compact();
		expect(harness.session.getContextUsage()?.tokens).toBeNull();
		await harness.session.prompt("NEW-PROMPT");
		const reply = harness.session.messages.findLast((message) => message.role === "assistant");
		const usage = harness.session.getContextUsage();
		expect(usage?.tokens).toBe(reply?.role === "assistant" ? reply.usage.totalTokens : -1);
	});

	it("an unmarked compaction (older core) projects no boundary", async () => {
		const harness = await setup({
			settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 10 } },
		});
		const { requests, answer } = recorder();
		harness.setResponses([fauxAssistantMessage("OLD-ANSWER"), fauxAssistantMessage("KEPT-ANSWER"), answer("NEW")]);
		await harness.session.prompt(`OLD ${"o".repeat(400)}`);
		await harness.session.prompt(`KEPT ${"k".repeat(100)}`);
		await harness.session.compact();
		const compaction = harness.sessionManager.getBranch().at(-1) as CompactionEntry;
		delete compaction.boundary;
		await harness.session.prompt("NEW-PROMPT");
		expect(requests[0]).toEqual([
			"user:The conversation history",
			"user:KEPT kkkkkkkkkkkkkkkkkkk",
			"assistant:KEPT-ANSWER",
			"user:NEW-PROMPT",
		]);
	});
	it("a draft compaction whose kept range ends with the reply cannot request a continuation", async () => {
		let drafted = false;
		const errors: string[] = [];
		const harness = await setup({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						if (drafted) return;
						drafted = true;
						return {
							entries: [
								...event.entries,
								{ type: "compaction", summary: "DRAFT", firstKeptEntryId: event.messageEntryId },
							],
							continue: true,
						};
					});
				},
			],
		});
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		harness.setResponses([fauxAssistantMessage("ONLY")]);
		await harness.session.prompt("START");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.messages.at(-1)?.role).toBe("compactionBoundary");
		expect(errors).toEqual(["turn_end requested continuation without runnable model context"]);
	});
});
