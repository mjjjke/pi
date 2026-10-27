import type { Usage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { type BackgroundCompactionEvent, BackgroundCompactionOwner } from "../src/core/background-compaction-owner.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import {
	type CompactionJobRequest,
	type CompactionJobResult,
	type CompactionJobSummarizer,
	createCompactionJobTarget,
} from "../src/core/compaction-job.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const usage: Usage = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};
function setup() {
	const manager = SessionManager.inMemory("/tmp/background-owner-test");
	manager.appendMessage({ role: "system", content: "checkpoint", timestamp: 1 });
	manager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
	const kept = manager.appendMessage({ role: "user", content: "kept suffix".repeat(20), timestamp: 3 });
	let disposed = false;
	let blocked = false;
	const events: BackgroundCompactionEvent[] = [];
	const requestRunStop = vi.fn();
	const refresh = vi.fn();
	const notifyApplied = vi.fn(async () => {});
	const accountUsage = vi.fn();
	const reportError = vi.fn();
	const emit = vi.fn(async (event: BackgroundCompactionEvent) => {
		events.push(event);
	});
	const owner = new BackgroundCompactionOwner({
		target: createCompactionJobTarget(manager, () => ({ generation: 0, disposed, writeBlocked: blocked })),
		requestRunStop,
		refresh,
		notifyApplied,
		emit,
		reportError,
	});
	const completion = deferred<CompactionJobResult>();
	let request!: CompactionJobRequest;
	const start = (instructions?: string, summarize?: CompactionJobSummarizer) =>
		owner.start({
			source: "user",
			settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 10 },
			customInstructions: instructions,
			summarize: (value) => {
				request = value;
				return summarize ? summarize(value) : completion.promise;
			},
			accountUsage,
		});
	return {
		owner,
		manager,
		events,
		emit,
		completion,
		start,
		requestRunStop,
		refresh,
		notifyApplied,
		accountUsage,
		reportError,
		get request() {
			return request;
		},
		finish: () => completion.resolve({ summary: "summary", firstKeptEntryId: kept, tokensBefore: 0 }),
		dispose: () => {
			disposed = true;
			owner.cancel("disposed");
		},
		block: () => {
			blocked = true;
		},
	};
}
const install = { hardThreshold: 10000, carry: "desired" as const };

