import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { type CompactionResult, DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import {
	BackgroundCompactionJobs,
	type CompactionJobRequest,
	type CompactionJobTarget,
} from "../src/core/compaction-job.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { buildSessionProjection, type CompactionEntry, type SessionEntry } from "../src/core/session-manager.ts";

const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 10 };
function user(id: string, text: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-25T00:00:00Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function fixture() {
	const branch: SessionEntry[] = [
		user("old", "x".repeat(12000), null),
		user("kept", "kept state: tests passed".repeat(4), "old"),
	];
	let generation = 0;
	let blocked = false;
	let disposed = false;
	let sessionId = "session";
	let sessionFile: string | undefined = "/session.jsonl";
	const append = vi.fn((entry: CompactionEntry) => {
		branch.push(entry);
		return entry.id;
	});
	const target: CompactionJobTarget = {
		read: () => ({ branch, generation, sessionId, sessionFile, writeBlocked: blocked, disposed }),
		buildEntry: (input) => ({
			...input,
			type: "compaction",
			id: "candidate",
			parentId: branch.at(-1)?.id ?? null,
			timestamp: "2026-10-25T01:00:00Z",
			standing: [],
		}),
		append,
	};
	const pending = deferred<CompactionResult>();
	const summarize = vi.fn((_request: CompactionJobRequest) => pending.promise);
	const jobs = new BackgroundCompactionJobs(target);
	const start = () => jobs.start({ source: "user", settings, summarize });
	const ready = async (summary = "Run tests") => {
		pending.resolve({ summary, firstKeptEntryId: "kept", tokensBefore: 1 });
		await jobs.current?.done;
	};
	return {
		branch,
		jobs,
		target,
		pending,
		summarize,
		start,
		ready,
		append,
		generation: () => generation++,
		block: () => {
			blocked = true;
		},
		dispose: () => {
			disposed = true;
		},
		session: () => {
			sessionId = "other";
		},
		file: () => {
			sessionFile = undefined;
		},
	};
}

describe("unexposed background compaction jobs", () => {
	it("launch freezes the cut and writes nothing; a claimed job owns the slot", async () => {
		const f = fixture();
		const before = JSON.stringify(buildSessionProjection(f.branch).messages);
		expect(f.start().status).toBe("started");
		expect(f.jobs.current?.phase).toBe("summarizing");
		expect(JSON.stringify(buildSessionProjection(f.branch).messages)).toBe(before);
		expect(f.jobs.claim()).toBe(true);
		expect(f.start().status).toBe("already");
		expect(f.append).not.toHaveBeenCalled();
		await f.ready();
		expect(f.jobs.current?.phase).toBe("claimed");
		f.jobs.release();
		expect(f.jobs.current?.phase).toBe("ready");
	});
	it("summarizes a detached preparation and frozen branch", async () => {
		const f = fixture();
		f.start();
		const request = f.summarize.mock.calls[0]?.[0];
		expect(request?.preparation.firstKeptEntryId).toBe("kept");
		f.branch.push(user("later", "later", "kept"));
		expect(request?.branch.map((entry) => entry.id)).toEqual(["old", "kept"]);
		await f.ready();
	});
	it("installs one entry at the current leaf; kept and post-launch bytes stay identical", async () => {
		const f = fixture();
		f.start();
		f.branch.push(user("later", "later state: complete", "kept"));
		const kept = buildSessionProjection(f.branch)
			.messages.slice(1)
			.map((m) => JSON.stringify(m));
		await f.ready();
		const job = f.jobs.current;
		const result = f.jobs.install({ hardThreshold: 10000 });
		expect(result.status).toBe("applied");
		expect(f.append).toHaveBeenCalledTimes(1);
		const entry = f.branch.at(-1) as CompactionEntry;
		expect(entry.parentId).toBe("later");
		expect(entry.firstKeptEntryId).toBe("kept");
		expect(entry.tokensBefore).toBeGreaterThan(3000);
		expect(entry.details).toMatchObject({ background: { jobId: job?.id, source: "user" } });
		const messages = buildSessionProjection(f.branch).messages;
		expect(messages.slice(1, 3).map((m) => JSON.stringify(m))).toEqual(kept);
		expect(messages.at(-1)).toMatchObject({ role: "compactionBoundary" });
		expect(entry.boundary).toBe(
			"Compaction boundary (not a request). Any messages between the compaction summary above and this point were kept from before the compaction; they may contain later updates than the summary, and those updates take precedence. The state they report describes when they were sent. Context-size readings from before the compaction no longer describe the current context; its size is unknown until a newer reading. Messages after this point are new. Standing instructions and running tasks are not affected by this boundary.",
		);
		expect(f.jobs.current).toBeUndefined();
		expect(job?.phase).toBe("applied");
		expect(f.jobs.cancel()).toBe(false);
	});
	it("preserves kept custom/image/tool payloads on projection and LLM conversion", async () => {
		const f = fixture();
		f.start();
		f.branch.push({
			type: "custom_message",
			id: "task",
			parentId: "kept",
			timestamp: "2026-10-25T00:01:00Z",
			customType: "task",
			display: false,
			content: [
				{ type: "text", text: "updated task state" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			details: { task: "a" },
		});
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "signed thought", thinkingSignature: "opaque" },
				{ type: "toolCall", id: "call", name: "read", arguments: { path: "a" } },
			],
			api: "openai-responses",
			model: "test",
			provider: "openai",
			stopReason: "toolUse",
			timestamp: 2,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		f.branch.push({
			type: "message",
			id: "assistant",
			parentId: "task",
			timestamp: "2026-10-25T00:02:00Z",
			message: assistant,
		});
		f.branch.push({
			type: "message",
			id: "result",
			parentId: "assistant",
			timestamp: "2026-10-25T00:03:00Z",
			message: {
				role: "toolResult",
				toolCallId: "call",
				toolName: "read",
				content: [{ type: "text", text: "result" }],
				isError: false,
				timestamp: 3,
			},
		});
		const kept = buildSessionProjection(f.branch).messages.slice(1);
		const before = JSON.stringify(kept);
		const llm = JSON.stringify(convertToLlm(kept));
		await f.ready();
		f.jobs.install({ hardThreshold: 10000 });
		const after = buildSessionProjection(f.branch).messages.slice(1, -1);
		expect(JSON.stringify(after)).toBe(before);
		expect(JSON.stringify(convertToLlm(after))).toBe(llm);
	});
	it("releases a pending claim without cancelling it and rejects a stale cancel id", async () => {
		const f = fixture();
		f.start();
		f.jobs.claim();
		f.jobs.release();
		expect(f.jobs.current?.phase).toBe("summarizing");
		expect(f.jobs.cancel("user-cancel", "other-job")).toBe(false);
		await f.ready();
		expect(f.jobs.current?.phase).toBe("ready");
	});
	it("rejects a changed branch at summary completion, before becoming ready", async () => {
		const f = fixture();
		f.start();
		const job = f.jobs.current;
		f.generation();
		await f.ready();
		expect(job?.phase).toBe("discarded");
		expect(f.jobs.current).toBeUndefined();
	});
	it("refuses a blocking-compaction launch and settles a synchronous summarizer throw", async () => {
		const f = fixture();
		expect(f.jobs.start({ source: "user", settings, summarize: f.summarize, blockingCompaction: true }).status).toBe(
			"unavailable",
		);
		const result = f.jobs.start({
			source: "user",
			settings,
			summarize: () => {
				throw new Error("sync");
			},
		});
		expect(result).toMatchObject({ status: "started", phase: "failed" });
		expect(f.jobs.current).toBeUndefined();
	});
	it.each(["generation", "session", "file", "dispose", "block"] as const)(
		"refuses invalid %s identity/state",
		async (change) => {
			const f = fixture();
			f.start();
			await f.ready();
			f[change]();
			expect(f.jobs.install({ hardThreshold: 10000 }).status).toBe("discarded");
			expect(f.append).not.toHaveBeenCalled();
		},
	);
	it("invalidates a branch change, including away and back via generation", async () => {
		const f = fixture();
		f.start();
		await f.ready();
		f.branch.pop();
		expect(f.jobs.install({ hardThreshold: 10000 })).toMatchObject({ status: "discarded", cause: "superseded" });
		const g = fixture();
		g.start();
		await g.ready();
		g.generation();
		g.generation();
		expect(g.jobs.install({ hardThreshold: 10000 }).status).toBe("discarded");
	});
	it("rejects another compaction", async () => {
		const f = fixture();
		f.start();
		await f.ready();
		f.branch.push({
			type: "compaction",
			id: "other",
			parentId: "kept",
			timestamp: "now",
			firstKeptEntryId: "kept",
			summary: "other",
			tokensBefore: 1,
		});
		expect(f.jobs.install({ hardThreshold: 10000 }).status).toBe("discarded");
	});
	it.each(["old", "kept"])("edits to %s are checked against S, not the kept suffix", async (targetId) => {
		const f = fixture();
		f.start();
		await f.ready();
		f.branch.push({
			type: "context_edit",
			id: "edit",
			parentId: "kept",
			timestamp: "now",
			targetId,
			replacement: { content: "updated" },
		});
		expect(f.jobs.install({ hardThreshold: 10000 })).toMatchObject(
			targetId === "old" ? { status: "discarded", cause: "prefix-edit" } : { status: "applied" },
		);
	});
	it("rejects in-place prefix mutation but permits model/thinking metadata", async () => {
		const f = fixture();
		f.start();
		await f.ready();
		(f.branch[0] as { message: { content: string } }).message.content = "changed";
		expect(f.jobs.install({ hardThreshold: 10000 }).status).toBe("discarded");
		const g = fixture();
		g.start();
		await g.ready();
		g.branch.push({
			type: "thinking_level_change",
			id: "thinking",
			parentId: "kept",
			timestamp: "now",
			thinkingLevel: "high",
		});
		expect(g.jobs.install({ hardThreshold: 10000 }).status).toBe("applied");
	});
	it.each(["not-smaller", "insufficient"])("rejects a %s preview without append or relaunch", async (cause) => {
		const f = fixture();
		f.start();
		await f.ready(cause === "not-smaller" ? "s".repeat(16000) : "summary");
		expect(f.jobs.install({ hardThreshold: cause === "insufficient" ? 1 : 10000 })).toMatchObject({
			status: "discarded",
			cause,
		});
		expect(f.append).not.toHaveBeenCalled();
		expect(f.summarize).toHaveBeenCalledTimes(1);
	});
	it("uses the threshold at install, not launch; an exact H is insufficient", async () => {
		const f = fixture();
		f.start();
		await f.ready();
		const preview = f.jobs.preview({ hardThreshold: 10000 });
		if (preview.status !== "preview") throw new Error("expected preview");
		expect(f.jobs.install({ hardThreshold: preview.tokensAfter })).toMatchObject({
			status: "discarded",
			cause: "insufficient",
		});
	});
	it("cancel is idempotent, settles done and ignores late completion", async () => {
		const f = fixture();
		f.start();
		f.jobs.claim();
		const job = f.jobs.current;
		expect(f.jobs.cancel("user-cancel")).toBe(true);
		expect(f.jobs.cancel()).toBe(false);
		await job?.done;
		expect(job?.signal.aborted).toBe(true);
		await f.ready();
		await Promise.resolve();
		expect(job?.phase).toBe("discarded");
		expect(f.jobs.current).toBeUndefined();
		expect(f.append).not.toHaveBeenCalled();
	});
	it("summarizer failure settles without rejecting", async () => {
		const f = fixture();
		f.start();
		const job = f.jobs.current;
		f.pending.reject(new Error("failure"));
		await expect(job?.done).resolves.toBeUndefined();
		expect(job?.phase).toBe("failed");
		expect(f.jobs.current).toBeUndefined();
	});
	it.each(["", "different-cut"])("rejects an invalid summarizer/hook result %s", async (invalid) => {
		const f = fixture();
		f.start();
		const job = f.jobs.current;
		f.pending.resolve({ summary: invalid ? "summary" : " ", firstKeptEntryId: invalid || "kept", tokensBefore: 1 });
		await job?.done;
		expect(job?.phase).toBe("discarded");
		expect(job?.cause).toBe("extension-invalid");
	});
	it("refuses empty/blocked launches and open tool calls in S", () => {
		const f = fixture();
		f.branch.length = 0;
		expect(f.start().status).toBe("unavailable");
		const g = fixture();
		g.block();
		expect(g.start().status).toBe("unavailable");
		const h = fixture();
		h.branch.splice(1, 0, {
			type: "message",
			id: "call",
			parentId: "old",
			timestamp: "now",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tool", name: "read", arguments: {} }],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				stopReason: "toolUse",
				timestamp: 1,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} satisfies AssistantMessage,
		});
		h.branch[2].parentId = "call";
		expect(h.start()).toMatchObject({ status: "unavailable", reason: "open-tool-call" });
		expect(h.summarize).not.toHaveBeenCalled();
	});
	it.each(["aborted", "error"] as const)("ignores unexecuted tool calls of %s assistant messages", (stopReason) => {
		const h = fixture();
		h.branch.splice(1, 0, {
			type: "message",
			id: "call",
			parentId: "old",
			timestamp: "now",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "tool", name: "read", arguments: {} }],
				api: "openai-responses",
				provider: "openai",
				model: "test",
				stopReason,
				timestamp: 1,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} satisfies AssistantMessage,
		});
		h.branch[2].parentId = "call";
		expect(h.start().status).toBe("started");
		expect(h.summarize).toHaveBeenCalled();
	});
	it("inspection candidates cannot mutate the frozen ready result", async () => {
		const f = fixture();
		f.start();
		const usage = {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		f.pending.resolve({ summary: "summary", firstKeptEntryId: "kept", tokensBefore: 1, usage });
		await f.jobs.current?.done;
		const preview = f.jobs.preview({ hardThreshold: 10000 });
		if (preview.status !== "preview" || !preview.candidate.usage) throw new Error("expected usage");
		preview.candidate.usage.totalTokens = 999;
		f.jobs.install({ hardThreshold: 10000 });
		expect((f.branch.at(-1) as CompactionEntry).usage?.totalTokens).toBe(12);
	});
	it("keeps a ready job when a stopped wait attempts install", async () => {
		const f = fixture();
		f.start();
		await f.ready();
		f.jobs.claim();
		const controller = new AbortController();
		controller.abort();
		expect(f.jobs.install({ hardThreshold: 10000, waitSignal: controller.signal })).toEqual({
			status: "unavailable",
		});
		expect(f.jobs.current?.phase).toBe("ready");
		expect(f.append).not.toHaveBeenCalled();
		expect(f.jobs.install({ hardThreshold: 10000 }).status).toBe("applied");
	});
	it("accounts every observed call on the single applied entry, without aggregate double counting", async () => {
		const f = fixture();
		f.start();
		const usage = {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const request = f.summarize.mock.calls[0][0];
		request.onUsage(usage);
		request.onUsage(usage);
		f.pending.resolve({ summary: "summary", firstKeptEntryId: "kept", tokensBefore: 1, usage });
		await f.jobs.current?.done;
		expect(f.jobs.current?.usage).toEqual([usage, usage]);
		f.jobs.install({ hardThreshold: 10000 });
		expect((f.branch.at(-1) as CompactionEntry).usage?.totalTokens).toBe(24);
	});
	it("keeps per-call usage when a split summary fails or completes after cancel", async () => {
		const f = fixture();
		f.start();
		const job = f.jobs.current;
		const usage = {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		f.summarize.mock.calls[0][0].onUsage(usage);
		f.jobs.cancel();
		f.pending.resolve({ summary: "late", firstKeptEntryId: "kept", tokensBefore: 1, usage });
		await job?.done;
		await Promise.resolve();
		expect(job?.usage).toEqual([usage]);
		expect(f.append).not.toHaveBeenCalled();
	});
	it("append failure is propagated for the caller's sticky write guard, never applied", async () => {
		const f = fixture();
		f.start();
		await f.ready();
		const job = f.jobs.current;
		f.append.mockImplementation(() => {
			throw new Error("disk");
		});
		expect(() => f.jobs.install({ hardThreshold: 10000 })).toThrow("disk");
		expect(job?.phase).toBe("failed");
		expect(f.jobs.current).toBeUndefined();
	});
});
