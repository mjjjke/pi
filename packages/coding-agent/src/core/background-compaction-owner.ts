/**
 * Unexposed session-side orchestration for background jobs. AgentSession integration
 * supplies the non-waiting run stop, captured summarizer/accounting and notifications.
 * This module never starts a provider request or falls through to blocking compaction.
 */
import type { Usage } from "@earendil-works/pi-ai/compat";
import {
	BackgroundCompactionJobs,
	type CompactionJobInstallOptions,
	type CompactionJobStartResult,
	type CompactionJobTarget,
	type CompactionJobView,
} from "./compaction-job.ts";
import { combineUsage } from "./usage-totals.ts";

export interface BackgroundCompactionEvent {
	type: "session_background_compaction";
	jobId: string;
	source: string;
	phase: "started" | "ready" | "waiting" | "released" | "applied" | "discarded" | "failed";
	cause?: string;
	usage?: Usage;
}

interface OwnedJob {
	view: CompactionJobView;
	customInstructions?: string;
	accountUsage(usage: Usage): void;
	accounted: number;
	accounting: boolean;
	terminalEvent?: Promise<void>;
}

interface BackgroundCompactionOwnerOptions {
	target: CompactionJobTarget;
	/** Synchronous and non-waiting. Must not call abort() or await this owner. */
	requestRunStop(): void;
	/** Synchronous context refresh, after the append and irreversible terminal transition. */
	refresh(): void;
	/** Standing delivery and session_compact, in today's order; applied follows below. */
	notifyApplied(entryId: string, job: CompactionJobView): Promise<void>;
	emit(event: BackgroundCompactionEvent): Promise<void>;
	/** Synchronous disposal starts terminal handlers before invalidating their runtime. */
	emitBeforeInvalidation?(event: BackgroundCompactionEvent): Promise<void>;
	/** Synchronous public observers, before disposal can disconnect them. Never awaited. */
	observe?(event: BackgroundCompactionEvent): void;
	reportError(error: unknown): void;
}

export type BackgroundCompactionInstallResult =
	| Awaited<ReturnType<BackgroundCompactionJobs["install"]>>
	| { status: "aborted" };

export class BackgroundCompactionOwner {
	private readonly jobs: BackgroundCompactionJobs;
	private readonly options: BackgroundCompactionOwnerOptions;
	private owned?: OwnedJob;
	private waiter?: { job: OwnedJob; controller: AbortController; stopped: boolean };
	private events: Promise<void> = Promise.resolve();
	private readonly notifications = new Set<AbortController>();

	constructor(options: BackgroundCompactionOwnerOptions) {
		this.options = options;
		this.jobs = new BackgroundCompactionJobs(options.target);
	}

	get current(): CompactionJobView | undefined {
		return this.jobs.current;
	}

	start(
		options: Parameters<BackgroundCompactionJobs["start"]>[0] & { accountUsage(usage: Usage): void },
	): CompactionJobStartResult {
		if (
			this.jobs.current &&
			this.jobs.current.phase !== "claimed" &&
			this.owned?.customInstructions !== options.customInstructions
		) {
			this.cancel("superseded");
		}
		return this.jobs.start({
			...options,
			summarize: (request) => {
				const view = this.jobs.current;
				if (!view) throw new Error("Background job missing during launch");
				const owned: OwnedJob = {
					view,
					customInstructions: options.customInstructions,
					accountUsage: options.accountUsage,
					accounted: 0,
					accounting: false,
				};
				this.owned = owned;
				this.emit(owned, "started");
				void view.done.then(() => {
					if (view.terminal) this.observeTerminal(owned);
					else if (view.phase === "ready") this.emit(owned, "ready");
				});
				let calls = 0;
				const onUsage = (usage: Usage) => {
					calls++;
					request.onUsage(usage);
					if (owned.view.terminal) this.accountTerminalUsage(owned);
				};
				// Capture the summarizer synchronously, including before its first auth await.
				// Ownership and the started event precede reentrant launch-hook work.
				try {
					if (view.terminal) return Promise.reject(view.signal.reason);
					return options.summarize({ ...request, onUsage }).then((value) => {
						// The primitive's aggregate fallback otherwise bypasses late-call accounting.
						if (calls === 0 && value.usage) onUsage(value.usage);
						return value;
					});
				} catch (error) {
					return Promise.reject(error);
				}
			},
		});
	}

