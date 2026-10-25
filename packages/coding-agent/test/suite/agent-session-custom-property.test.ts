import { mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { type CompactionResult, estimateProjectedContextTokens } from "../../src/core/compaction/index.ts";
import type { BoundaryContextPreview } from "../../src/core/extensions/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}

interface StoreItem {
	handle: AgentMessage;
	lane: string;
	state: string;
	riderOf?: StoreItem;
}
interface OwnershipView {
	_customStore: Map<AgentMessage, StoreItem>;
	_getPendingBoundaryMessages(): AgentMessage[];
	_buildBoundaryContext(drafts: [], boundary: "turn_end"): BoundaryContextPreview;
}
const ownership = (session: AgentSession) => session as unknown as OwnershipView;
const scenarios = [
	"live",
	"live-stop",
	"live-context",
	"live-install",
	"settled",
	"settled-stop",
	"hold-apply",
	"hold-abort",
	"hold-cancel",
	"hold-reload",
	"l3-abort",
	"l3-cancel",
	"l3-reload",
] as const;
const failures = ["none", "first", "second", "first-sticky", "second-sticky"] as const;
const cases = [7, 19, 47].flatMap((seed) =>
	(["all", "one-at-a-time"] as const).flatMap((mode) =>
		scenarios.flatMap((scenario) => failures.map((failure) => ({ seed, mode, scenario, failure }))),
	),
);

// Finite §15.12 matrix: 3 seeds × 2 batch modes × 13 lifecycle schedules × 5 append outcomes.
// nextTurn is explicitly outside O1/O2 (§4.8); its separate transfer is covered below.
describe("§15.12 finite seeded custom-store matrix", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (cleanups.length) cleanups.pop()?.();
	});

	it.each(cases)("seed=$seed $mode $scenario append=$failure", async ({ seed, mode, scenario, failure }) => {
		const summary = deferred<CompactionResult>();
		const waiting = deferred<void>();
		const ready = deferred<void>();
		const accepted: Array<{ text: string; key: string; ordered: boolean }> = [];
		const oracleErrors: unknown[] = [];
		const riders: Array<{ text: string; predecessor: string }> = [];
		const firstRequest = new Map<string, number>();
		let h!: Harness;
		let injected = false;
		let kept = "";
		let state = seed;
		const next = () => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return state;
		};
		const journal = () =>
			h.sessionManager
				.getEntries()
				.flatMap((entry) => (entry.type === "custom_message" ? [getMessageText(entry)] : []));
		const storeTexts = () =>
			[...ownership(h.session)._customStore.values()].map((item) => getMessageText(item.handle));
		const observeOwnership = () => {
			try {
				const owned = storeTexts();
				const receipted = journal();
				const staged = h.session.stagedMessages.map(getMessageText);
				for (const item of accepted) {
					expect(
						owned.filter((text) => text === item.text).length +
							receipted.filter((text) => text === item.text).length +
							staged.filter((text) => text === item.text).length,
					).toBe(1);
				}
				const pending = ownership(h.session)._getPendingBoundaryMessages().map(getMessageText);
				for (const text of owned) expect(pending.filter((item) => item === text)).toHaveLength(1);
				// Public pendingMessageCount is user-only, not a custom receipt count.
				expect(h.session.pendingMessageCount).toBe(
					h.session.getSteeringMessages().length + h.session.getFollowUpMessages().length,
				);
				if (!h.sessionManager.getPersistenceError()) {
					const preview = ownership(h.session)._buildBoundaryContext([], "turn_end");
					expect(preview.pendingMessages).toEqual(ownership(h.session)._getPendingBoundaryMessages());
					const projected = h.sessionManager.buildSessionProjection();
					expect(preview.contextMessages).toEqual(projected.messages);
					expect(preview.llmMessages).toEqual(convertToLlm(projected.messages));
				}
			} catch (error) {
				oracleErrors.push(error);
			}
		};
		const send = async (kind: "passive" | "steer" | "followUp" | "trigger" | "notice", key: number) => {
			const text = `matrix-${seed}-${accepted.length}-${kind}`;
			const customType = key === 0 ? "fallback" : "explicit";
			const orderKey = key === 0 ? undefined : key === 1 ? "task:k" : "type:fallback";
			accepted.push({
				text,
				key: orderKey === undefined ? `type:${customType}` : `key:${orderKey}`,
				ordered: kind !== "followUp" && kind !== "notice",
			});
			try {
				const delivery = h.session.sendCustomMessage(
					{ customType, content: text, display: false },
					{
						triggerTurn: kind !== "passive" && kind !== "notice",
						deliverAs: kind === "followUp" ? "followUp" : "steer",
						orderKey,
					},
				);
				const item = [...ownership(h.session)._customStore.values()].find(
					(item) => getMessageText(item.handle) === text,
				);
				if (item?.riderOf) riders.push({ text, predecessor: getMessageText(item.riderOf.handle) });
				await delivery;
			} catch (error) {
				expect(String(error)).toMatch(/matrix transient|Session file write failed/);
			}
			observeOwnership();
		};
		const inputs = async () => {
			// Every seed includes every ingress kind and all three keys. Seed changes
			// their interleaving, not whether a required dimension happens to occur.
			for (let round = 0; round < 3; round++) {
				const offset = next() % 3;
				for (let i = 0; i < 3; i++) {
					const key = (i + offset) % 3;
					await send(round === 0 ? "steer" : round === 1 ? "followUp" : "trigger", key);
					await send("passive", key);
				}
			}
		};
		const sticky = failure.endsWith("sticky");
		const dir = mkdtempSync(join(tmpdir(), "pi-custom-property-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const manager = sticky ? SessionManager.create(dir, join(dir, "sessions")) : SessionManager.inMemory();
		h = await createHarness({
			sessionManager: manager,
			models: [{ id: "matrix", contextWindow: 100000, maxTokens: 1000 }],
			settings: { compaction: { enabled: scenario.startsWith("l3"), keepRecentTokens: 10, reserveTokens: 1000 } },
			tools: [
				{
					name: "step",
					label: "step",
					description: "step",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
				},
			],
			initialActiveToolNames: ["step"],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ compaction: await summary.promise }));
					pi.on("session_background_compaction", (event) => {
						if (event.phase === "waiting") waiting.resolve();
						if (event.phase === "ready") ready.resolve();
					});
					pi.on("session_compact", async () => {
						for (let key = 0; key < 3; key++) await send("notice", key);
					});
					pi.on("session_context_change", async () => {
						for (let key = 0; key < 3; key++) await send("notice", key);
					});
					pi.on("agent_settled", async () => {
						if (injected || !scenario.startsWith("settled")) return;
						injected = true;
						await inputs();
						if (scenario === "settled-stop") await h.session.abort();
					});
					pi.on("turn_end", async (event) => {
						if (injected || !scenario.startsWith("live")) return;
						injected = true;
						await inputs();
						if (scenario === "live-stop") void h.session.abort();
						if (scenario === "live-install") {
							summary.resolve({ summary: "summary", firstKeptEntryId: kept, tokensBefore: 0 });
							await ready.promise;
						}
						if (scenario === "live-context" && !h.sessionManager.getPersistenceError())
							return {
								entries: [
									...event.entries,
									{ type: "context_edit", targetId: kept, replacement: { content: "kept edited" } },
								],
							};
					});
				},
			],
		});
		cleanups.push(h.cleanup);
		h.session.agent.steeringMode = mode;
		h.session.agent.followUpMode = mode;
		manager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
		manager.appendMessage({ role: "user", content: "old".repeat(6000), timestamp: 2 });
		manager.appendMessage({
			...fauxAssistantMessage("old", { timestamp: 3 }),
			api: h.getModel().api,
			provider: h.getModel().provider,
			model: h.getModel().id,
		});
		kept = manager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 4 });
		h.session.refreshContext();
		if (scenario.startsWith("l3")) {
			const tokens = estimateProjectedContextTokens(manager.buildSessionProjection(), manager.getBranch()).tokens;
			h.session.agent.state.model = { ...h.getModel(), contextWindow: tokens + 1000 };
		}
		const append = manager.appendCustomMessageEntry.bind(manager);
		let attempts = 0;
		const failedAt = failure.startsWith("first") ? 1 : failure.startsWith("second") ? 2 : -1;
		vi.spyOn(manager, "appendCustomMessageEntry").mockImplementation((...args) => {
			if (++attempts !== failedAt) return append(...args);
			if (!sticky) throw new Error("matrix transient append");
			// Real deterministic append failure, including under root: no permissions
			// assumptions and no synthetic persistence-error getter.
			const file = manager.getSessionFile()!;
			renameSync(file, `${file}.saved`);
			mkdirSync(file);
			try {
				return append(...args);
			} finally {
				rmdirSync(file);
				renameSync(`${file}.saved`, file);
			}
		});
		let requests = 0;
		let previous: { epoch: string; messages: ReturnType<typeof convertToLlm> } | undefined;
		h.setResponses(
			Array.from({ length: 32 }, (_, index) => (context) => {
				requests++;
				try {
					expect(context.messages).toEqual(convertToLlm(manager.buildSessionProjection().messages));
					const epoch =
						manager.getBranch().findLast((entry) => entry.type === "compaction" || entry.type === "context_edit")
							?.id ?? "original";
					if (previous?.epoch === epoch)
						expect(context.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
					previous = { epoch, messages: structuredClone(context.messages) };
					for (const item of accepted) {
						if (
							!firstRequest.has(item.text) &&
							context.messages.some((message) => getMessageText(message) === item.text)
						)
							firstRequest.set(item.text, requests);
					}
				} catch (error) {
					oracleErrors.push(error);
				}
				return index === 0 && scenario.startsWith("live")
					? fauxAssistantMessage([fauxToolCall("step", {})])
					: fauxAssistantMessage("reply");
			}),
		);
		let outcome: Promise<unknown>;
		if (scenario.startsWith("hold")) {
			outcome = h.session.compactNow().catch((error: unknown) => error);
			await waiting.promise;
			await inputs();
		} else {
			if (scenario.startsWith("l3") || scenario === "live-install")
				expect(h.session.startBackgroundCompaction({ source: "user" }).status).toBe("started");
			outcome = h.session.prompt("start", { onStartMessagePersistence: () => {} }).catch((error: unknown) => error);
			if (scenario.startsWith("l3")) {
				await waiting.promise;
				await inputs();
			}
		}
		if (scenario.startsWith("hold") || scenario.startsWith("l3")) {
			await h.session.steer("queued user");
			expect(h.session.pendingMessageCount).toBe(1);
			observeOwnership();
			const callsBeforeStop = h.faux.state.callCount;
			try {
				if (scenario.endsWith("reload")) await h.session.reload();
				else if (scenario.endsWith("cancel")) h.session.cancelBackgroundCompaction();
				else if (scenario.endsWith("apply"))
					summary.resolve({ summary: "summary", firstKeptEntryId: kept, tokensBefore: 0 });
				else await h.session.abort();
			} catch (error) {
				// SDK stop APIs propagate an attempted stop-writer append failure;
				// the ownership oracle still requires a receipt or retained owner.
				expect(String(error)).toMatch(/matrix transient|Session file write failed/);
			}
			await outcome;
			await h.session.waitForIdle();
			if (!scenario.endsWith("apply")) expect(h.faux.state.callCount).toBe(callsBeforeStop);
		} else {
			await outcome;
			await h.session.waitForIdle();
		}
		// A transient error can stop an admitted batch. Exactly two explicit idle
		// stop-writer steps are the finite recovery bound; neither starts a request.
		const sent = h.faux.state.callCount;
		await h.session.abort();
		await h.session.abort();
		expect(h.faux.state.callCount).toBe(sent);
		observeOwnership();
		const receipts = journal();
		if ((scenario.startsWith("hold") || scenario.startsWith("l3")) && !scenario.endsWith("apply")) {
			expect(h.session.clearQueue()).toEqual({ steering: ["queued user"], followUp: [] });
			expect(h.session.clearQueue()).toEqual({ steering: [], followUp: [] });
		}
		for (const item of accepted) expect(receipts.filter((text) => text === item.text).length).toBeLessThanOrEqual(1);
		for (const key of new Set(accepted.map((item) => item.key))) {
			const ordered = accepted.filter((item) => item.key === key && item.ordered).map((item) => item.text);
			expect(receipts.filter((text) => ordered.includes(text))).toEqual(
				ordered.filter((text) => receipts.includes(text)),
			);
		}
		if (sticky) {
			expect(manager.getPersistenceError()).toBeDefined();
			expect(storeTexts().length).toBeGreaterThan(0);
			const calls = h.faux.state.callCount;
			await expect(h.session.prompt("refused")).rejects.toThrow("Session file write failed");
			expect(h.faux.state.callCount).toBe(calls);
		} else {
			const installed = scenario === "hold-apply" || scenario === "live-install";
			expect(manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(installed ? 1 : 0);
			expect(accepted.filter((item) => item.text.endsWith("-notice"))).toHaveLength(
				installed || scenario === "live-context" ? 3 : 0,
			);
			expect(accepted).toHaveLength(installed || scenario === "live-context" ? 21 : 18);
			expect(receipts.filter((text) => accepted.some((item) => item.text === text))).toHaveLength(accepted.length);
			expect(ownership(h.session)._customStore.size).toBe(0);
			expect(h.session.agent.hasQueuedMessages()).toBe(false);
		}
		if (scenario.startsWith("live") && scenario !== "live-stop" && failure === "none") {
			// Steering completions remain live while the tool continuation and an
			// unrelated follow-up coexist: next request, not after the follow-up.
			expect(firstRequest.get(accepted[0].text)).toBe(2);
			expect(firstRequest.get(accepted.find((item) => item.text.endsWith("-followUp"))!.text)).toBeGreaterThan(2);
		}
		for (const rider of riders) {
			if (firstRequest.has(rider.text))
				expect(firstRequest.get(rider.text)).toBe(firstRequest.get(rider.predecessor));
		}
		// The runner/faux provider isolate hook errors. Do not let an assertion in
		// either observation path turn silently into an apparently passing run.
		expect(oracleErrors).toEqual([]);
		expect(requests).toBeLessThanOrEqual(24);
	});

	it.each([7, 19, 47])(
		"seed=%s: nextTurn stays outside the store and nonempty bootstrap transfers once",
		async (seed) => {
			const h = await createHarness({ settings: { compaction: { enabled: false } } });
			cleanups.push(h.cleanup);
			const accepted = [`passive-${seed}`, `next-${seed}`];
			await h.session.sendCustomMessage(
				{ customType: "task", content: accepted[0], display: false },
				{ triggerTurn: false },
			);
			await h.session.sendCustomMessage(
				{ customType: "task", content: accepted[1], display: false },
				{ deliverAs: "nextTurn" },
			);
			expect(h.session.stagedMessages.map(getMessageText)).toEqual([accepted[0]]);
			expect(ownership(h.session)._customStore.size).toBe(0);
			expect(h.session.pendingMessageCount).toBe(0);
			await h.session.reload();
			h.setResponses([
				(context) => {
					for (const text of accepted)
						expect(context.messages.filter((message) => getMessageText(message) === text)).toHaveLength(1);
					return fauxAssistantMessage("done");
				},
			]);
			await h.session.prompt("bootstrap");
			expect(
				h.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "custom_message")
					.map(getMessageText),
			).toEqual(accepted);
			expect(h.session.stagedMessages).toHaveLength(0);
		},
	);
});
