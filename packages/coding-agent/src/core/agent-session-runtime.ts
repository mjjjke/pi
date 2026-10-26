import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession, CwdCarry } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import {
	assertCwdTarget,
	type ChangeCwdOptions,
	type ChangeCwdResult,
	type CwdChangeHandler,
	cwdAppliedNotice,
	resolveCwdTarget,
} from "./cwd-change.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import {
	type CwdChangePlan,
	createSessionSetupManager,
	type SessionDirResolver,
	SessionManager,
	type SessionSetupManager,
} from "./session-manager.ts";
import { hasTrustRequiringProjectResources } from "./trust-manager.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
	carry?: CwdCarry;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private sessionDirResolver?: SessionDirResolver;
	private ambientCwd?: (cwd: string) => void;
	private resolveTargetTrust?: (cwd: string, context?: ProjectTrustContext) => Promise<boolean>;
	private changingCwd?: string;
	private cwdChangeHandler?: CwdChangeHandler;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	setSessionDirResolver(resolver?: SessionDirResolver): void {
		this.sessionDirResolver = resolver;
	}

	setAmbientCwdHandler(handler?: (cwd: string) => void): void {
		this.ambientCwd = handler;
	}

	setResolveTargetTrust(handler?: (cwd: string, context?: ProjectTrustContext) => Promise<boolean>): void {
		this.resolveTargetTrust = handler;
	}

	/** Bind only in modes that can apply and render a deferred transition. */
	setCwdChangeHandler(handler?: CwdChangeHandler): void {
		this.cwdChangeHandler = handler;
		this.bindCwdChange();
	}

	private bindCwdChange(): void {
		this.session.setCwdChangeHandler(this.cwdChangeHandler, (path) => {
			if (this.changingCwd) throw new Error(`Not changed: a change to ${this.changingCwd} is already pending.`);
			if (!path.trim()) throw new Error("Not changed: cd needs a directory in args.");
			const manager = this.session.sessionManager;
			const to = resolveCwdTarget(path, manager.getCwd());
			assertCwdTarget(to);
			const plan = manager.planCwdChange(to, this.sessionDirResolver);
			manager.preflightCwdChange(plan);
			return plan.to;
		});
	}

	async changeCwd(target: string, options: ChangeCwdOptions): Promise<ChangeCwdResult> {
		if (this.changingCwd)
			return { changed: false, error: `A working-directory change to ${this.changingCwd} is in progress.` };
		const session = this.session;
		const manager = session.sessionManager;
		const pending = session.pendingCwdChange;
		if (pending && pending.requestId !== options.requestId)
			return { changed: false, error: `A working-directory change to ${pending.to} is in progress.` };
		const error = session.getCwdChangeError();
		if (error) return { changed: false, error };
		let plan: CwdChangePlan;
		try {
			const to = resolveCwdTarget(target, manager.getCwd());
			assertCwdTarget(to);
			plan = manager.planCwdChange(to, this.sessionDirResolver);
			manager.preflightCwdChange(plan);
		} catch (error) {
			return { changed: false, error: error instanceof Error ? error.message : String(error) };
		}
		const slot = session.reserveCwdChange(plan.to, options.requestId);
		if (!slot) return { changed: false, error: "cancelled" };
		this.changingCwd = plan.to;
		let release: (() => void) | undefined;
		try {
			const trusted =
				slot.trusted ??
				(this.resolveTargetTrust
					? await this.resolveTargetTrust(plan.to, options.projectTrustContextFactory?.(plan.to))
					: !hasTrustRequiringProjectResources(plan.to));
			slot.trusted = trusted;
			if (this.session !== session || session.pendingCwdChange !== slot)
				return { changed: false, error: "cancelled" };
			const revalidation = session.getCwdChangeError();
			if (revalidation) return { changed: false, error: revalidation };
			if (!trusted) return { changed: false, error: "untrusted" };
			try {
				assertCwdTarget(plan.to);
				manager.preflightCwdChange(plan);
				slot.state = "applying";
				release = session.beginCwdTransition();
				const hasSnapshot = session.messages.some((message) => message.role === "system");
				const notice = cwdAppliedNotice(plan.from, plan.to);
				const entries = manager.buildCwdChangeEntries(plan, {
					...options,
					notice: hasSnapshot ? notice : undefined,
				});
				const result = manager.relocate(plan, entries);
				// From publication onwards failures are fatal runtime failures or warnings, never a rollback.
				let warning = result.warning;
				await emitSessionShutdownEvent(session.extensionRunner, {
					type: "session_shutdown",
					reason: "cwd",
					targetCwd: plan.to,
					targetSessionFile: plan.sessionFile,
				});
				this.beforeSessionInvalidate?.();
				const carry = session.takeCwdCarry();
				if (!hasSnapshot && carry.stagedContent.length > 0)
					carry.stagedContent.push({
						message: {
							role: "custom",
							customType: "pi.cwd",
							content: notice,
							display: true,
							details: { kind: "applied", from: plan.from, to: plan.to, transitionId: entries[0]!.id },
							timestamp: Date.now(),
						},
						announced: false,
					});
				session.dispose({ keepSessionResources: true });
				try {
					this.ambientCwd?.(plan.to);
				} catch (error) {
					warning = [warning, `cd: ambient working directory could not change (${String(error)})`]
						.filter(Boolean)
						.join("\n");
				}
				this.apply(
					await this.createRuntime({
						cwd: plan.to,
						agentDir: this.services.agentDir,
						sessionManager: manager,
						carry,
						sessionStartEvent: {
							type: "session_start",
							reason: "cwd",
							previousCwd: plan.from,
							previousSessionFile: plan.previousSessionFile,
						},
						projectTrustContext: options.projectTrustContextFactory?.(plan.to),
					}),
				);
				const destination = this.session;
				const continueRun = slot.source === "model" ? destination.prepareCwdContinuation() : undefined;
				await this.finishSessionReplacement(options.withSession);
				if (this.session === destination && !slot.continuationCancelled) continueRun?.();
				return { changed: true, from: plan.from, to: plan.to, ...(warning ? { warning } : {}) };
			} catch (error) {
				if (manager.getCwd() === plan.to) throw error;
				return { changed: false, error: error instanceof Error ? error.message : String(error) };
			}
		} catch (error) {
			if (manager.getCwd() === plan.to) throw error;
			return { changed: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			release?.();
			session.releaseUserCwdChange(slot);
			this.changingCwd = undefined;
		}
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		// Settle any active response first so the aborted turn (including tool
		// results) is persisted to the outgoing session before it is replaced.
		await this.session.prepareForSessionReplacement();
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		this.beforeSessionInvalidate?.();
		this.session.dispose();
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
		this.bindCwdChange();
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionSetupManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		await this.teardownCurrent("new", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}),
		);
		if (options?.setup) {
			await options.setup(createSessionSetupManager(this.session.sessionManager));
			this.session.refreshContext();
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				this.apply(
					await this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			if (!existsSync(currentSessionFile)) {
				throw new Error("This session has not been saved yet. Send a message before cloning or forking it.");
			}
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager;
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		let destinationPath = join(sessionDir, basename(resolvedPath));
		const sourceAlreadyStored = resolve(destinationPath) === resolvedPath;
		if (!sourceAlreadyStored) {
			const { name, ext } = parse(destinationPath);
			let suffix = 1;
			while (existsSync(destinationPath)) {
				destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`);
			}
		}
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		if (!sourceAlreadyStored) {
			copyFileSync(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	/**
	 * Emit `session_shutdown` and dispose the session. With `handlersDispatched`, the caller has
	 * already dispatched `session_shutdown` (for example with a time limit): dispose without
	 * running the handlers again.
	 */
	async dispose(options?: { handlersDispatched?: boolean }): Promise<void> {
		this.session.closeAdmission();
		this.session.cancelCwdChange();
		if (!options?.handlersDispatched) {
			await emitSessionShutdownEvent(this.session.extensionRunner, {
				type: "session_shutdown",
				reason: "quit",
			});
		}
		this.beforeSessionInvalidate?.();
		this.session.dispose();
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