	/** Lifecycle disposal releases post-commit notification work, never its receipt. */
	abortNotifications(): void {
		for (const controller of this.notifications) controller.abort();
	}

	/** Abort only the wait. Its continuation sets the run-stop latch before release. */
	abortWait(): void {
		this.waiter?.controller.abort();
	}

	cancel(cause = "user-cancel", jobId?: string, beforeInvalidation = false): boolean {
		const owned = this.owned;
		if (!owned || this.jobs.current !== owned.view || (jobId !== undefined && owned.view.id !== jobId)) return false;
		// Q14: set the latch before a cancellation can release a wait or wake its done.
		if (this.waiter?.job === owned) {
			this.stopWait(this.waiter);
			this.waiter.controller.abort();
		}
		const cancelled = this.jobs.cancel(cause, jobId);
		if (cancelled) this.observeTerminal(owned, beforeInvalidation);
		return cancelled;
	}

	/** Ordinary request gates adopt only ready jobs, never somebody else's claim. */
	async installReady(options: CompactionJobInstallOptions): Promise<BackgroundCompactionInstallResult> {
		const owned = this.owned;
		if (!owned || this.jobs.current !== owned.view || owned.view.phase !== "ready") return { status: "unavailable" };
		if (options.waitSignal?.aborted) return { status: "aborted" };
		return this.install(owned, options);
	}

	/** L3 / --now only. A second waiter cannot steal a synchronous claim. */
	async waitAndInstall(
		options: CompactionJobInstallOptions & { resolveHardThreshold?: () => number },
	): Promise<BackgroundCompactionInstallResult> {
		if (options.waitSignal?.aborted) {
			this.options.requestRunStop();
			return { status: "aborted" };
		}
		const owned = this.owned;
		if (!owned || this.jobs.current !== owned.view || this.waiter || !this.jobs.claim())
			return { status: "unavailable" };
		const waiter = { job: owned, controller: new AbortController(), stopped: false };
		this.waiter = waiter;
		this.emit(owned, "waiting");
		try {
			await raceBackgroundWait(owned.view.done, [owned.view.signal, waiter.controller.signal, options.waitSignal]);
			// Check signals again: done and Esc may have resolved in the same microtask.
			if (owned.view.terminal || waiter.controller.signal.aborted || options.waitSignal?.aborted) {
				this.stopWait(waiter);
				if (this.jobs.current === owned.view) {
					this.jobs.release();
					this.emit(owned, "released");
				}
				return { status: "aborted" };
			}
			// Clear before post-commit hooks: cancellation cannot turn an append into a stop.
			this.waiter = undefined;
			return await this.install(owned, {
				...options,
				hardThreshold: options.resolveHardThreshold?.() ?? options.hardThreshold,
				waitSignal: waiter.controller.signal,
			});
		} finally {
			if (this.waiter === waiter) this.waiter = undefined;
		}
	}

