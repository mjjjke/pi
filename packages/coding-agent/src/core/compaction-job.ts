/**
 * Unexposed background compaction primitive. No AgentSession, commands, events or I/O.
 * The owner supplies synchronous journal operations and the launch-time summarizer.
 */
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai/compat";
import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	compact,
	estimateProjectedContextTokens,
	prepareCompaction,
} from "./compaction/compaction.ts";
import { COMPACTION_BOUNDARY_TEXT_V2 } from "./messages.ts";
import {
	buildSessionProjection,
	type CompactionEntry,
	type SessionEntry,
	type SessionManager,
} from "./session-manager.ts";

import { combineUsage } from "./usage-totals.ts";

// Same approved literal as every other new compaction. Old entries retain their own text.
export const BACKGROUND_COMPACTION_BOUNDARY = COMPACTION_BOUNDARY_TEXT_V2;

export interface CompactionJobBranch {
	branch: SessionEntry[];
	sessionId: string;
	sessionFile: string | undefined;
	/** Owner increments on every tree move (even away/back), reload or import. */
	generation: number;
	disposed: boolean;
	writeBlocked: boolean;
}

export interface CompactionJobResult extends CompactionResult {
	fromHook?: boolean;
}

export interface CompactionJobEntryInput extends CompactionJobResult {
	boundary: string;
	details: { background: { jobId: string; source: string; launchedAt: number } };
	carry: "desired" | "delivered";
}

/**
 * Adapter to SessionManager's pure entry builder and synchronous append transaction.
 * buildEntry must carry system/standing state exactly as append does, without writing.
 * append must persist precisely the supplied candidate (including id/time/boundary),
 * or throw with the manager's existing rollback/sticky-error semantics.
 * Neither function may invoke user code or change the branch except for that append.
 */
export interface CompactionJobTarget {
	read(): CompactionJobBranch;
	buildEntry(input: CompactionJobEntryInput): CompactionEntry;
	append(candidate: CompactionEntry): string;
}

/** Internal manager binding; the session owner supplies lifecycle state, not journal internals. */
export function createCompactionJobTarget(
	manager: SessionManager,
	state: () => { generation: number; disposed: boolean; writeBlocked?: boolean },
): CompactionJobTarget {
	return {
		read: () => {
			const current = state();
			return {
				...current,
				branch: manager.getBranch(),
				sessionId: manager.getSessionId(),
				sessionFile: manager.getSessionFile(),
				writeBlocked: current.writeBlocked === true || manager.getPersistenceError() !== undefined,
			};
		},
		buildEntry: (input) =>
			manager.buildCompactionEntry(
				input.summary,
				input.firstKeptEntryId,
				input.tokensBefore,
				input.details,
				input.fromHook,
				input.usage,
				{ carry: input.carry, boundary: input.boundary },
			),
		append: (candidate) => manager.appendCompaction(candidate),
	};
}

export interface CompactionJobRequest {
	preparation: CompactionPreparation;
	branch: SessionEntry[];
	signal: AbortSignal;
	customInstructions?: string;
	/** Per-call accounting, including failed or discarded summaries. Memory only. */
	onUsage(usage: Usage): void;
}
export type CompactionJobSummarizer = (request: CompactionJobRequest) => Promise<CompactionJobResult>;

/** Capture routing/model/auth policy at launch, not from mutable session state later. */
export function createCompactionJobSummarizer(
	...request: Parameters<typeof compact> extends [CompactionPreparation, ...infer Request] ? Request : never
): CompactionJobSummarizer {
	// The adapter's custom instructions and signal belong to the job, not a blocking controller.
	const captured = [...request] as typeof request;
	captured[0] = structuredClone(request[0]);
	captured[2] = request[2] ? { ...request[2] } : undefined;
	captured[7] = request[7] ? { ...request[7] } : undefined;
	captured[8] = request[8] ? { ...request[8] } : undefined;
	return ({ preparation, customInstructions, signal, onUsage }) => {
		const args = [...captured] as typeof request;
		args[3] = customInstructions;
		args[4] = signal;
		args[11] = onUsage;
		return compact(preparation, ...args);
	};
}

