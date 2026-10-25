import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionResult } from "../../src/core/compaction/index.ts";
import type { ExtensionContext, SessionBackgroundCompactionEvent } from "../../src/core/extensions/index.ts";
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