describe("unexposed background compaction owner", () => {
	it("starts without writing, observes readiness and installs before awaited notifications", async () => {
		const f = setup();
		const original = f.manager.getBranch();
		const started = f.start();
		expect(started.status).toBe("started");
		expect(f.manager.getBranch()).toEqual(original);
		await f.owner.flushEvents();
		expect(f.events.map((event) => event.phase)).toEqual(["started"]);
		f.finish();
		await f.owner.current?.done;
		await f.owner.flushEvents();
		expect(f.events.map((event) => event.phase)).toEqual(["started", "ready"]);
		const notifications = deferred<void>();
		f.notifyApplied.mockImplementation(async () => {
			expect(f.owner.current).toBeUndefined();
			expect(f.refresh).toHaveBeenCalledTimes(1);
			expect(f.manager.getLeafEntry()?.type).toBe("compaction");
			await notifications.promise;
		});
		const applied = f.owner.installReady(install);
		expect(f.owner.current).toBeUndefined();
		expect(f.owner.cancel()).toBe(false);
		f.dispose();
		notifications.resolve();
		expect((await applied).status).toBe("applied");
		await f.owner.flushEvents();
		expect(f.events.map((event) => event.phase)).toEqual(["started", "ready", "applied"]);
	});

	it.each(["internal", "external"] as const)(
		"releases a signal-ignoring summary on %s wait abort, without cancelling it",
		async (kind) => {
			const f = setup();
			f.start();
			const signal = new AbortController();
			const waiting = f.owner.waitAndInstall({ ...install, waitSignal: signal.signal });
			expect(f.owner.current?.phase).toBe("claimed");
			expect(f.start().status).toBe("already");
			if (kind === "internal") f.owner.abortWait();
			else signal.abort();
			expect(await waiting).toEqual({ status: "aborted" });
			expect(f.requestRunStop).toHaveBeenCalledTimes(1);
			expect(f.owner.current?.phase).toBe("summarizing");
			expect(f.request.signal.aborted).toBe(false);
			expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
			await f.owner.flushEvents();
			expect(f.events.map((event) => event.phase)).toEqual(["started", "waiting", "released"]);
			f.finish();
			await f.owner.current?.done;
			expect((await f.owner.installReady(install)).status).toBe("applied");
		},
	);

	it("pre-aborted wait stops before claiming or sending a waiting event", async () => {
		const f = setup();
		f.start();
		const signal = new AbortController();
		signal.abort();
		expect(await f.owner.waitAndInstall({ ...install, waitSignal: signal.signal })).toEqual({ status: "aborted" });
		expect(f.owner.current?.phase).toBe("summarizing");
		expect(f.requestRunStop).toHaveBeenCalledTimes(1);
		await f.owner.flushEvents();
		expect(f.events.map((event) => event.phase)).toEqual(["started"]);
		f.owner.cancel();
	});

	it.each(["cancel", "dispose"] as const)("%s stops a claimed wait even if the hook never settles", async (kind) => {
		const f = setup();
		f.start();
		const waiting = f.owner.waitAndInstall(install);
		if (kind === "cancel") expect(f.owner.cancel()).toBe(true);
		else f.dispose();
		expect(f.requestRunStop).toHaveBeenCalledTimes(1);
		expect(await waiting).toEqual({ status: "aborted" });
		expect(f.owner.current).toBeUndefined();
		f.finish();
		await f.owner.flushEvents();
		expect(f.manager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(f.events.filter((event) => event.phase === "discarded")).toHaveLength(1);
		expect(f.events.some((event) => event.phase === "applied" || event.phase === "ready")).toBe(false);
	});

	it("waits and commits once; a second waiter cannot steal a claim", async () => {
		const f = setup();
		f.start();
		const waiting = f.owner.waitAndInstall(install);
		expect(await f.owner.waitAndInstall(install)).toEqual({ status: "unavailable" });
		expect(await f.owner.installReady(install)).toEqual({ status: "unavailable" });
		f.finish();
		expect((await waiting).status).toBe("applied");
		expect(f.notifyApplied).toHaveBeenCalledTimes(1);
		expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("readiness and Esc in the same tick cannot commit after the stop", async () => {
		const f = setup();
		f.start();
		const waiting = f.owner.waitAndInstall(install);
		f.finish();
		f.owner.abortWait();
		expect(await waiting).toEqual({ status: "aborted" });
		expect(f.owner.current?.phase).toBe("ready");
		expect(f.notifyApplied).not.toHaveBeenCalled();
	});

	it("refuses a ready job if the owner became write-blocked during the wait", async () => {
		const f = setup();
		f.start();
		const waiting = f.owner.waitAndInstall(install);
		f.block();
		f.finish();
		expect(await waiting).toEqual({ status: "aborted" });
		expect(f.requestRunStop).toHaveBeenCalledTimes(1);
		expect(f.notifyApplied).not.toHaveBeenCalled();
	});

	it("accounts every discarded call, including late usage from a cancelled hook", async () => {
		const f = setup();
		f.start();
		f.request.onUsage(usage);
		expect(f.accountUsage).not.toHaveBeenCalled();
		f.owner.cancel();
		expect(f.accountUsage).toHaveBeenCalledTimes(1);
		f.request.onUsage(usage);
		expect(f.accountUsage).toHaveBeenCalledTimes(2);
		f.finish();
		await f.owner.flushEvents();
		expect(f.accountUsage.mock.calls.map((call) => call[0])).toEqual([usage, usage]);
	});

	it("does not duplicate applied usage, but journals a late call separately", async () => {
		const f = setup();
		f.start();
		f.request.onUsage(usage);
		f.finish();
		await f.owner.current?.done;
		await f.owner.installReady(install);
		expect(f.accountUsage).not.toHaveBeenCalled();
		expect(f.manager.getLeafEntry()).toMatchObject({ type: "compaction", usage });
		f.request.onUsage(usage);
		expect(f.accountUsage).toHaveBeenCalledExactlyOnceWith(usage);
	});

	it("accounts aggregate-only late results once, without reviving a cancelled job", async () => {
		const f = setup();
		f.start();
		const kept = f.request.preparation.firstKeptEntryId;
		f.owner.cancel();
		f.completion.resolve({ summary: "late", firstKeptEntryId: kept, tokensBefore: 0, usage });
		await f.completion.promise;
		await f.owner.flushEvents();
		expect(f.accountUsage).toHaveBeenCalledExactlyOnceWith(usage);
		expect(f.owner.current).toBeUndefined();
	});

	it("supersedes changed instructions but leaves identical requests alone", async () => {
		const f = setup();
		const first = f.start("one");
		expect(f.start("one")).toMatchObject({ status: "already", jobId: "jobId" in first ? first.jobId : "" });
		const second = f.start("two");
		expect(second.status).toBe("started");
		expect(second).not.toEqual(first);
		await f.owner.flushEvents();
		expect(f.events.filter((event) => event.phase === "discarded")).toMatchObject([{ cause: "superseded" }]);
		f.owner.cancel();
	});

	it("reports failed writes, accounts usage once and never emits applied", async () => {
		const f = setup();
		f.start();
		f.request.onUsage(usage);
		f.finish();
		await f.owner.current?.done;
		vi.spyOn(f.manager, "_persist").mockImplementation(() => {
			throw new Error("disk failure");
		});
		await expect(f.owner.installReady(install)).rejects.toThrow("disk failure");
		await f.owner.flushEvents();
		expect(f.accountUsage).toHaveBeenCalledExactlyOnceWith(usage);
		expect(f.events.filter((event) => event.phase === "failed")).toMatchObject([{ cause: "write-failed" }]);
		expect(f.events.some((event) => event.phase === "applied")).toBe(false);
		expect(f.notifyApplied).not.toHaveBeenCalled();
	});

	it("owns the job before a synchronous launch hook can cancel it", async () => {
		const f = setup();
		let cancelled = false;
		const result = f.start(undefined, () => {
			cancelled = f.owner.cancel();
			return f.completion.promise;
		});
		expect(cancelled).toBe(true);
		expect(result.status).toBe("started");
		expect(f.owner.current).toBeUndefined();
		f.finish();
		await f.owner.flushEvents();
		expect(f.events.map((event) => event.phase)).toEqual(["started", "discarded"]);
	});

	it("normalizes synchronous launch failure without losing usage or terminal events", async () => {
		const f = setup();
		f.start(undefined, (request) => {
			request.onUsage(usage);
			throw new Error("launch failure");
		});
		await f.owner.current?.done;
		await f.owner.flushEvents();
		expect(f.owner.current).toBeUndefined();
		expect(f.events.map((event) => event.phase)).toEqual(["started", "failed"]);
		expect(f.accountUsage).toHaveBeenCalledExactlyOnceWith(usage);
	});

	it.each(["sync", "async"])("carries %s summarizer errors through terminal views and events", async (kind) => {
		const f = setup();
		const error = Object.assign(new Error("overloaded"), { status: 529 });
		f.start(undefined, () => {
			if (kind === "sync") throw error;
			return Promise.reject(error);
		});
		const job = f.owner.current;
		await job?.done;
		await f.owner.flushEvents();
		expect(job).toMatchObject({ phase: "failed", cause: "summarization-failed", errorMessage: "529 overloaded" });
		expect(f.events.at(-1)).toMatchObject({
			phase: "failed",
			cause: "summarization-failed",
			errorMessage: "529 overloaded",
		});
	});

	it("keeps admission held through the applied event", async () => {
		const f = setup();
		f.start();
		f.finish();
		await f.owner.current?.done;
		await f.owner.flushEvents();
		const reached = deferred<void>();
		const release = deferred<void>();
		f.emit.mockImplementation(async (event) => {
			f.events.push(event);
			if (event.phase === "applied") {
				reached.resolve();
				await release.promise;
			}
		});
		let settled = false;
		const installing = f.owner.installReady(install).then((value) => {
			settled = true;
			return value;
		});
		await reached.promise;
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(f.owner.cancel()).toBe(false);
		release.resolve();
		expect((await installing).status).toBe("applied");
	});

	it("does not double-count calls arriving from the applied abort listener", async () => {
		const f = setup();
		f.start();
		const request = f.request;
		request.onUsage(usage);
		request.signal.addEventListener("abort", () => request.onUsage(usage));
		f.finish();
		await f.owner.current?.done;
		await f.owner.installReady(install);
		expect(f.manager.getLeafEntry()).toMatchObject({ type: "compaction", usage });
		expect(f.accountUsage).toHaveBeenCalledExactlyOnceWith(usage);
	});

	it("keeps reentrant late usage behind its receipt", () => {
		const f = setup();
		f.start();
		const request = f.request;
		request.onUsage(usage);
		let reentered = false;
		f.accountUsage.mockImplementation(() => {
			if (!reentered) {
				reentered = true;
				request.onUsage(usage);
			}
		});
		f.owner.cancel();
		expect(f.accountUsage).toHaveBeenCalledTimes(2);
	});

	it("keeps applied terminal even when a post-commit notification rejects", async () => {
		const f = setup();
		f.start();
		f.finish();
		await f.owner.current?.done;
		f.notifyApplied.mockRejectedValue(new Error("listener failed"));
		await expect(f.owner.installReady(install)).rejects.toThrow("listener failed");
		await f.owner.flushEvents();
		expect(f.owner.current).toBeUndefined();
		expect(f.events.filter((event) => event.phase === "applied")).toHaveLength(1);
		expect(f.events.some((event) => event.phase === "failed")).toBe(false);
	});
});