export type CompactionJobPhase = "summarizing" | "ready" | "claimed" | "applied" | "failed" | "discarded";
export interface CompactionJobView {
	readonly id: string;
	readonly source: string;
	readonly launchedAt: number;
	readonly phase: CompactionJobPhase;
	readonly terminal: boolean;
	readonly cause?: string;
	/** Summarizer failure text, including provider status when available. */
	readonly errorMessage?: string;
	readonly entryId?: string;
	readonly signal: AbortSignal;
	/** Resolves on ready or terminal, never rejects (even for signal-ignoring hooks). */
	readonly done: Promise<void>;
	readonly usage: readonly Usage[];
	/** Calls included in the applied entry; later calls need separate journal accounting. */
	readonly appliedUsageCount: number;
}
interface Job {
	view: CompactionJobView;
	id: string;
	source: string;
	launchedAt: number;
	phase: CompactionJobPhase;
	terminal: boolean;
	cause?: string;
	errorMessage?: string;
	entryId?: string;
	controller: AbortController;
	done: Promise<void>;
	settle(): void;
	usage: Usage[];
	appliedUsageCount: number;
	identity: CompactionJobBranch;
	preparation: CompactionPreparation;
	prefix: Map<string, string>;
	launchLeafId: string;
	latestCompactionId?: string;
	result?: CompactionJobResult;
}
export type CompactionJobStartResult =
	| { status: "started" | "already"; jobId: string; phase: CompactionJobPhase }
	| { status: "unavailable"; reason: string };
export type CompactionJobPreview =
	| { status: "preview"; candidate: CompactionEntry; tokensBefore: number; tokensAfter: number }
	| { status: "discarded"; cause: string }
	| { status: "unavailable" };
export interface CompactionJobInstallOptions {
	/** Recompute for the check-site model immediately before this call: window - reserve. */
	hardThreshold: number;
	carry?: "desired" | "delivered";
	/** A stopped waiter may not commit; its summary remains available for a later boundary. */
	waitSignal?: AbortSignal;
}

export class BackgroundCompactionJobs {
	private target: CompactionJobTarget;
	private job?: Job;

	constructor(target: CompactionJobTarget) {
		this.target = target;
	}

	get current(): CompactionJobView | undefined {
		return this.job?.view;
	}

