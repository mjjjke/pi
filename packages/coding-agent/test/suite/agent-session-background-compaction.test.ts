import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, StartMessagePersistence } from "../../src/core/agent-session.ts";
import { type CompactionResult, estimateProjectedContextTokens } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
}
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});
function phase(h: Harness, expected: string): Promise<void> {
	return new Promise((resolve) => {
		const off = h.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "session_background_compaction" && event.phase === expected) {
				off();
				resolve();
			}
		});
	});
}
async function setup(
	hard = false,
	onTool?: () => Promise<void>,
	onCompact?: () => Promise<void>,
	blocking?: Promise<{ compaction: CompactionResult }>,
) {
	const summary = deferred<CompactionResult>();
	let cuts = 0;
	let starts = 0;
	const h = await createHarness({
		models: [{ id: "bgc", contextWindow: 10000, maxTokens: 1000 }],
		tools: onTool
			? [
					{
						name: "step",
						label: "step",
						description: "step",
						parameters: Type.Object({}),
						execute: async () => {
							await onTool();
							return { content: [{ type: "text", text: "done" }], details: {} };
						},
					},
				]
			: undefined,
		settings: { compaction: { keepRecentTokens: 10, reserveTokens: 1000 } },
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", () => {
					starts++;
				});
				if (onCompact) pi.on("session_compact", onCompact);
				pi.on("session_before_compact", (event) => {
					cuts++;
					if ("background" in event) return summary.promise.then((compaction) => ({ compaction }));
					if (blocking) return blocking;
					return {
						compaction: {
							summary: "blocking",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 10000,
						},
					};
				});
			},
		],
	});
	harnesses.push(h);
	h.sessionManager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
	h.sessionManager.appendMessage({ role: "user", content: "x".repeat(hard ? 64000 : 16000), timestamp: 2 });
	const model = h.getModel();
	h.sessionManager.appendMessage({
		...fauxAssistantMessage("old", { timestamp: 3 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	const kept = h.sessionManager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 4 });
	h.session.refreshContext();
	h.setResponses([fauxAssistantMessage("reply"), fauxAssistantMessage("second")]);
	return {
		h,
		finish: () => summary.resolve({ summary: "summary", firstKeptEntryId: kept, tokensBefore: 0 }),
		get cuts() {
			return cuts;
		},
		get starts() {
			return starts;
		},
		kept,
	};
}

describe("AgentSession background compaction integration", () => {
	it("launches without changing context and installs a fixed cut at gate 1 before preflight", async () => {
		const f = await setup();
		const before = JSON.stringify(f.h.session.messages);
		expect(f.h.session.startBackgroundCompaction({ source: "user" }).status).toBe("started");
		expect(f.h.session.isCompacting).toBe(false);
		expect(JSON.stringify(f.h.session.messages)).toBe(before);
		const ready = phase(f.h, "ready");
		f.finish();
		await ready;
		const later = f.h.sessionManager.appendCustomMessageEntry("task", "completed", false);
		await f.h.session.prompt("new input");
		const branch = f.h.sessionManager.getBranch();
		const entry = branch.find((e) => e.type === "compaction");
		expect(entry).toMatchObject({
			parentId: later,
			firstKeptEntryId: f.kept,
			summary: "summary",
			details: { background: { source: "user" } },
		});
		expect(f.cuts).toBe(1);
		expect(f.starts).toBe(1);
		expect(f.h.session.getBackgroundCompaction()).toBeUndefined();
		expect(f.h.eventsOfType("compaction_start")).toHaveLength(0);
		expect(f.h.eventsOfType("session_background_compaction").filter((e) => e.phase === "applied")).toHaveLength(1);
	});

	it("does not launch compaction without a starter below the hard threshold", async () => {
		const f = await setup();
		await f.h.session.prompt("ordinary");
		expect(f.cuts).toBe(0);
		expect(f.h.session.getBackgroundCompaction()).toBeUndefined();
	});

	it("disabled safety net neither waits nor blocks, but explicitly requested ready jobs still install", async () => {
		const f = await setup(true);
		f.h.session.setAutoCompactionEnabled(false);
		f.h.session.startBackgroundCompaction({ source: "user" });
		await f.h.session.prompt("ordinary while summarizing");
		expect(f.cuts).toBe(1);
		expect(f.h.eventsOfType("session_background_compaction").some((event) => event.phase === "waiting")).toBe(false);
		expect(f.h.eventsOfType("compaction_start")).toHaveLength(0);
		const ready = phase(f.h, "ready");
		f.finish();
		await ready;
		await f.h.session.prompt("apply explicit job");
		expect(f.h.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(f.h.session.getBackgroundCompaction()).toBeUndefined();
	});

	it("at exact H the pre-prompt safety net waits for a running job", async () => {
		const f = await setup();
		// The actual projection defines H; no usage or chars/4 estimate is guessed by the fixture.
		const tokens = estimateProjectedContextTokens(
			f.h.sessionManager.buildSessionProjection(),
			f.h.sessionManager.getBranch(),
		).tokens;
		f.h.session.agent.state.model = { ...f.h.getModel(), contextWindow: tokens + 1000 };
		f.h.session.startBackgroundCompaction({ source: "user" });
		const run = f.h.session.prompt("held at H", { onStartMessagePersistence: () => {} });
		await vi.waitFor(() =>
			expect(f.h.eventsOfType("session_background_compaction").some((event) => event.phase === "waiting")).toBe(
				true,
			),
		);
		await f.h.session.abort();
		await run;
		expect(f.h.eventsOfType("agent_start")).toHaveLength(0);
	});

	it.each(["abort", "cancel"] as const)(
		"%s at gate 1 stops before preflight and receipts the unpersisted user once",
		async (action) => {
			const f = await setup(true);
			f.h.session.startBackgroundCompaction({ source: "user" });
			const waiting = phase(f.h, "waiting");
			const receipts: StartMessagePersistence[] = [];
			const run = f.h.session.prompt("unsent", { onStartMessagePersistence: (receipt) => receipts.push(receipt) });
			await waiting;
			if (action === "abort") await f.h.session.abort();
			else f.h.session.cancelBackgroundCompaction();
			await run;
			expect(receipts).toHaveLength(1);
			expect(receipts[0]).toMatchObject({ persisted: false, stopped: true, message: { role: "user" } });
			expect(f.starts).toBe(0);
			expect(f.h.eventsOfType("agent_start")).toHaveLength(0);
			expect(
				f.h.sessionManager
					.getBranch()
					.some((e) => e.type === "message" && e.message.role === "user" && e.message.content === "unsent"),
			).toBe(false);
			if (action === "abort") {
				expect(f.h.session.getBackgroundCompaction()?.phase).toBe("summarizing");
				const ready = phase(f.h, "ready");
				f.finish();
				await ready;
				await f.h.session.prompt("later");
				expect(f.h.sessionManager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(1);
			} else {
				expect(f.h.session.getBackgroundCompaction()).toBeUndefined();
				await f.h.session.prompt("later over H");
				expect(f.cuts).toBe(2);
			}
		},
	);

	it("gate-1 stop without an observer rejects AbortError, never a silent lost prompt", async () => {
		const f = await setup(true);
		f.h.session.startBackgroundCompaction({ source: "user" });
		const waiting = phase(f.h, "waiting");
		const result = f.h.session.prompt("unsent").then(
			() => undefined,
			(error: unknown) => error,
		);
		await waiting;
		await f.h.session.abort();
		expect(await result).toMatchObject({ name: "AbortError" });
	});

	it("gate-1 custom stop writes a held trigger and its rider passively in arrival order", async () => {
		const f = await setup(true);
		f.h.session.startBackgroundCompaction({ source: "user" });
		const waiting = phase(f.h, "waiting");
		const run = f.h.session.sendCustomMessage(
			{ customType: "task", content: "running", display: false },
			{ triggerTurn: true, orderKey: "t" },
		);
		await waiting;
		await f.h.session.sendCustomMessage(
			{ customType: "task", content: "stopped", display: false },
			{ triggerTurn: false, orderKey: "t" },
		);
		await f.h.session.abort();
		await run;
		expect(
			f.h.sessionManager
				.getBranch()
				.filter((e) => e.type === "custom_message")
				.map((e) => e.content),
		).toEqual(["running", "stopped"]);
		expect(f.h.eventsOfType("agent_start")).toHaveLength(0);
	});

	it("installs at gate 2 before draining a steer and follow-up", async () => {
		const f = await setup(false, async () => {
			await f.h.session.steer("steer");
			await f.h.session.followUp("follow");
			const ready = phase(f.h, "ready");
			f.finish();
			await ready;
		});
		f.h.session.startBackgroundCompaction({ source: "user" });
		f.h.setResponses([
			fauxAssistantMessage([fauxToolCall("step", {})]),
			fauxAssistantMessage("after tool"),
			fauxAssistantMessage("after follow"),
		]);
		await f.h.session.prompt("go");
		const branch = f.h.sessionManager.getBranch();
		const cut = branch.findIndex((e) => e.type === "compaction");
		const users = branch.flatMap((e, i) =>
			e.type === "message" && e.message.role === "user" ? [{ i, text: JSON.stringify(e.message.content) }] : [],
		);
		expect(cut).toBeGreaterThan(0);
		expect(users.find((u) => u.text.includes("steer"))?.i).toBeGreaterThan(cut);
		expect(users.find((u) => u.text.includes("follow"))?.i).toBeGreaterThan(cut);
	});

	it("--now Esc releases its reservation and receipts held triggers without sending queued input", async () => {
		const f = await setup();
		const waiting = phase(f.h, "waiting");
		const now = f.h.session.compactNow();
		await waiting;
		expect(f.h.session.isCompacting).toBe(true);
		await f.h.session.sendCustomMessage(
			{ customType: "task", content: "running", display: false },
			{ triggerTurn: true, orderKey: "t" },
		);
		await f.h.session.sendCustomMessage(
			{ customType: "task", content: "stopped", display: false },
			{ triggerTurn: false, orderKey: "t" },
		);
		await f.h.session.prompt("queued");
		await f.h.session.abort();
		expect(await now).toMatchObject({ status: "released" });
		expect(f.h.session.isIdle).toBe(true);
		expect(f.h.session.clearQueue()).toEqual({ steering: ["queued"], followUp: [] });
		expect(
			f.h.sessionManager
				.getBranch()
				.filter((e) => e.type === "custom_message")
				.map((e) => e.content),
		).toEqual(["running", "stopped"]);
		expect(f.h.eventsOfType("agent_start")).toHaveLength(0);
		const ready = phase(f.h, "ready");
		f.finish();
		await ready;
		await f.h.session.prompt("later");
		expect(f.h.session.getBackgroundCompaction()).toBeUndefined();
	});

	it("--now holds custom triggers and prompts through awaited install notifications", async () => {
		const reached = deferred<void>();
		const release = deferred<void>();
		const f = await setup(false, undefined, async () => {
			reached.resolve();
			await release.promise;
		});
		const waiting = phase(f.h, "waiting");
		const now = f.h.session.compactNow();
		await waiting;
		f.finish();
		await reached.promise;
		await f.h.session.sendCustomMessage(
			{ customType: "task", content: "running", display: false },
			{ triggerTurn: true, orderKey: "t" },
		);
		await f.h.session.sendCustomMessage(
			{ customType: "task", content: "completed", display: false },
			{ triggerTurn: false, orderKey: "t" },
		);
		await f.h.session.prompt("queued");
		expect(f.h.eventsOfType("agent_start")).toHaveLength(0);
		expect(f.h.session.isCompacting).toBe(true);
		expect(f.h.session.cancelBackgroundCompaction()).toBe(false);
		release.resolve();
		expect((await now).status).toBe("applied");
		await f.h.session.waitForIdle();
		const branch = f.h.sessionManager.getBranch();
		const cut = branch.findIndex((e) => e.type === "compaction");
		expect(branch.filter((e) => e.type === "custom_message").map((e) => e.content)).toEqual(["running", "completed"]);
		expect(branch.slice(cut + 1).some((e) => e.type === "message" && e.message.role === "user")).toBe(true);
		expect(f.h.eventsOfType("agent_start")).toHaveLength(1);
	});

	it("two simultaneous --now callers cannot replace the manual reservation", async () => {
		const f = await setup();
		const waiting = phase(f.h, "waiting");
		const first = f.h.session.compactNow();
		const second = f.h.session.compactNow().then(
			(value) => value,
			(error: unknown) => error,
		);
		await waiting;
		expect(await second).toMatchObject({ name: "Error", message: "Compaction is already in progress" });
		expect(f.h.session.isCompacting).toBe(true);
		f.h.session.abortCompaction();
		expect((await first).status).toBe("released");
	});

	it("failed stop-writer receipts cannot strand a released --now idle waiter", async () => {
		const f = await setup();
		const waiting = phase(f.h, "waiting");
		const errors: string[] = [];
		f.h.session.extensionRunner.onError((event) => errors.push(event.error));
		const now = f.h.session.compactNow();
		await waiting;
		await f.h.session.sendCustomMessage(
			{ customType: "task", content: "held", display: false },
			{ triggerTurn: true },
		);
		vi.spyOn(f.h.sessionManager, "_persist").mockImplementation(() => {
			throw new Error("disk failure");
		});
		const idle = f.h.session.waitForIdle();
		f.h.session.abortCompaction();
		expect((await now).status).toBe("released");
		await idle;
		expect(errors).toContain("disk failure");
		expect(f.h.session.isIdle).toBe(true);
	});

	it.each(["abort", "cancel"] as const)(
		"mid-run L3 %s stops before queue admission and receipts running/stopped once",
		async (action) => {
			const f = await setup(false, async () => {
				await f.h.session.sendCustomMessage(
					{ customType: "large", content: "x".repeat(64000), display: false },
					{ triggerTurn: false },
				);
				await f.h.session.sendCustomMessage(
					{ customType: "task", content: "running", display: false },
					{ deliverAs: "steer", orderKey: "task" },
				);
				await f.h.session.steer("unsent");
			});
			f.h.session.startBackgroundCompaction({ source: "user" });
			f.h.setResponses([fauxAssistantMessage([fauxToolCall("step", {})]), fauxAssistantMessage("must not send")]);
			const waiting = phase(f.h, "waiting");
			const run = f.h.session.prompt("go");
			await waiting;
			await f.h.session.sendCustomMessage(
				{ customType: "task", content: "stopped", display: false },
				{ triggerTurn: false, orderKey: "task" },
			);
			if (action === "abort") await f.h.session.abort();
			else f.h.session.cancelBackgroundCompaction();
			await run;
			expect(f.h.getPendingResponseCount()).toBe(1);
			expect(f.h.eventsOfType("agent_settled").at(-1)).toMatchObject({ aborted: true });
			expect(f.h.session.clearQueue()).toEqual({ steering: ["unsent"], followUp: [] });
			expect(
				f.h.sessionManager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "custom_message" && entry.customType === "task" ? [entry.content] : [],
					),
			).toEqual(["running", "stopped"]);
			if (action === "abort") expect(f.h.session.getBackgroundCompaction()?.phase).toBe("summarizing");
			else expect(f.h.session.getBackgroundCompaction()).toBeUndefined();
		},
	);

	it("a ready job too large for a newly selected model terminates without an automatic background relaunch", async () => {
		const f = await setup();
		f.h.session.setAutoCompactionEnabled(false);
		f.h.session.startBackgroundCompaction({ source: "user" });
		const ready = phase(f.h, "ready");
		f.finish();
		await ready;
		f.h.session.agent.state.model = { ...f.h.getModel(), contextWindow: 1100 };
		await f.h.session.prompt("new model");
		expect(f.h.sessionManager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(
			f.h.eventsOfType("session_background_compaction").filter((event) => event.phase === "discarded"),
		).toMatchObject([{ cause: "insufficient" }]);
		expect(f.h.session.getBackgroundCompaction()).toBeUndefined();
		expect(f.cuts).toBe(1);
	});

	it("Q13 stops at a signal-ignoring blocking hook before draining the next batch", async () => {
		const never = deferred<{ compaction: CompactionResult }>();
		const f = await setup(
			false,
			async () => {
				await f.h.session.sendCustomMessage(
					{ customType: "large", content: "x".repeat(64000), display: false },
					{ triggerTurn: false },
				);
				await f.h.session.steer("unsent");
			},
			undefined,
			never.promise,
		);
		const compacting = new Promise<void>((resolve) => {
			const off = f.h.session.subscribe((event) => {
				if (event.type === "compaction_start") {
					off();
					resolve();
				}
			});
		});
		f.h.setResponses([fauxAssistantMessage([fauxToolCall("step", {})]), fauxAssistantMessage("must not send")]);
		const run = f.h.session.prompt("go");
		await compacting;
		f.h.session.abortCompaction();
		await run;
		expect(f.h.getPendingResponseCount()).toBe(1);
		expect(f.h.session.clearQueue()).toEqual({ steering: ["unsent"], followUp: [] });
		expect(f.h.session.isIdle).toBe(true);
	});

	it.each(["reload", "dispose"] as const)(
		"%s invalidates a running summary and ignores late completion",
		async (action) => {
			const f = await setup();
			f.h.session.startBackgroundCompaction({ source: "user" });
			if (action === "reload") await f.h.session.reload();
			else f.h.session.dispose();
			f.finish();
			await Promise.resolve();
			await Promise.resolve();
			expect(f.h.session.getBackgroundCompaction()).toBeUndefined();
			expect(f.h.sessionManager.getBranch().some((e) => e.type === "compaction")).toBe(false);
		},
	);
});