	/** Test/host observation only; launch/install never await event handlers here. */
	async flushEvents(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.events;
			await pending;
		} while (pending !== this.events);
	}

	private stopWait(waiter: NonNullable<BackgroundCompactionOwner["waiter"]>): void {
		if (waiter.stopped) return;
		waiter.stopped = true;
		this.options.requestRunStop();
	}

	private async install(
		owned: OwnedJob,
		options: CompactionJobInstallOptions,
	): Promise<BackgroundCompactionInstallResult> {
		let result: ReturnType<BackgroundCompactionJobs["install"]>;
		try {
			result = this.jobs.install(options);
		} catch (error) {
			this.observeTerminal(owned);
			throw error;
		}
		if (result.status !== "applied") {
			if (owned.view.terminal) this.observeTerminal(owned);
			return result;
		}
		// The primitive's appliedUsageCount is frozen before abort listeners can
		// report a late call; those extra calls do not belong to the committed entry.
		this.accountTerminalUsage(owned);
		const notification = new AbortController();
		this.notifications.add(notification);
		try {
			this.options.refresh();
			await raceBackgroundWait(this.options.notifyApplied(result.entryId, owned.view), [notification.signal]);
		} finally {
			try {
				// Even disposal or a rejecting listener cannot undo or hide the append.
				await raceBackgroundWait(this.observeTerminal(owned, false, notification.signal), [notification.signal]);
			} finally {
				this.notifications.delete(notification);
			}
		}
		return result;
	}

	private accountTerminalUsage(owned: OwnedJob): void {
		if (!owned.view.terminal || owned.accounting) return;
		owned.accounting = true;
		try {
			owned.accounted = Math.max(owned.accounted, owned.view.appliedUsageCount);
			while (owned.accounted < owned.view.usage.length) {
				// Reentrant usage waits behind this receipt, never attempts it twice.
				owned.accountUsage(owned.view.usage[owned.accounted]);
				owned.accounted++;
			}
		} catch (error) {
			// No receipt: retain the index, so a later accounting pass retries it.
			this.report(error);
		} finally {
			owned.accounting = false;
		}
	}

	private observeTerminal(
		owned: OwnedJob,
		beforeInvalidation = false,
		notificationSignal?: AbortSignal,
	): Promise<void> {
		if (!owned.view.terminal) return Promise.resolve();
		this.accountTerminalUsage(owned);
		if (owned.terminalEvent) return owned.terminalEvent;
		if (this.owned === owned) this.owned = undefined;
		const phase = owned.view.phase;
		if (phase === "applied" || phase === "failed" || phase === "discarded") {
			owned.terminalEvent = this.emit(owned, phase, beforeInvalidation, notificationSignal);
		}
		return owned.terminalEvent ?? Promise.resolve();
	}

	private emit(
		owned: OwnedJob,
		phase: BackgroundCompactionEvent["phase"],
		beforeInvalidation = false,
		notificationSignal?: AbortSignal,
	): Promise<void> {
		const { view } = owned;
		const usage = view.usage;
		const event: BackgroundCompactionEvent = {
			type: "session_background_compaction",
			jobId: view.id,
			source: view.source,
			phase,
			...(view.cause ? { cause: view.cause } : {}),
			...(usage.length ? { usage: usage.reduce(combineUsage) } : {}),
		};
		const dispatch = (
			beforeInvalidation && this.options.emitBeforeInvalidation
				? this.options.emitBeforeInvalidation(event)
				: this.events.then(() => raceBackgroundWait(this.options.emit(event), [notificationSignal]))
		).catch((error) => this.report(error));
		this.events = beforeInvalidation ? Promise.all([this.events, dispatch]).then(() => {}) : dispatch;
		try {
			this.options.observe?.(structuredClone(event));
		} catch (error) {
			this.report(error);
		}
		return dispatch;
	}

	private report(error: unknown): void {
		try {
			this.options.reportError(error);
		} catch {
			// Observers cannot reject job.done, strand the event pump or undo a receipt.
		}
	}
}

/** Resolves on readiness or any stop; never waits for a signal-ignoring hook. */
async function raceBackgroundWait(done: Promise<void>, signals: (AbortSignal | undefined)[]): Promise<void> {
	const listeners: { signal: AbortSignal; listener: () => void }[] = [];
	try {
		await new Promise<void>((resolve, reject) => {
			// Attach before checking pre-aborted signals, including notification rejections.
			void done.then(resolve, reject);
			for (const signal of signals) {
				if (!signal) continue;
				if (signal.aborted) {
					resolve();
					return;
				}
				const listener = () => resolve();
				listeners.push({ signal, listener });
				signal.addEventListener("abort", listener, { once: true });
			}
		});
	} finally {
		for (const { signal, listener } of listeners) signal.removeEventListener("abort", listener);
	}
}