	start(options: {
		source: string;
		settings: CompactionSettings;
		summarize: CompactionJobSummarizer;
		customInstructions?: string;
		blockingCompaction?: boolean;
	}): CompactionJobStartResult {
		if (this.job) return { status: "already", jobId: this.job.id, phase: this.job.phase };
		const identity = structuredClone(this.target.read());
		if (identity.disposed || identity.writeBlocked || options.blockingCompaction) {
			return { status: "unavailable", reason: "session-unavailable" };
		}
		const preparation = prepareCompaction(identity.branch, structuredClone(options.settings));
		if (!preparation) return { status: "unavailable", reason: "nothing-to-summarize" };
		const projected = buildSessionProjection(identity.branch).entries.filter((entry) => entry.part !== "boundary");
		const cut = projected.findIndex((entry) => entry.sourceEntry.id === preparation.firstKeptEntryId);
		const prefix = new Map(projected.slice(0, cut).map((entry) => [entry.sourceEntry.id, JSON.stringify(entry)]));
		const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		if (!hasClosedToolCalls(messages)) return { status: "unavailable", reason: "open-tool-call" };
		let settle!: () => void;
		const done = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const job: Job = {
			id: randomUUID(),
			source: options.source,
			launchedAt: Date.now(),
			phase: "summarizing",
			terminal: false,
			controller: new AbortController(),
			done,
			settle,
			usage: [],
			appliedUsageCount: 0,
			identity,
			preparation,
			prefix,
			launchLeafId: identity.branch[identity.branch.length - 1].id,
			latestCompactionId: identity.branch.findLast((entry) => entry.type === "compaction")?.id,
			get view() {
				return view;
			},
		};
		const view: CompactionJobView = Object.freeze({
			id: job.id,
			source: job.source,
			launchedAt: job.launchedAt,
			get phase() {
				return job.phase;
			},
			get terminal() {
				return job.terminal;
			},
			get cause() {
				return job.cause;
			},
			get errorMessage() {
				return job.errorMessage;
			},
			get entryId() {
				return job.entryId;
			},
			signal: job.controller.signal,
			done,
			get usage() {
				return structuredClone(job.usage);
			},
			get appliedUsageCount() {
				return job.appliedUsageCount;
			},
		});
		this.job = job;
		// Call synchronously so the session's request snapshot is captured before start returns.
		try {
			const completion = options.summarize({
				preparation: structuredClone(preparation),
				branch: structuredClone(identity.branch),
				signal: job.controller.signal,
				customInstructions: options.customInstructions,
				onUsage: (usage) => {
					job.usage.push(structuredClone(usage));
				},
			});
			void completion
				.then((result) => {
					// Late completions may account usage in memory, but never write or revive a job.
					if (result.usage && job.usage.length === 0) job.usage.push(structuredClone(result.usage));
					if (job.terminal) return;
					const cause = this.invalidCause(job);
					if (cause) {
						this.terminate(job, "discarded", cause);
						return;
					}
					if (!result.summary.trim() || result.firstKeptEntryId !== preparation.firstKeptEntryId) {
						this.terminate(job, "discarded", "extension-invalid");
						return;
					}
					job.result = structuredClone(result);
					if (job.phase !== "claimed") job.phase = "ready";
					job.settle();
				})
				.catch((error: unknown) => {
					if (!job.terminal) this.failSummary(job, error);
				});
		} catch (error) {
			this.failSummary(job, error);
		}
		return { status: "started", jobId: job.id, phase: job.phase };
	}

	claim(): boolean {
		if (!this.job || this.job.phase === "claimed") return false;
		this.job.phase = "claimed";
		return true;
	}

	/** A cancelled wait releases the claim, not the summary. */
	release(): void {
		if (this.job?.phase === "claimed") this.job.phase = this.job.result ? "ready" : "summarizing";
	}

	cancel(cause = "user-cancel", jobId?: string): boolean {
		if (!this.job || (jobId !== undefined && this.job.id !== jobId)) return false;
		this.terminate(this.job, "discarded", cause);
		return true;
	}

	/** Inspection only; install always rebuilds the preview, never accepts a stale one. */
	preview(options: CompactionJobInstallOptions): CompactionJobPreview {
		const job = this.job;
		if (!job?.result) return { status: "unavailable" };
		const cause = this.invalidCause(job);
		if (cause) return { status: "discarded", cause };
		const { branch } = this.target.read();
		const tokensBefore = estimateProjectedContextTokens(buildSessionProjection(branch), branch).tokens;
		const result = job.result;
		const details = result.details && typeof result.details === "object" ? result.details : {};
		const input: CompactionJobEntryInput = {
			...result,
			usage: job.usage.length > 0 ? job.usage.reduce(combineUsage) : result.usage,
			tokensBefore,
			boundary: BACKGROUND_COMPACTION_BOUNDARY,
			details: { ...details, background: { jobId: job.id, source: job.source, launchedAt: job.launchedAt } },
			carry: options.carry ?? "delivered",
		};
		const candidate = this.target.buildEntry(structuredClone(input));
		const candidateBranch = [...branch, candidate];
		const tokensAfter = estimateProjectedContextTokens(
			buildSessionProjection(candidateBranch),
			candidateBranch,
		).tokens;
		if (tokensAfter >= tokensBefore) return { status: "discarded", cause: "not-smaller" };
		if (!Number.isFinite(options.hardThreshold) || tokensAfter >= options.hardThreshold) {
			return { status: "discarded", cause: "insufficient" };
		}
		return { status: "preview", candidate, tokensBefore, tokensAfter };
	}

