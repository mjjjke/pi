import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionResult } from "../../src/core/compaction/index.ts";
import { createHarness, type Harness } from "./harness.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const usage = {
	input: 31,
	output: 7,
	cacheRead: 2,
	cacheWrite: 3,
	totalTokens: 43,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});
async function setup(onCompact?: () => Promise<void>) {
	const summary = deferred<CompactionResult>();
	const delivered: string[] = [];
	const h = await createHarness({
		models: [{ id: "frozen", contextWindow: 10000, maxTokens: 1000 }],
		settings: { compaction: { keepRecentTokens: 10, reserveTokens: 1000 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async () => ({ compaction: await summary.promise }));
				if (onCompact) pi.on("session_compact", onCompact);
				pi.on("standing_instruction_delivered", (event) => {
					delivered.push(event.key);
				});
			},
		],
	});
	harnesses.push(h);
	h.sessionManager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
	h.sessionManager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
	const kept = h.sessionManager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 3 });
	h.session.refreshContext();
	return {
		h,
		delivered,
		finish: () => summary.resolve({ summary: "summary", firstKeptEntryId: kept, tokensBefore: 0, usage }),
	};
}

describe("Background compaction journal under lifecycle races", () => {
	it.each(["cancel", "dispose", "reload"] as const)(
		"accounts a late aggregate after %s once against the launch model",
		async (action) => {
			const f = await setup();
			f.h.session.startBackgroundCompaction({ source: "model" });
			const provider = f.h.getModel().provider;
			f.h.session.agent.state.model = { ...f.h.getModel(), id: "changed" };
			if (action === "cancel") f.h.session.cancelBackgroundCompaction();
			if (action === "dispose") f.h.session.dispose();
			if (action === "reload") await f.h.session.reload();
			f.finish();
			await vi.waitFor(() =>
				expect(f.h.sessionManager.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(1),
			);
			const accounted = f.h.sessionManager.getEntries().filter((entry) => entry.type === "usage");
			expect(accounted[0]).toMatchObject({ kind: "background-compaction", provider, model: "frozen", usage });
			expect(f.h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
			expect(f.h.session.getSessionStats()).toMatchObject({
				tokens: { input: 31, output: 7, cacheRead: 2, cacheWrite: 3, total: 43 },
				cost: 10,
			});
			expect(f.h.faux.state.callCount).toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(f.h.sessionManager.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(1);
		},
	);

	it("puts applied usage only in its entry despite cancel/dispose during awaited notifications", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const f = await setup(async () => {
			entered.resolve();
			await release.promise;
		});
		const now = f.h.session.compactNow();
		await vi.waitFor(() => expect(f.h.session.getBackgroundCompaction()?.phase).toBe("claimed"));
		f.finish();
		await entered.promise;
		expect(f.h.session.cancelBackgroundCompaction()).toBe(false);
		f.h.session.dispose();
		release.resolve();
		expect(await now).toMatchObject({ status: "applied" });
		expect(f.h.sessionManager.getEntries().filter((entry) => entry.type === "usage")).toHaveLength(0);
		expect(f.h.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toMatchObject([
			{ usage, details: { background: { source: "user" } } },
		]);
		expect(f.h.session.getSessionStats().cost).toBe(10);
		expect(
			f.h.eventsOfType("session_background_compaction").filter((event) => event.phase === "applied"),
		).toHaveLength(1);
	});

	it("carries desired standing values at append, while a newer value during notifications stays pending", async () => {
		const entered = deferred<void>();
		const release = deferred<void>();
		const f = await setup(async () => {
			entered.resolve();
			await release.promise;
		});
		f.h.session.setStandingInstruction("policy", "old");
		const now = f.h.session.compactNow();
		await vi.waitFor(() => expect(f.h.session.getBackgroundCompaction()?.phase).toBe("claimed"));
		f.h.session.setStandingInstruction("policy", "at append");
		f.finish();
		await entered.promise;
		expect(f.h.session.getStandingInstruction("policy")).toMatchObject({ content: "at append", delivered: true });
		f.h.session.setStandingInstruction("policy", "new pending");
		release.resolve();
		expect(await now).toMatchObject({ status: "applied" });
		expect(f.delivered).toEqual(["policy"]);
		expect(f.h.session.getStandingInstruction("policy")).toMatchObject({ content: "new pending", delivered: false });
		const entry = f.h.sessionManager.getEntries().find((item) => item.type === "compaction");
		expect(entry).toMatchObject({ standing: [{ key: "policy", message: { content: "at append" } }] });
		f.h.setResponses([fauxAssistantMessage("reply")]);
		await f.h.session.prompt("deliver pending");
		expect(f.delivered).toEqual(["policy", "policy"]);
		expect(f.h.session.getStandingInstruction("policy")).toMatchObject({ content: "new pending", delivered: true });
	});
});
