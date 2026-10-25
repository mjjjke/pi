import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import { BackgroundCompactionJobs, createCompactionJobTarget } from "../src/core/compaction-job.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(persist = false) {
	const dir = mkdtempSync(join(tmpdir(), "compaction-job-"));
	dirs.push(dir);
	const manager = persist ? SessionManager.create(dir, dir) : SessionManager.inMemory(dir);
	manager.appendMessage({ role: "system", content: "checkpoint", timestamp: 1 });
	manager.appendStandingInstruction("mode", "desired");
	manager.appendMessage({ role: "developer", content: "delivered", timestamp: 1 }, { standingKey: "mode" });
	const old = manager.appendMessage({ role: "user", content: "x".repeat(16000), timestamp: 2 });
	const kept = manager.appendMessage({ role: "user", content: "kept suffix".repeat(20), timestamp: 3 });
	let generation = 0;
	const jobs = new BackgroundCompactionJobs(
		createCompactionJobTarget(manager, () => ({ generation, disposed: false })),
	);
	const start = () =>
		jobs.start({
			source: "user",
			settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 10 },
			summarize: async () => ({ summary: "summary", firstKeptEntryId: kept, tokensBefore: 0 }),
		});
	return {
		manager,
		jobs,
		old,
		kept,
		start,
		move: () => {
			generation++;
		},
	};
}

describe("manager-backed background compaction candidate", () => {
	it.each(["desired", "delivered"] as const)(
		"preview carries %s state and commits exactly one current-leaf entry",
		async (carry) => {
			const f = setup(true);
			f.start();
			await f.jobs.current?.done;
			const later = f.manager.appendCustomMessageEntry("task", "task completed", false);
			const before = readFileSync(f.manager.getSessionFile()!, "utf8");
			const preview = f.jobs.preview({ hardThreshold: 10000, carry });
			if (preview.status !== "preview") throw new Error("missing preview");
			expect(readFileSync(f.manager.getSessionFile()!, "utf8")).toBe(before);
			expect(preview.candidate.systemMessage?.content).toBe("checkpoint");
			expect(preview.candidate.standing?.[0].message.content).toBe(carry);
			const append = vi.spyOn(f.manager, "appendCompaction");
			const job = f.jobs.current;
			job?.signal.addEventListener("abort", () => {
				expect(job.phase).toBe("applied");
				expect(f.jobs.current).toBeUndefined();
				expect(f.jobs.cancel()).toBe(false);
			});
			const result = f.jobs.install({ hardThreshold: 10000, carry });
			expect(result.status).toBe("applied");
			expect(append).toHaveBeenCalledTimes(1);
			const candidate = append.mock.calls[0][0];
			expect(typeof candidate).toBe("object");
			expect(f.manager.getLeafEntry()).toEqual(candidate);
			expect(f.manager.getLeafEntry()?.parentId).toBe(later);
			expect(f.manager.buildSessionProjection().messages.map((m) => m.role)).toEqual([
				"system",
				"developer",
				"compactionSummary",
				"user",
				"custom",
				"compactionBoundary",
			]);
			const written = readFileSync(f.manager.getSessionFile()!, "utf8").slice(before.length).trim().split("\n");
			expect(written).toHaveLength(1);
			expect(JSON.parse(written[0])).toEqual(JSON.parse(JSON.stringify(candidate)));
			const reopened = SessionManager.open(f.manager.getSessionFile()!);
			expect(reopened.buildSessionProjection()).toEqual(f.manager.buildSessionProjection());
		},
	);
	it("preserves a custom frozen-cut summarizer's hook provenance and details", async () => {
		const f = setup();
		f.jobs.start({
			source: "user",
			settings: { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 10 },
			summarize: async () => ({
				summary: "hook",
				firstKeptEntryId: f.kept,
				tokensBefore: 1,
				fromHook: true,
				details: { artifact: "index" },
			}),
		});
		await f.jobs.current?.done;
		f.jobs.install({ hardThreshold: 10000 });
		expect(f.manager.getLeafEntry()).toMatchObject({
			type: "compaction",
			fromHook: true,
			details: { artifact: "index", background: { source: "user" } },
		});
	});
	it("rejects a stale built candidate without appending", () => {
		const f = setup();
		const candidate = f.manager.buildCompactionEntry("summary", f.kept, 100);
		f.manager.appendMessage({ role: "user", content: "later", timestamp: 4 });
		const leaf = f.manager.getLeafId();
		expect(() => f.manager.appendCompaction(candidate)).toThrow("stale compaction candidate");
		expect(f.manager.getLeafId()).toBe(leaf);
	});
	it("invalidates actual manager branch movement and away/back via the owner generation", async () => {
		const f = setup();
		f.start();
		await f.jobs.current?.done;
		f.manager.branch(f.old);
		f.move();
		f.manager.branch(f.kept);
		f.move();
		expect(f.jobs.install({ hardThreshold: 10000 })).toMatchObject({ status: "discarded", cause: "superseded" });
		expect(f.manager.getBranch().some((e) => e.type === "compaction")).toBe(false);
	});
	it("rolls back a failed manager append and never marks the job applied", async () => {
		const f = setup();
		f.start();
		await f.jobs.current?.done;
		const job = f.jobs.current;
		const branch = f.manager.getBranch();
		vi.spyOn(f.manager, "_persist").mockImplementation(() => {
			throw new Error("disk failure");
		});
		expect(() => f.jobs.install({ hardThreshold: 10000 })).toThrow("disk failure");
		expect(f.manager.getBranch()).toEqual(branch);
		expect(job?.phase).toBe("failed");
	});
});
