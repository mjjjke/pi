import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent, StartMessagePersistence } from "../../src/core/agent-session.ts";
import type { CompactionResult } from "../../src/core/compaction/index.ts";
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
async function setup(hard = false, onTool?: () => Promise<void>) {
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
				pi.on("session_before_compact", (event) => {
					cuts++;
					if ("background" in event) return summary.promise.then((compaction) => ({ compaction }));
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