	/** No await or notification between the fresh preview, append and terminal transition. */
	install(
		options: CompactionJobInstallOptions,
	):
		| Exclude<CompactionJobPreview, { status: "preview" }>
		| { status: "applied"; entryId: string; job: CompactionJobView } {
		const job = this.job;
		if (!job?.result) return { status: "unavailable" };
		if (options.waitSignal?.aborted) {
			this.release();
			return { status: "unavailable" };
		}
		this.claim();
		try {
			const preview = this.preview(options);
			if (preview.status !== "preview") {
				if (preview.status === "discarded") this.terminate(job, "discarded", preview.cause);
				return preview;
			}
			const usageCount = job.usage.length;
			const entryId = this.target.append(preview.candidate);
			// Linearization: no user code/await before the slot is cleared irrevocably.
			job.appliedUsageCount = usageCount;
			job.entryId = entryId;
			this.terminate(job, "applied");
			return { status: "applied", entryId, job: job.view };
		} catch (error) {
			this.terminate(job, "failed", "write-failed");
			throw error; // Owner refuses the request using the journal's sticky failure.
		}
	}

	private invalidCause(job: Job): string | undefined {
		const current = this.target.read();
		const original = job.identity;
		if (current.disposed || current.writeBlocked) return "session-unavailable";
		if (
			current.sessionId !== original.sessionId ||
			current.sessionFile !== original.sessionFile ||
			current.generation !== original.generation ||
			!current.branch.some((entry) => entry.id === job.launchLeafId) ||
			current.branch.findLast((entry) => entry.type === "compaction")?.id !== job.latestCompactionId ||
			!current.branch.some((entry) => entry.id === job.preparation.firstKeptEntryId)
		)
			return "superseded";
		const launchIds = new Set(original.branch.map((entry) => entry.id));
		if (
			current.branch.some(
				(entry) => entry.type === "context_edit" && !launchIds.has(entry.id) && job.prefix.has(entry.targetId),
			)
		)
			return "prefix-edit";
		const projected = buildSessionProjection(current.branch).entries.filter((entry) => entry.part !== "boundary");
		for (const [id, bytes] of job.prefix) {
			const entry = projected.find((item) => item.sourceEntry.id === id);
			if (!entry || JSON.stringify(entry) !== bytes) return "prefix-edit";
		}
		return undefined;
	}

	private failSummary(job: Job, error: unknown): void {
		if (job.terminal) return;
		const details = error !== null && typeof error === "object" ? error : undefined;
		const message =
			details && "message" in details && typeof details.message === "string" ? details.message : String(error);
		const status = details && "status" in details ? details.status : undefined;
		job.errorMessage =
			(typeof status === "number" || typeof status === "string") && !message.includes(String(status))
				? `${status} ${message}`
				: message;
		this.terminate(job, "failed", "summarization-failed");
	}

	private terminate(job: Job, phase: "applied" | "failed" | "discarded", cause?: string): void {
		if (job.terminal) return;
		job.phase = phase;
		job.cause = cause;
		job.terminal = true;
		if (this.job === job) this.job = undefined;
		job.settle();
		// Abort listeners may be reentrant; terminal state and cleared slot precede them.
		job.controller.abort();
	}
}

function hasClosedToolCalls(messages: AgentMessage[]): boolean {
	const results = new Set(
		messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
	);
	return messages.every(
		(message) =>
			message.role !== "assistant" ||
			message.content.every((block) => block.type !== "toolCall" || results.has(block.id)),
	);
}
