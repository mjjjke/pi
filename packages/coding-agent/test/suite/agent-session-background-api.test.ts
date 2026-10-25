import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CompactionResult, estimateProjectedContextTokens } from "../../src/core/compaction/index.ts";
import type { ExtensionContext, SessionBackgroundCompactionEvent } from "../../src/core/extensions/index.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import { createHarness, type Harness } from "./harness.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

describe("background compaction extension API", () => {
	it("binds the stream C names, forwards metadata and awaits the applied event", async () => {
		let ctx!: ExtensionContext;
		const summary = deferred<CompactionResult>();
		const ready = deferred<void>();
		const reached = deferred<void>();
		const release = deferred<void>();
		const phases: SessionBackgroundCompactionEvent[] = [];
		let hookId: string | undefined;
		let compactId: string | undefined;
		const h = await createHarness({
			settings: { compaction: { keepRecentTokens: 10 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, context) => {
						ctx = context;
					});
					pi.on("session_before_compact", async (event) => {
						hookId = event.background?.jobId;
						return { compaction: await summary.promise };
					});
					pi.on("session_background_compaction", async (event) => {
						phases.push(event);
						if (event.phase === "ready") ready.resolve();
						if (event.phase === "applied") {
							reached.resolve();
							await release.promise;
						}
					});
					pi.on("session_compact", (event) => {
						compactId = event.background?.jobId;
					});
				},
			],
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
		const kept = h.sessionManager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 3 });
		h.session.refreshContext();
		await h.session.bindExtensions({});
		expect(typeof ctx.startBackgroundCompaction).toBe("function");
		const started = ctx.startBackgroundCompaction!({ source: "model" });
		expect(started.status).toBe("started");
		const id = "jobId" in started ? started.jobId : "";
		expect(ctx.getBackgroundCompaction!()).toMatchObject({ jobId: id, source: "model", phase: "summarizing" });
		expect(hookId).toBe(id);
		summary.resolve({ summary: "summary", firstKeptEntryId: kept, tokensBefore: 0 });
		await ready.promise;
		h.setResponses([fauxAssistantMessage("reply")]);
		const run = h.session.prompt("new");
		await reached.promise;
		expect(compactId).toBe(id);
		expect(h.eventsOfType("agent_start")).toHaveLength(0);
		expect(ctx.cancelBackgroundCompaction!(id)).toBe(false);
		release.resolve();
		await run;
		expect(phases.map((e) => e.phase)).toEqual(["started", "ready", "applied"]);
		expect(ctx.getBackgroundCompaction!()).toBeUndefined();
	});

	it.each(["cancel", "reload", "dispose"] as const)(
		"irreversible append survives %s inside an awaited compact handler",
		async (action) => {
			const summary = deferred<CompactionResult>();
			const entered = deferred<void>();
			const release = deferred<void>();
			let laterHandler = 0;
			const h = await createHarness({
				settings: { compaction: { keepRecentTokens: 10 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", async () => ({ compaction: await summary.promise }));
						pi.on("session_compact", async () => {
							entered.resolve();
							await release.promise;
						});
						pi.on("session_compact", () => {
							laterHandler++;
						});
					},
				],
			});
			harnesses.push(h);
			h.sessionManager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
			h.sessionManager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
			const kept = h.sessionManager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 3 });
			h.session.refreshContext();
			const ctx = h.session.extensionRunner.createContext();
			let unsubscribedApplied = 0;
			const off = h.session.subscribe((event) => {
				if (event.type === "session_background_compaction" && event.phase === "applied") unsubscribedApplied++;
			});
			const now = h.session.compactNow();
			await vi.waitFor(() => expect(h.session.getBackgroundCompaction()?.phase).toBe("claimed"));
			summary.resolve({ summary: "summary", firstKeptEntryId: kept, tokensBefore: 0 });
			await entered.promise;
			off();
			expect(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
			expect(h.session.cancelBackgroundCompaction()).toBe(false);
			if (action === "reload") await h.session.reload();
			if (action === "dispose") {
				h.session.dispose();
				expect(() => ctx.getBackgroundCompaction!()).toThrow("stale");
			}
			release.resolve();
			expect(await now).toMatchObject({ status: "applied" });
			expect.soft(laterHandler).toBe(action === "cancel" ? 1 : 0);
			expect(unsubscribedApplied).toBe(0);
			expect(
				h.eventsOfType("session_background_compaction").filter((event) => event.phase === "applied"),
			).toHaveLength(1);
			expect(h.eventsOfType("agent_start")).toHaveLength(0);
		},
	);

	it.each([
		["session_compact", "dispose"],
		["applied", "dispose"],
		["session_compact", "replacement"],
		["applied", "replacement"],
		["session_compact", "shutdown"],
		["applied", "shutdown"],
	] as const)("review B5: %s releases its irreversible install on %s", async (blocked, action) => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const h = await createHarness({
			settings: { compaction: { keepRecentTokens: 10 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 0,
						},
					}));
					if (blocked === "session_compact")
						pi.on("session_compact", async () => {
							entered.resolve();
							await release.promise;
						});
					else
						pi.on("session_background_compaction", async (event) => {
							if (event.phase === "applied") {
								entered.resolve();
								await release.promise;
							}
						});
				},
			],
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
		h.sessionManager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 3 });
		h.session.refreshContext();
		let settled = false;
		const now = h.session.compactNow().finally(() => {
			settled = true;
		});
		await entered.promise;
		await h.session.prompt("held user");
		if (action === "replacement") await h.session.prepareForSessionReplacement();
		if (action === "shutdown")
			await emitSessionShutdownEvent(h.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		h.session.dispose();
		try {
			await vi.waitFor(() => expect(settled).toBe(true));
			expect(h.faux.state.callCount).toBe(0);
			expect(h.session.clearQueue()).toEqual({ steering: ["held user"], followUp: [] });
			expect(h.session.isIdle).toBe(true);
			expect(await now).toMatchObject({ status: "applied" });
			expect(
				h.eventsOfType("session_background_compaction").filter((event) => event.phase === "applied"),
			).toHaveLength(1);
		} finally {
			release.resolve();
			await now;
		}
	});

	it.each([
		"reload",
		"dispose",
		"shutdown",
		"reentrant dispose",
		"cancel dispose",
		"cancel reentrant dispose",
	] as const)("review B4: %s persists terminal intent before invalidation or shutdown", async (action) => {
		let active = true;
		const h = await createHarness({
			settings: { compaction: { keepRecentTokens: 10 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => new Promise<never>(() => {}));
					pi.on("session_shutdown", () => {
						active = false;
					});
					pi.on("session_background_compaction", async (event) => {
						if (action === "dispose" && event.phase === "discarded") await new Promise<never>(() => {});
						if (
							(action === "reentrant dispose" || action === "cancel reentrant dispose") &&
							event.phase === "discarded"
						)
							h.session.dispose();
					});
					pi.on("session_background_compaction", (event) => {
						if (active && event.phase === "discarded")
							pi.appendEntry("review-discard-intent", { jobId: event.jobId });
					});
				},
			],
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
		h.sessionManager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 3 });
		h.session.refreshContext();
		h.session.startBackgroundCompaction({ source: "model" });
		if (action === "cancel dispose" || action === "cancel reentrant dispose") {
			h.session.cancelBackgroundCompaction();
			if (action === "cancel dispose") h.session.dispose();
		} else if (action === "reload") await h.session.reload();
		else if (action === "shutdown") {
			await emitSessionShutdownEvent(h.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
			h.session.dispose();
		} else h.session.dispose();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(
			h.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === "review-discard-intent"),
		).toHaveLength(1);
	});

	it("review B7: tree terminal intent and oldLeaf stay on the launch branch", async () => {
		let oldLeaf: string | null | undefined;
		const h = await createHarness({
			settings: { compaction: { keepRecentTokens: 10 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => new Promise<never>(() => {}));
					pi.on("session_background_compaction", (event) => {
						if (event.phase === "discarded") pi.appendEntry("review-discard-intent", { jobId: event.jobId });
					});
					pi.on("session_tree", (event) => {
						oldLeaf = event.oldLeafId;
					});
				},
			],
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
		const target = h.sessionManager.appendMessage(fauxAssistantMessage("old"));
		const launch = h.sessionManager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 3 });
		h.session.refreshContext();
		h.session.startBackgroundCompaction({ source: "model" });
		await h.session.navigateTree(target);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const intents = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "review-discard-intent");
		expect(intents).toHaveLength(1);
		expect(h.sessionManager.getBranch(intents[0].id).some((entry) => entry.id === launch)).toBe(true);
		expect(oldLeaf).toBe(intents[0].id);
		await h.session.navigateTree(oldLeaf!);
		expect(h.sessionManager.getBranch().some((entry) => entry.id === intents[0].id)).toBe(true);
		expect(h.session.getBackgroundCompaction()).toBeUndefined();
	});

	it.each(["started", "discarded"] as const)("review B6: reload releases a blocked %s observer", async (phase) => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const h = await createHarness({
			settings: { compaction: { keepRecentTokens: 10 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => new Promise<never>(() => {}));
					pi.on("session_background_compaction", async (event) => {
						if (event.phase === phase) {
							entered.resolve();
							await release.promise;
						}
					});
					pi.on("session_background_compaction", (event) => {
						if (event.phase === "discarded") pi.appendEntry("review-discard-intent", { jobId: event.jobId });
					});
				},
			],
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
		h.sessionManager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 3 });
		h.session.refreshContext();
		h.session.startBackgroundCompaction({ source: "model" });
		if (phase === "started") await entered.promise;
		let settled = false;
		const reload = h.session.reload().finally(() => {
			settled = true;
		});
		if (phase === "discarded") await entered.promise;
		try {
			await vi.waitFor(() => expect(settled).toBe(true), { timeout: 200 });
			expect(
				h.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "custom" && entry.customType === "review-discard-intent"),
			).toHaveLength(1);
		} finally {
			release.resolve();
			await reload;
		}
	});

	it("reload terminates a claimed manual wait without waiting for its summary", async () => {
		const summary = deferred<CompactionResult>();
		const h = await createHarness({
			settings: { compaction: { keepRecentTokens: 10 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ compaction: await summary.promise }));
				},
			],
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
		const kept = h.sessionManager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 3 });
		h.session.refreshContext();
		const runner = h.session.extensionRunner;
		const now = h.session.compactNow();
		await vi.waitFor(() => expect(h.session.getBackgroundCompaction()?.phase).toBe("claimed"));
		await h.session.prompt("held input");
		await h.session.reload();
		expect(await now).toMatchObject({ status: "released" });
		expect(h.session.clearQueue()).toEqual({ steering: ["held input"], followUp: [] });
		expect(h.faux.state.callCount).toBe(0);
		expect(runner.isInvalidated()).toBe(true);
		summary.resolve({ summary: "late", firstKeptEntryId: kept, tokensBefore: 0 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.session.getBackgroundCompaction()).toBeUndefined();
		expect(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("reload terminates a claimed L3 pre-prompt wait, retaining queued input and ignoring late completion", async () => {
		const summary = deferred<CompactionResult>();
		const h = await createHarness({
			models: [{ id: "small", contextWindow: 3000, maxTokens: 1000 }],
			settings: { compaction: { keepRecentTokens: 10, reserveTokens: 1000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({ compaction: await summary.promise }));
				},
			],
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
		h.sessionManager.appendMessage({
			...fauxAssistantMessage("old", { timestamp: 3 }),
			api: h.getModel().api,
			provider: h.getModel().provider,
			model: h.getModel().id,
		});
		const kept = h.sessionManager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 4 });
		h.session.refreshContext();
		const tokens = estimateProjectedContextTokens(
			h.sessionManager.buildSessionProjection(),
			h.sessionManager.getBranch(),
		).tokens;
		h.session.agent.state.model = { ...h.getModel(), contextWindow: tokens + 1000 };
		expect(h.session.startBackgroundCompaction({ source: "model" }).status).toBe("started");
		const runner = h.session.extensionRunner;
		// Attach before shutdown: a stopped, unadmitted SDK prompt reports AbortError.
		const run = h.session.prompt("unadmitted").then(
			() => undefined,
			(error: unknown) => error,
		);
		await vi.waitFor(() => expect(h.session.getBackgroundCompaction()?.phase).toBe("claimed"));
		await h.session.steer("queued input");
		await h.session.reload();
		expect(await run).toMatchObject({ name: "AbortError" });
		expect(runner.isInvalidated()).toBe(true);
		expect(h.session.isIdle).toBe(true);
		expect(h.session.clearQueue()).toEqual({ steering: ["queued input"], followUp: [] });
		summary.resolve({ summary: "late", firstKeptEntryId: kept, tokensBefore: 0 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(h.session.getBackgroundCompaction()).toBeUndefined();
		expect(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(h.faux.state.callCount).toBe(0);
	});

	it("guards stale contexts and observes terminal cancellation before disposal removes listeners", async () => {
		const h = await createHarness({
			settings: { compaction: { keepRecentTokens: 10 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => new Promise<never>(() => {}));
				},
			],
		});
		harnesses.push(h);
		h.sessionManager.appendMessage({ role: "system", content: "", timestamp: 1 });
		h.sessionManager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
		h.sessionManager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 3 });
		h.session.refreshContext();
		const ctx = h.session.extensionRunner.createContext();
		expect(ctx.startBackgroundCompaction!({ source: "user" }).status).toBe("started");
		expect(ctx.cancelBackgroundCompaction!("wrong-job")).toBe(false);
		h.session.dispose();
		expect(h.eventsOfType("session_background_compaction").filter((e) => e.phase === "discarded")).toHaveLength(1);
		expect(() => ctx.getBackgroundCompaction!()).toThrow("stale");
		expect(() => ctx.startBackgroundCompaction!({ source: "user" })).toThrow("stale");
		expect(() => ctx.cancelBackgroundCompaction!()).toThrow("stale");
	});
});
