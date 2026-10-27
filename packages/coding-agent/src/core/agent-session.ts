/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	type Agent,
	type AgentContext,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type AgentToolCallOutcome,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type PrepareNextTurnContext,
	runToolCall,
	type StreamFn,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	contentText,
	getCurrentSystemMessage,
	getToolStateChanges,
	retryDelayMs,
	supportsMidConversationSystemMessages,
} from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AuthResult,
	DeveloperMessage,
	ImageContent,
	Model,
	ProviderHeaders,
	SystemMessage,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { processImage } from "../utils/image-process.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import {
	type BackgroundCompactionEvent,
	type BackgroundCompactionInstallResult,
	BackgroundCompactionOwner,
} from "./background-compaction-owner.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import { generateBugReportSummary } from "./bug-report.ts";
import type { CacheWarmer, CacheWarmingStatus } from "./cache-warmer.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateProjectedContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { type CompactionJobStartResult, createCompactionJobTarget } from "./compaction-job.ts";
import {
	isCompactionNoticeSource,
	outsideCompactionNoticeScope,
	withCompactionNoticeScope,
} from "./compaction-notice-scope.ts";
import {
	type CwdChangeHandler,
	cwdRequestRejection,
	type PendingCwdChange,
	type RequestCwdChangeResult,
} from "./cwd-change.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type AgentActivityOutcome,
	type BoundaryContextPreview,
	type ContextUsage,
	type ExecuteToolOptions,
	type ExtensionCommandContextActions,
	type ExtensionError,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type QueueDeveloperMessageOptions,
	type QueueDeveloperMessageResult,
	type ReplacedSessionContext,
	type RequestBashHandoverOptions,
	type RequestNewSessionOptions,
	type RequestNewSessionResult,
	type SendMessageOptions,
	type SendMessageReceipt,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionBoundaryDraft,
	type SessionCompactEvent,
	type SessionCompactFailedEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type StandingInstructionInfo,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolExposure,
	type ToolInfo,
	type ToolLoadout,
	type TreePreparation,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { type BeforeAgentStartTrigger, emitSessionShutdownEvent } from "./extensions/runner.ts";
import { createToolNameMatcher, isMcpToolName } from "./mcp-servers.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { NestedToolCallRunner } from "./nested-tool-calls.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import {
	type BranchSummaryEntry,
	type CompactionEntry,
	type ContextEditEntry,
	getLatestCompactionEntry,
	type SessionEntry,
	SessionManager,
	type SessionProjection,
} from "./session-manager.ts";
import {
	applyToolModifiers,
	type CacheWarmingMode,
	DEFAULT_TOOL_NAMES,
	type SettingsManager,
} from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo, isSyntheticPath, type SourceInfo } from "./source-info.ts";
import {
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, combineUsage, createUsageTotals } from "./usage-totals.ts";
import {
	findLatestResponse,
	getBranchSelection,
	getVirtualModelState,
	isVirtualModel,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "./virtual-models.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Tool execution events of calls a tool made through `ctx.executeTool()` carry `parentToolCallId`. */
type WithParentToolCallId<E> = E extends {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}
	? E & { parentToolCallId?: string }
	: E;

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| BackgroundCompactionEvent
	| WithParentToolCallId<Exclude<AgentEvent, { type: "agent_end" }>>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled"; aborted: boolean }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "bash_execution_update"; id?: string; delta: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Keeps the prompt cache entry of the last session request warm. */
	cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/**
	 * Whether the initial tools come from the `defaultTools` setting. When true, a resumed session
	 * replaces them with the loadout its transcript records, with `defaultToolModifiers` applied, and
	 * reload activates tools newly added to the setting. Tools removed from it stay active.
	 */
	usesDefaultTools?: boolean;
	/**
	 * `+name`/`-name` entries applied on top of the `defaultTools` setting, from `--tools`. Reload
	 * applies them to the reloaded setting too, so a removed tool stays removed.
	 */
	defaultToolModifiers?: string[];
	/**
	 * Optional allowlist of tool names or patterns (`*` matches any characters). When provided, only
	 * matching tools are exposed. A non-empty list without `mcp__` entries also keeps MCP tools
	 * registered for codemode and tool_search; only tool_search can declare them. An empty list
	 * exposes no tools.
	 */
	allowedToolNames?: string[];
	/** Optional denylist of tool names or patterns. When provided, matching tools are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	carry?: CwdCarry;
}

/** Runtime-owned, move-only state transferred to the same conversation at another cwd. */
export interface CwdCarry {
	model?: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
	previousDefaultTools: string[];
	previousDefaultActiveToolNames: string[];
	stagedContent: StagedContent[];
	stagedInstructions: PendingInstruction[];
	nextTurn: CustomMessage[];
	heldSettings: { images: { blockImages: boolean }; codemode: { mode: "on" | "only" } };
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export type QueuedInputDisposition = "handled" | "queued";
export type PromptDisposition = QueuedInputDisposition | "started";

/**
 * Owner and event of the runtime error reported when a session write fails after a run's terminal
 * events (its run-end flush, §3.6). Not an extension failure: UIs label it as a plain error.
 */
export const SESSION_PERSISTENCE_REPORT = { extensionPath: "<runtime>", event: "session_persistence" } as const;

/** Whether a reported error is the core session write failure (`SESSION_PERSISTENCE_REPORT`). */
export function isSessionPersistenceReport(error: Pick<ExtensionError, "extensionPath" | "event">): boolean {
	return (
		error.extensionPath === SESSION_PERSISTENCE_REPORT.extensionPath &&
		error.event === SESSION_PERSISTENCE_REPORT.event
	);
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to dispatch extension commands and expand skill commands and prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe how an accepted prompt was dispatched. Not called if the prompt is rejected. */
	preflightResult?: (disposition: PromptDisposition) => void;
	/**
	 * Observer of the journal outcome of the starting message of the run this prompt starts (public;
	 * interactive and print modes use it to restore or fail unsent prompts).
	 *
	 * - Called once per started run, with `persisted: true` only if that message's own append
	 *   succeeded (an in-memory session counts). It says nothing about the run's success or about
	 *   filesystem durability, and `false` covers both a failed append and a run that ended before it.
	 * - Called when the run's agent loop has ended (after its agent_end), before the remaining
	 *   finalization and before agent_settled.
	 * - Not called for handled or queued input, or when the prompt is rejected before its run starts.
	 * - A prompt submitted during agent_settled runs after that settlement: its `prompt()` resolves
	 *   at once, and this observer is called later, when the deferred run ends.
	 * - An exception it throws is ignored.
	 */
	onStartMessagePersistence?: (outcome: StartMessagePersistence) => void;
}

/** Journal outcome of a run's starting message (see `PromptOptions.onStartMessagePersistence`). */
export interface StartMessagePersistence {
	/** The starting message as sent (after input hooks, skill and template expansion). */
	readonly message: AgentMessage;
	/** Whether that message's own append to the session succeeded. */
	readonly persisted: boolean;
	/** Gate 1 stopped before the starting message was admitted. */
	readonly stopped?: true;
}

/** A developer instruction queued with queueDeveloperMessage() and not yet committed. */
/** A start deferred by a readiness barrier: the barrier currently holding it waits for its release. */
interface DeferredStart {
	/** Move to the barrier installed now, releasing the hold of the barrier it was deferred by. */
	follow(): void;
	release(): void;
}

interface PendingInstruction {
	pendingId: string;
	message: DeveloperMessage;
	onCommit?: (entryId: string) => void;
	state: "pending" | "committing" | "committed";
	entryId?: string;
	/** Extension runner that created it (extension API); undefined for SDK callers. */
	owner?: ExtensionRunner;
}

/** A prepared run: the system patch (if any), the starting message and before_agent_start messages. */
interface PreparedRun {
	update: SystemMessage | undefined;
	start: AgentMessage;
	returned: AgentMessage[];
}

/** One delivered standing value (keyed developer). */
type CompactionCarry = "desired" | "delivered";

/** Detached launch policy. Auth is deliberately absent and resolved for each physical call. */
interface SummarizationRequestContext {
	messages: AgentMessage[];
	thinkingLevel: ThinkingLevel;
	streamFunction: StreamFn;
	transport: Agent["transport"];
	retry: ReturnType<SettingsManager["getRetrySettings"]>;
}

interface StandingDelivery {
	key: string;
	content: string | TextContent[];
	message: DeveloperMessage;
	entryId: string;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
			: item,
	);
}

function sameStandingContent(a: string | TextContent[], b: string | TextContent[]): boolean {
	return canonicalJson(a) === canonicalJson(b);
}

/** Content held until the bootstrap commit (B). */
interface OwnedCustomMessage {
	handle: CustomMessage;
	key: string;
	lane: "passive" | "notice" | "steer" | "followUp" | "trigger";
	state: "buffered" | "queued" | "held" | "admitted";
	/** A passive travels in its predecessor's admission batch, never in an Agent queue. */
	riderOf?: OwnedCustomMessage;
	delivery?: "steer" | "followUp";
	onReceipt?: (receipt: SendMessageReceipt) => void;
}

interface StagedContent {
	message: CustomMessage | BashExecutionMessage;
	/** message_start/message_end were already emitted at send. */
	announced: boolean;
	onReceipt?: (receipt: SendMessageReceipt) => void;
}

function isBlankInstruction(content: string | TextContent[]): boolean {
	return typeof content === "string"
		? content.trim().length === 0
		: content.every((part) => part.text.trim().length === 0);
}

/** Options for model/thinking mutations. */
export interface ModelMutationOptions {
	/** Persist the new value to global defaults. Defaults to session-only. */
	persist?: boolean;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

interface PendingNewSessionRequest {
	options?: RequestNewSessionOptions;
	resolve: (result: { cancelled: boolean }) => void;
	reject: (error: unknown) => void;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	/** The starting message of the active run and whether its append succeeded. */
	/** The starting message of the active run and whether its append succeeded. */
	private _runStart: { message: AgentMessage; persisted: boolean } | undefined;
	/** Only developer instructions may commit immediately while before_agent_start handlers run. */
	private _isPreparingRun = false;
	/** Set while bindExtensions() or reload() runs startup; runs wait for it (readiness barrier). */
	private _readiness: Promise<void> | undefined = undefined;
	/**
	 * Starts deferred by the current barrier. Each is released once it reserves its run, settles, is
	 * about to run extension code (command handler, input hooks, async auth), or meets a newer barrier
	 * (it then belongs to that one), so the binder returns after a startup-triggered run is reserved
	 * without ever waiting on extension code or on a later barrier (no deadlock).
	 */
	private _readinessStarters: Set<Promise<void>> | undefined = undefined;
	/**
	 * Prompts deferred by a readiness barrier, until they settle (including their command, input and
	 * auth preflight). Print mode drains them after binding; the binder itself never waits for them.
	 */
	private _deferredPrompts = new Set<Promise<void>>();
	/** bindExtensions() ran at least once, so reload() re-runs startup. */
	private _extensionsBound = false;
	private _agentRunAbortRequested = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Identity, not display text, determines whether input still belongs to an Agent queue. */
	private _queuedUserInput = new Map<AgentMessage, { text: string; lane: "steering" | "followUp" }>();
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** Insertion order is arrival order. Only an append or staging receipt retires an item. */
	private readonly _customStore = new Map<AgentMessage, OwnedCustomMessage>();
	private _isWritingCustom = false;
	private _isStoppingCustom = false;
	/** One-shot developer instructions held until B (status `staged`), FIFO. No drain but B commits them. */
	private _stagedInstructions: PendingInstruction[] = [];
	/** Custom and bash content held until B, in ingress order. */
	private _stagedContent: StagedContent[] = [];
	/** The loop persisted a user or custom message since the previous request boundary (§7.3). */
	private _inputArrived = false;
	/** Standing keys selected for delivery that are still pending: later boundaries must deliver them (fail closed). */
	private _standingDue = new Set<string>();

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;
	private readonly _background: BackgroundCompactionOwner;
	private _branchGeneration = 0;
	private _manualBackgroundController?: AbortController;
	/** Cancels preflights spanning a manual release without rejecting accepted input. */
	private _manualBackgroundStopGeneration = 0;
	private readonly _backgroundStanding = new Map<string, Set<string>>();
	/** An irreversible append still owes its public terminal observation after disposal. */
	private readonly _backgroundAppliedListeners = new Map<string, AgentSessionEventListener[]>();

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	/**
	 * Failed response that the next request repeats, set by auto-retry and overflow recovery. The
	 * retry is routed with it as `failed`, since the context no longer contains it.
	 */
	private _failedResponse: AssistantMessage | undefined;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];
	// Model-invoked bash calls between tool_execution_start and tool_execution_end, with handover
	// requests waiting for the process to spawn.
	private readonly _runningBashCalls = new Map<string, Array<(handedOver: boolean) => void>>();
	// Handover requests of bash calls whose process is running (see requestBashHandover()).
	private readonly _bashHandoverRequests = new Map<string, () => Promise<boolean>>();

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _disposed = false;
	private _disposing = false;
	private _turnIndex = 0;
	private readonly _entryIdsByMessage = new WeakMap<object, string>();
	/** Instructions queued during a run, committed at the next anchored provider request or at run end. */
	private _pendingInstructions: PendingInstruction[] = [];
	/** Committed developer instructions: their lifecycle events are observation-only. */
	private readonly _committedInstructions = new WeakSet<object>();
	/** Incremented by closeAdmission() and dispose(); a prompt whose preflight spans a change is cancelled. */
	private _admissionGen = 0;
	private _admissionClosed = false;
	private readonly _boundaryDispatchedMessages = new WeakSet<object>();
	private _lastAssistantMessage: AssistantMessage | undefined;
	private _lastAssistantToolResults: AgentMessage[] = [];
	private _lastActivityOutcome: AgentActivityOutcome = "completed";
	private _isBeforeSettle = false;
	private _abortDuringBeforeSettle = false;
	private _isEmittingAgentSettled = false;
	private readonly _deferredSettledActions: Array<() => Promise<void>> = [];
	private _isEmittingAgentEndExtensionEvent = false;
	private _isDrainingNewSessionRequest = false;
	private _pendingNewSessionRequest: PendingNewSessionRequest | undefined;
	private _pendingCwdChange?: PendingCwdChange;
	private _cwdContinuation?: { message: CustomMessage; inputs: number; ready: boolean };
	/** Stops invalidate participating preflight inputs, even after another starter consumed the wakeup. */
	private _cwdInputStopGeneration = 0;
	private _cwdChangeHandler?: CwdChangeHandler;
	private _validateCwdChange?: (path: string) => string;
	private _cwdImmediate?: ReturnType<typeof setImmediate>;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	/**
	 * Tools of the restored or reloaded loadout that are not registered yet, such as tools of MCP
	 * servers that are still connecting. They are activated when they are registered, and dropped when
	 * `setActiveToolsByName()` deactivates a tool or the next agent run starts.
	 */
	private _pendingToolNames = new Set<string>();
	private _usesDefaultTools: boolean;
	private _defaultToolModifiers: string[];
	/** Matches the `--tools` entries: tool names or patterns. */
	private _allowedTools?: (name: string) => boolean;
	/**
	 * Whether the allowlist filters MCP tools: it is empty (`--no-tools`) or names an MCP tool
	 * (`mcp__*`). Otherwise it keeps MCP tools registered for codemode and tool_search.
	 */
	private _allowlistFiltersMcp = false;
	private _excludedTools?: (name: string) => boolean;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;
	private _cacheWarmer?: Pick<CacheWarmer, "cancel" | "status" | "onAgentSettled" | "onModeChanged" | "onWarmed">;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	/** Created on the first `ctx.executeTool()` call. */
	private _nestedToolCalls: NestedToolCallRunner | undefined;
	/** Declared tools whose declarations requests leave out, from `prepareLoadout` hooks. */
	private _hiddenDeclarations: ReadonlySet<string> = new Set();
	private _hiddenDeclarationOwner?: string;
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPromptOptions!: NormalizedBuildSystemPromptOptions;
	/** Prompt options after before_agent_start mutations for the active run. */
	private _runSystemPromptOptions?: NormalizedBuildSystemPromptOptions;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._cacheWarmer = config.cacheWarmer;
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = (entry) => this._emit({ type: "entry_appended", entry });
		}
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._usesDefaultTools = config.usesDefaultTools ?? false;
		this._defaultToolModifiers = config.defaultToolModifiers ?? [];
		if (config.allowedToolNames) {
			this._allowedTools = createToolNameMatcher(config.allowedToolNames);
			this._allowlistFiltersMcp =
				config.allowedToolNames.length === 0 || config.allowedToolNames.some((entry) => entry.startsWith("mcp__"));
		}
		this._excludedTools = config.excludedToolNames ? createToolNameMatcher(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		const target = createCompactionJobTarget(this.sessionManager, () => ({
			generation: this._branchGeneration,
			disposed: this._disposed || this._disposing,
		}));
		const append = target.append;
		target.append = (candidate) => {
			const pending = new Set(
				this.sessionManager
					.getStandingState()
					.filter((state) => state.pending)
					.map((state) => state.key),
			);
			const id = append(candidate);
			this._backgroundStanding.set(id, pending);
			return id;
		};
		this._background = new BackgroundCompactionOwner({
			target,
			requestRunStop: () => this._requestRunStop(),
			refresh: () => this._refreshFinalizedContext(),
			notifyApplied: async (entryId, job) => {
				this._backgroundAppliedListeners.set(job.id, [...this._eventListeners]);
				const entry = this.sessionManager.getEntry(entryId);
				const pending = this._backgroundStanding.get(entryId);
				this._backgroundStanding.delete(entryId);
				if (entry?.type !== "compaction") return;
				const stillPending = new Set(
					this.sessionManager
						.getStandingState()
						.filter((state) => state.pending)
						.map((state) => state.key),
				);
				await this._emitStandingDelivered(
					(entry.standing ?? [])
						.filter((item) => pending?.has(item.key) && !stillPending.has(item.key))
						.map((item) => ({ key: item.key, content: item.message.content, entryId })),
				);
				if (!this._disposed)
					await this._emitSessionCompact({
						type: "session_compact",
						compactionEntry: entry,
						fromExtension: entry.fromHook ?? false,
						reason: "manual",
						willRetry: false,
						background: { jobId: job.id, source: job.source },
					});
			},
			observe: (event) => {
				const committedListeners =
					event.phase === "applied" ? this._backgroundAppliedListeners.get(event.jobId) : undefined;
				if (event.phase === "applied") this._backgroundAppliedListeners.delete(event.jobId);
				this._emitIsolated(event, this._disposed && committedListeners ? committedListeners : this._eventListeners);
			},
			emitBeforeInvalidation: (event) => this._extensionRunner.emitBeforeInvalidation(event),
			emit: async (event, signal) => {
				if (!this._disposed && !this._extensionRunner.isInvalidated())
					await this._extensionRunner.emit(event, signal);
			},
			reportError: (error) =>
				this._extensionRunner.emitError({
					extensionPath: "<runtime>",
					event: "session_background_compaction",
					error: error instanceof Error ? error.message : String(error),
				}),
		});

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installCustomAdmissions();
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();
		this._installAgentRequestProjection();
		this._installAgentInstructionBoundary();
		this._installAgentBoundaryHooks();
		this._installHiddenDeclarationsProjection();
		this._installAgentForcedPromptProjection();

		const carry = config.carry;
		const addedDefaults =
			carry && this._usesDefaultTools
				? applyToolModifiers(
						this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES,
						this._defaultToolModifiers,
					).filter((name) => !carry.previousDefaultTools.includes(name))
				: [];
		if (carry) {
			this._pendingToolNames = new Set(carry.activeToolNames.filter((name) => this._isAllowedTool(name)));
			this._stagedContent = carry.stagedContent;
			this._stagedInstructions = carry.stagedInstructions;
			this._pendingNextTurnMessages = carry.nextTurn;
		}
		this._buildRuntime({
			activeToolNames: carry ? [...carry.activeToolNames, ...addedDefaults] : this._initialActiveToolNames,
			includeAllExtensionTools: !carry,
			previousDefaultActiveToolNames: carry?.previousDefaultActiveToolNames,
		});
		if (this._usesDefaultTools && !carry) this._restoreToolsFromTranscript(this._defaultToolModifiers);
	}

	get pendingCwdChange(): Readonly<PendingCwdChange> | undefined {
		return this._pendingCwdChange;
	}

	/** Host binding, deliberately separate from extension-owned reload state. */
	setCwdChangeHandler(handler: CwdChangeHandler | undefined, validate?: (path: string) => string): void {
		this._cwdChangeHandler = handler;
		this._validateCwdChange = validate;
		this._extensionRunner.setRequestCwdChange(
			handler ? (path, options) => this.requestCwdChange(path, options) : undefined,
		);
	}

	requestCwdChange(path: string, options?: { reason?: string }): RequestCwdChangeResult {
		if (!this._cwdChangeHandler)
			return { status: "rejected", reason: "Not changed: cd is not supported in this mode." };
		if (this._needsBootstrap())
			return {
				status: "rejected",
				reason: "Not changed: the session has not bootstrapped; wait for the first run to start.",
			};
		if (this._pendingCwdChange)
			return {
				status: "rejected",
				reason: `Not changed: a change to ${this._pendingCwdChange.to} is already pending.`,
			};
		const error = this.getCwdChangeError(true);
		if (error)
			return {
				status: "rejected",
				reason: this.sessionManager.getPersistenceError()
					? `Not changed: the session file cannot be written: ${error}.`
					: cwdRequestRejection(error),
			};
		let to: string;
		try {
			to = this._validateCwdChange!(path);
		} catch (error) {
			return {
				status: "rejected",
				reason: cwdRequestRejection(error instanceof Error ? error.message : String(error)),
			};
		}
		let resolve!: PendingCwdChange["resolve"];
		const completion = new Promise<"applied" | "cancelled" | "untrusted" | "failed">((r) => {
			resolve = r;
		});
		const slot: PendingCwdChange = {
			requestId: randomUUID(),
			from: this.sessionManager.getCwd(),
			to,
			reason: options?.reason,
			source: "model",
			state: "pending",
			resolve,
		};
		this._pendingCwdChange = slot;
		this._schedulePendingCwd();
		return { status: "pending", requestId: slot.requestId, from: slot.from, to, completion };
	}

	/** User changes occupy the same slot during trust, but do not write cancellation passives. */
	reserveCwdChange(to: string, requestId?: string): PendingCwdChange | undefined {
		if (requestId) return this._pendingCwdChange?.requestId === requestId ? this._pendingCwdChange : undefined;
		if (this._pendingCwdChange) return undefined;
		this._pendingCwdChange = {
			requestId: randomUUID(),
			from: this.sessionManager.getCwd(),
			to,
			source: "user",
			state: "trust",
			resolve: () => {},
		};
		return this._pendingCwdChange;
	}

	releaseUserCwdChange(slot: PendingCwdChange): void {
		if (slot.source === "user" && this._pendingCwdChange === slot) this._pendingCwdChange = undefined;
	}

	/** @internal Cancel before a host starts awaiting shutdown handlers. */
	cancelCwdChange(): void {
		this._cancelPendingCwd("the session was closed or replaced");
	}

	private _cancelPendingCwd(cause: string): void {
		this._cwdInputStopGeneration++;
		this._cwdContinuation = undefined;
		const slot = this._pendingCwdChange;
		if (!slot) return;
		slot.continuationCancelled = true;
		if (slot.state === "applying") return;
		this._pendingCwdChange = undefined;
		if (slot.source === "model") this._cwdOutcome(slot, "cancelled", cause);
	}

	/** @internal Arm before destination binding; a stop or another starter consumes the wakeup. */
	prepareCwdContinuation(): () => void {
		const notice = this.messages.findLast(
			(message): message is CustomMessage => message.role === "custom" && message.customType === "pi.cwd",
		);
		if (!notice) return () => {};
		// Preflight handlers receive a trigger, not mutable access to already-recorded history.
		const pending = { message: structuredClone(notice), inputs: 0, ready: false };
		this._cwdContinuation = pending;
		return () => {
			pending.ready = true;
			this._startCwdContinuation(pending);
		};
	}

	private _startCwdContinuation(pending: NonNullable<AgentSession["_cwdContinuation"]>): void {
		if (
			this._cwdContinuation !== pending ||
			!pending.ready ||
			pending.inputs ||
			this._disposed ||
			this._admissionClosed
		)
			return;
		// Reuse the persisted notice as the trigger envelope, never append it a second time.
		void this._startRun(
			{ messageType: "custom", message: pending.message },
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			true,
		).catch((error) => this._reportBootstrapError(error));
	}

	private _cwdOutcome(slot: PendingCwdChange, kind: "cancelled" | "failed", cause: string, untrusted = false): void {
		const content =
			kind === "cancelled"
				? `Working-directory change cancelled (not a request). The change to ${slot.to} requested earlier was cancelled before it took effect: ${cause}. At this point the working directory is ${slot.from}.`
				: `Working-directory change failed (not a request). The change to ${slot.to} requested earlier did not take effect: ${cause}. At this point the working directory is ${slot.from}.`;
		void this.sendCustomMessage(
			{
				customType: "pi.cwd",
				content,
				display: true,
				details: { kind, from: slot.from, to: slot.to, cause, requestId: slot.requestId },
			},
			{ triggerTurn: false },
		).catch((error) => this._reportBootstrapError(error));
		slot.resolve(untrusted ? "untrusted" : kind);
	}

	private _schedulePendingCwd(): void {
		if (this._cwdImmediate || !this._pendingCwdChange || this._disposed) return;
		this._cwdImmediate = setImmediate(() => {
			this._cwdImmediate = undefined;
			void this._maybeApplyPendingCwd();
		});
	}

	private async _maybeApplyPendingCwd(): Promise<void> {
		const slot = this._pendingCwdChange;
		if (!slot || slot.state !== "pending" || !this._cwdChangeHandler || this.getCwdChangeError() === "busy") return;
		slot.state = "trust";
		try {
			const result = await this._cwdChangeHandler(slot.to, {
				source: "model",
				reason: slot.reason,
				requestId: slot.requestId,
			});
			if (this._pendingCwdChange !== slot) return;
			if (!result.changed && result.error === "busy") {
				slot.state = "pending";
				if (!this.getCwdChangeError()) this._schedulePendingCwd();
				return;
			}
			this._pendingCwdChange = undefined;
			if (result.changed) slot.resolve("applied");
			else if (result.error === "untrusted") this._cwdOutcome(slot, "cancelled", `${slot.to} is not trusted`, true);
			else this._cwdOutcome(slot, "failed", result.error);
		} catch (error) {
			if (this._pendingCwdChange !== slot) return;
			this._pendingCwdChange = undefined;
			// A post-commit factory failure cannot be described as a failed change.
			if (this.sessionManager.getCwd() === slot.to) slot.resolve("applied");
			else this._cwdOutcome(slot, "failed", error instanceof Error ? error.message : String(error));
			this._reportBootstrapError(error);
		}
	}

	/** Preflight policy for a cwd transfer. Persistence and target checks belong to the manager. */
	getCwdChangeError(allowBusy = false): string | undefined {
		if (this._disposed || this._disposing || this._admissionClosed) return "cancelled";
		if (this.settingsManager.getSettings().codemode?.mode === "only")
			return 'cd: not supported while codemode.mode is "only" (it would change tool declarations already sent).';
		if (this._hiddenDeclarations.size > 0) {
			const owner = this._hiddenDeclarationOwner ?? "a tool";
			return `cd: not supported while ${owner} hides tool declarations (it would change tool declarations already sent).`;
		}
		const requestModel = this.routedModel?.model ?? this.model;
		if (!this._needsBootstrap() && requestModel && !supportsMidConversationSystemMessages(requestModel))
			return `cd: ${requestModel.provider}/${requestModel.id} cannot receive the system prompt update a directory change needs; switch model first.`;
		if (
			!allowBusy &&
			(!this.isIdle ||
				this._readiness ||
				this.isBashRunning ||
				this.agent.hasQueuedMessages() ||
				[...this._customStore.values()].some((item) => item.state !== "buffered"))
		)
			return "busy";
		return this.sessionManager.getPersistenceError()?.message;
	}

	/** Reserve readiness and admission synchronously; release on a pre-publication failure. */
	beginCwdTransition(): () => void {
		const barrier = this._beginReadiness();
		this._admissionClosed = true;
		this._background.cancel("reload", undefined, true);
		if (!this._drainPendingInstructions()) {
			this._admissionClosed = false;
			barrier.release();
			throw new Error("cd: pending developer instructions could not be committed.");
		}
		return () => {
			if (!this._disposed) this._admissionClosed = false;
			barrier.release();
		};
	}

	/** Called after shutdown handlers, before disposal. No content is journaled early. */
	takeCwdCarry(): CwdCarry {
		const carry: CwdCarry = {
			model: this.model && { provider: this.model.provider, id: this.model.id },
			thinkingLevel: this.thinkingLevel,
			previousDefaultActiveToolNames: [...this._toolRegistry.keys()].filter((name) =>
				this._isActivatedOnRegistration(name),
			),
			activeToolNames: [...new Set([...this.getActiveToolNames(), ...this._pendingToolNames])],
			previousDefaultTools: this._usesDefaultTools
				? applyToolModifiers(
						this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES,
						this._defaultToolModifiers,
					)
				: [],
			stagedContent: this._stagedContent,
			stagedInstructions: this._stagedInstructions.filter((pending) => pending.owner === undefined),
			nextTurn: this._pendingNextTurnMessages,
			heldSettings: {
				images: { blockImages: this.settingsManager.getBlockImages() },
				codemode: { mode: this.settingsManager.getSettings().codemode?.mode ?? "on" },
			},
		};
		this._stagedContent = [];
		this._stagedInstructions = [];
		this._pendingNextTurnMessages = [];
		return carry;
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	private async _getRequiredRequestAuth(
		model: Model<any>,
		signal?: AbortSignal,
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model, { signal });
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(
		selectedModel: Model<any>,
		signal?: AbortSignal,
		captured = {
			messages: this.messages,
			thinkingLevel: this.thinkingLevel,
			streamFunction: this.agent.streamFunction,
		},
	): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
		thinkingLevel: ThinkingLevel;
	}> {
		// Route a virtual model first: summaries size their input and output from the model they get.
		const { model, thinkingLevel } = isVirtualModel(selectedModel)
			? await this._modelRuntime.resolveModel(selectedModel, convertToLlm(captured.messages), {
					reason: "direct",
					thinkingLevel: captured.thinkingLevel,
					signal,
				})
			: { model: selectedModel, thinkingLevel: captured.thinkingLevel };
		if (captured.streamFunction === streamSimple) {
			return { ...(await this._getRequiredRequestAuth(model, signal)), thinkingLevel };
		}

		try {
			const result = await this._modelRuntime.getAuth(model, { signal });
			if (!result) return { model, thinkingLevel };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
				thinkingLevel,
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			return { model, thinkingLevel };
		}
	}

	/**
	 * The model whose limits apply to `message`, or undefined when the message came from another
	 * model. Under a virtual selection, that is the physical model that produced it.
	 */
	private _modelForMessage(message: AssistantMessage): Model<any> | undefined {
		const model = this.model;
		if (model && isVirtualModel(model)) return this._modelRuntime.getPhysicalModel(message.provider, message.model);
		return model?.provider === message.provider && model.id === message.model ? model : undefined;
	}

	/**
	 * Record the selection on the current branch when the branch implies another one, so a resume
	 * restores it. Tree navigation can leave the latest `model_change` on another branch; responses
	 * cannot record a virtual selection because they name physical models. Responses do record a
	 * physical selection unless the branch holds a virtual one; checking a physical selection against
	 * responses would record it on every prompt while `prepareRequest` redirects to another model.
	 */
	private _recordSelection(): void {
		const model = this.model;
		if (!model) return;
		const getModel = (provider: string, modelId: string) => this._modelRuntime.getModel(provider, modelId);
		const recorded = getBranchSelection(this.sessionManager.getBranch(), getModel);
		if (!recorded || (recorded.provider === model.provider && recorded.modelId === model.id)) return;
		const recordedModel = getModel(recorded.provider, recorded.modelId);
		if (!isVirtualModel(model) && !(recordedModel && isVirtualModel(recordedModel))) return;
		this.sessionManager.appendModelChange(model.provider, model.id);
	}

	/** The model whose limits apply to the conversation. */
	private _limitsModel(): Model<any> | undefined {
		return this.routedModel?.model ?? this.model;
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = (context) => this._beforeToolCall(context);
		this.agent.afterToolCall = (context) => this._afterToolCall(context);
	}

	/** `tool_call` handlers. `parentToolCallId` is set for calls another tool made. */
	private async _beforeToolCall(
		{ toolCall, args }: BeforeToolCallContext,
		parentToolCallId?: string,
	): Promise<BeforeToolCallResult | undefined> {
		const runner = this._extensionRunner;
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				...(parentToolCallId ? { parentToolCallId } : {}),
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	}

	/** `tool_result` handlers and image normalization. `parentToolCallId` is set for calls another tool made. */
	private async _afterToolCall(
		{ toolCall, args, result, isError }: AfterToolCallContext,
		parentToolCallId?: string,
	): Promise<AfterToolCallResult | undefined> {
		const runner = this._extensionRunner;
		const hookResult = runner.hasHandlers("tool_result")
			? await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					...(parentToolCallId ? { parentToolCallId } : {}),
					input: args as Record<string, unknown>,
					content: result.content,
					details: result.details,
					...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
					isError,
					usage: result.usage,
				})
			: undefined;

		const content = hookResult?.content ?? result.content ?? [];
		// Runs after the extension hook so images injected or replaced by extensions are normalized too.
		const resizeOptions = this._limitsModel()?.inputLimits?.images?.resize;
		const normalizedContent = await normalizeToolResultImages(content, {
			autoResizeImages: this.settingsManager.getImageAutoResize(),
			...(resizeOptions ? { resizeOptions } : {}),
		});

		if (!hookResult && normalizedContent === content) {
			return undefined;
		}

		// The hook result already dropped structured content that replaced content no longer matches.
		return {
			content: normalizedContent,
			details: hookResult?.details,
			structuredContent: hookResult ? hookResult.structuredContent : result.structuredContent,
			isError: hookResult?.isError ?? isError,
			usage: hookResult?.usage,
		};
	}

	/**
	 * Run a call that the tool call `parentToolCallId` made through `ctx.executeTool()`. It goes
	 * through the agent's tool pipeline with the session's hooks, against the callable tools.
	 */
	private async _executeNestedToolCall(
		parentToolCallId: string,
		name: string,
		args: unknown,
		options: ExecuteToolOptions,
	): Promise<AgentToolCallOutcome> {
		this._nestedToolCalls ??= new NestedToolCallRunner({
			getTools: () => this._getCallableTools(),
			isSequential: () => this.agent.toolExecution === "sequential",
			runToolCall: (toolCall, parentId, signal, onUpdate) => {
				const assistantMessage = this._findLastAssistantMessage();
				if (!assistantMessage) {
					return Promise.resolve({
						toolCall,
						result: { content: [{ type: "text", text: "No assistant message issued this call" }], details: {} },
						isError: true,
					});
				}
				return runToolCall(toolCall, {
					tools: this._getCallableTools(),
					assistantMessage,
					context: { messages: this.agent.state.messages, tools: this.agent.state.tools },
					beforeToolCall: (context) => this._beforeToolCall(context, parentId),
					afterToolCall: (context) => this._afterToolCall(context, parentId),
					signal,
					onUpdate,
				});
			},
			emit: async (event) => {
				await this._extensionRunner.emit(event);
				this._emit(event);
			},
		});
		return this._nestedToolCalls.execute(parentToolCallId, name, args, options);
	}

	/** Whether `projection`, the current session projection, exceeds the compaction threshold of `model`. */
	private _exceedsCompactionThreshold(model: Model<any>, projection: SessionProjection): boolean {
		if (model.contextWindow <= 0) return false;
		return shouldCompact(
			estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens,
			model.contextWindow,
			this.settingsManager.getCompactionSettings(this.model),
		);
	}

	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		await this._backgroundGate("delivered");
		const projection = this.sessionManager.buildSessionProjection();
		// No compaction after disposal: its fresh controller would be beyond dispose()'s abort.
		if (this._disposed) return { ...context, messages: projection.messages };
		// A virtual selection is checked in prepareRequest, against the model the request is routed to.
		const model = this.model;
		if (!model || isVirtualModel(model) || !this._exceedsCompactionThreshold(model, projection)) {
			return { ...context, messages: projection.messages };
		}
		await this._runAutoCompaction("threshold", false);
		this._throwIfRunStopped();
		return { ...context, messages: this.sessionManager.buildSessionProjection().messages };
	}

	private _installAgentRequestProjection(): void {
		// One tool snapshot per request boundary (§6): the loop refreshes its tools from state before
		// declaring changes, and prepareRequest sends exactly that declared snapshot.
		this.agent.getTools = () => this.agent.state.tools.slice();
		// The compaction boundary is context, never input: a transcript ending with it still ends with what
		// precedes it, so continue() runs queued input after a final reply instead of answering the boundary.
		this.agent.isContextMarker = (message) =>
			message.role === "compactionBoundary" || (message.role === "custom" && message.customType === "pi.cwd");
		const previousPrepareRequest = this.agent.prepareRequest;
		this.agent.prepareRequest = async (request, signal) => {
			this._throwIfRunStopped();
			// Nothing reaches the provider adapter after dispose(), not even an aborted stream.
			if (this._disposed) throw new Error("The session was disposed; no request is sent.");
			// No request goes out on a session whose file may hold a partial entry (§3.6).
			const persistenceError = this.sessionManager.getPersistenceError();
			if (persistenceError) throw persistenceError;
			const failed = this._failedResponse;
			this._failedResponse = undefined;
			const prepare = async () => {
				// Notices of a compaction run by the virtual routing below (the boundary hook wrote earlier ones).
				// Checked on every call: the compaction or a notice observer may have refused writes since the
				// guard above, and no request goes out then (§3.6).
				this._flushCompactionNoticesBeforeRequest();
				const projection = this.sessionManager.buildSessionProjection();
				const canonicalContext = {
					...request.context,
					messages: projection.messages,
					// Messages declare the provider-visible loadout; context.tools is the snapshot the loop just
					// declared. A later change is declared at the next boundary, never sent undeclared.
					tools: request.context.tools?.slice() ?? [],
				};
				const previous = await previousPrepareRequest?.(
					{
						...request,
						context: canonicalContext,
						model: this.agent.state.model,
						thinkingLevel: this.agent.state.thinkingLevel,
					},
					signal,
				);
				return { previous, context: previous?.context ?? canonicalContext, projection };
			};
			let { previous, context, projection } = await prepare();
			const model = previous?.model ?? this.agent.state.model;
			const thinkingLevel = previous?.thinkingLevel ?? this.agent.state.thinkingLevel;
			this._throwIfRunStopped();
			if (!isVirtualModel(model)) return { ...previous, context, model, thinkingLevel };

			// The selection stays in agent state; only this request uses the routed model. A routing
			// failure rejects, which ends the run with an error response. Only messages the user wrote
			// start a turn; extension messages can follow them, e.g. from before_agent_start.
			const lastResponse = context.messages.findLastIndex((message) => message.role === "assistant");
			const userTurn = context.messages.slice(lastResponse + 1).some((message) => message.role === "user");
			const state = getVirtualModelState(this.sessionManager.getBranch(), model.provider, model.id);
			const route = await this._modelRuntime.resolveModel(model, convertToLlm(context.messages), {
				reason: failed ? "retry" : userTurn ? "user" : "continuation",
				thinkingLevel,
				signal,
				failed,
				state,
			});
			if (route.state !== undefined && route.state !== state) {
				const data: VirtualModelStateData = { provider: model.provider, modelId: model.id, state: route.state };
				const entry = this.sessionManager.getEntry(
					this.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, data),
				);
				if (entry) this._emit({ type: "entry_appended", entry });
			}
			// The route stands: the router already decided this request. The state entry does not change
			// the projection.
			if (this._exceedsCompactionThreshold(route.model, projection)) {
				await this._runAutoCompaction("threshold", false, "delivered", route.model);
				this._throwIfRunStopped();
				({ previous, context } = await prepare());
			}
			this._throwIfRunStopped();
			return { ...previous, context, model: route.model, thinkingLevel: route.thinkingLevel };
		};
	}

	/**
	 * Commit queued instructions immediately before a provider request, after the turn's tool results
	 * and steering messages. Only when the request is anchored (the last non-instruction message is a
	 * user message or tool results); otherwise they stay pending for a later request or run end.
	 */
	private _installAgentInstructionBoundary(): void {
		const previousGetInstructionMessages = this.agent.getInstructionMessages;
		this.agent.getInstructionMessages = async (context) => {
			// Compaction notices go after this boundary's input and before its instructions.
			const notices = this._flushCompactionNoticesBeforeRequest();
			const previous = (await previousGetInstructionMessages?.(context)) ?? [];
			const inputArrived = this._inputArrived;
			this._inputArrived = false;
			const anchor = convertToLlm([...context.messages, ...notices])
				.filter((message) => message.role !== "system" && message.role !== "developer")
				.at(-1)?.role;
			if (anchor !== "user" && anchor !== "toolResult") return previous;
			// Standing values first (fail closed); one-shots queued by their delivered handlers follow.
			const standing = await this._deliverStandingAtBoundary(inputArrived);
			if (this._pendingInstructions.length === 0) return [...previous, ...standing];
			const committed: AgentMessage[] = [...standing];
			for (const pending of this._pendingInstructions.slice()) {
				// A previous item's onCommit may have cancelled this snapshot item.
				if (!this._pendingInstructions.includes(pending)) continue;
				try {
					this._commitInstruction(pending);
				} catch (error) {
					// Stays pending (in order) for the next request or run end.
					this._reportInstructionError(error);
					break;
				}
				committed.push(pending.message);
			}
			return [...previous, ...committed];
		};
	}

	/** The active branch has no system state yet: its first run writes the snapshot (B). */
	private _needsBootstrap(): boolean {
		return !this.sessionManager.buildSessionProjection().messages.some((message) => message.role === "system");
	}

	/** Producers stage on a branch that needs bootstrap, or while anything is still staged (§3.3). */
	private _isStagingBranch(): boolean {
		return this._stagedInstructions.length > 0 || this._stagedContent.length > 0 || this._needsBootstrap();
	}

	/** Developer instructions stage while idle or in a run's preflight on a staging branch. */
	private _shouldStage(): boolean {
		return (!this.isStreaming || this._isPreparingRun) && this._isStagingBranch();
	}

	/** Content staged before B, for display (TUI rebuild). Committed messages are not included. */
	get stagedMessages(): ReadonlyArray<CustomMessage | BashExecutionMessage> {
		return this._stagedContent.map((item) => item.message);
	}

	/** Drop everything staged (dispose, replacement, tree navigation): no onCommit. */
	private _discardStaged(): void {
		this._stagedInstructions = [];
		const discarded = this._stagedContent;
		this._stagedContent = [];
		const callbacks = discarded.map((item) => this._takeCustomReceipt(item, { status: "dropped" }));
		for (const callback of callbacks) callback?.();
	}

	/** Consume before dispatch: a callback can send again, dispose or navigate the session. */
	private _takeCustomReceipt(
		item: Pick<OwnedCustomMessage, "onReceipt">,
		receipt: SendMessageReceipt,
	): (() => void) | undefined {
		const callback = item.onReceipt;
		item.onReceipt = undefined;
		if (!callback) return undefined;
		return () => {
			// Observe failures without making append or teardown wait for the notification.
			void (async () => {
				try {
					await callback(receipt);
				} catch (error) {
					this._extensionRunner.emitError({
						extensionPath: "<runtime>",
						event: "send_message_receipt",
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				}
			})();
		};
	}

	/**
	 * Reload rule for staged instructions created through the extension API (§3.7): a bound session's
	 * extensions rebuild them from the journal at session_start(reload), so they are dropped; a never-bound
	 * session keeps them without onCommit (its runtime is invalidated). SDK-owned items and content stay.
	 */
	private _releaseExtensionStagedInstructions(): void {
		if (this._extensionsBound) {
			this._stagedInstructions = this._stagedInstructions.filter((pending) => pending.owner === undefined);
		} else {
			for (const pending of this._stagedInstructions) {
				if (pending.owner !== undefined) pending.onCommit = undefined;
			}
		}
	}

	/** Move the preflight buffers behind the staged content (failed preflight or failed B, §3.6). */
	private _stagePreflightBuffers(): void {
		for (const message of this._pendingBashMessages.splice(0)) {
			this._stagedContent.push({ message, announced: false });
		}
		for (const item of this._customStore.values()) {
			if (item.state !== "buffered") continue;
			this._stageOwnedCustom(item, false);
		}
	}

	/** Emit to every listener; a throwing listener is reported and does not stop the others. */
	private _emitIsolated(event: AgentSessionEvent, listeners = this._eventListeners): void {
		for (const listener of [...listeners]) {
			try {
				outsideCompactionNoticeScope(() => listener(event));
			} catch (error) {
				this._reportBootstrapError(error);
			}
		}
	}

	private _reportBootstrapError(error: unknown): void {
		this._extensionRunner.emitError({
			extensionPath: "<runtime>",
			event: "session_bootstrap",
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}

	/**
	 * The bootstrap commit (B, §3.4): write the snapshot, the staged developers and the staged content,
	 * synchronously and in order. Events and deferred onCommit callbacks run afterwards from the receipts
	 * of the appends that succeeded, also when a later append threw (which is rethrown).
	 */
	private async _bootstrapCommit(
		snapshotPatch: SystemMessage | undefined,
		needsSnapshot: boolean,
		includePreflightCustom: boolean,
	): Promise<void> {
		const events: AgentSessionEvent[] = [];
		const callbacks: Array<() => void> = [];
		const standing: StandingDelivery[] = [];
		try {
			if (needsSnapshot) {
				const toolsAdded = getToolStateChanges([], this.agent.state.tools).toolsAdded;
				const snapshot: SystemMessage = {
					...(snapshotPatch ?? { role: "system", content: "", sections: {}, timestamp: Date.now() }),
					...(toolsAdded.length > 0 ? { toolsAdded } : {}),
				};
				this.sessionManager.appendMessage(snapshot);
				events.push({ type: "message_start", message: snapshot }, { type: "message_end", message: snapshot });
			}
			// Step 1b: one keyed developer per pending standing value, in key order (both apply values).
			for (const state of this.sessionManager.getStandingState()) {
				if (!state.pending || !state.desired) continue;
				this._standingDue.add(state.key);
				standing.push(this._appendStandingValue(state.key, state.desired.content));
				this._standingDue.delete(state.key);
			}
			for (const pending of this._stagedInstructions.slice()) {
				this._commitInstruction(pending, { deferOnCommit: true });
				this._stagedInstructions.splice(this._stagedInstructions.indexOf(pending), 1);
				const { onCommit, entryId } = pending;
				if (onCommit && entryId) callbacks.push(() => onCommit(entryId));
			}
			while (this._stagedContent.length > 0) {
				const item = this._stagedContent[0]!;
				const entryId = this._appendContentMessage(item.message);
				this._stagedContent.shift();
				const callback = this._takeCustomReceipt(item, { status: "committed", entryId });
				if (callback) callbacks.push(callback);
				if (!item.announced && item.message.role === "custom") {
					events.push(
						{ type: "message_start", message: item.message },
						{ type: "message_end", message: item.message },
					);
				}
			}
			while (this._pendingBashMessages.length > 0) {
				this.sessionManager.appendMessage(this._pendingBashMessages[0]!);
				this._pendingBashMessages.shift();
			}
			if (includePreflightCustom) {
				for (const item of this._customStore.values()) {
					if (item.state !== "buffered" || item.riderOf) continue;
					const message = item.handle;
					const entryId = this._appendContentMessage(message);
					this._customStore.delete(message);
					const callback = this._takeCustomReceipt(item, { status: "committed", entryId });
					if (callback) callbacks.push(callback);
					events.push({ type: "message_start", message }, { type: "message_end", message });
				}
			}
		} finally {
			this._refreshFinalizedContext();
			const snapshotEvents = events.filter((event) => "message" in event && event.message.role === "system");
			for (const event of snapshotEvents) this._emitIsolated(event);
			await this._emitStandingDelivered(standing);
			for (const event of events) if (!snapshotEvents.includes(event)) this._emitIsolated(event);
			for (const callback of callbacks) {
				try {
					callback();
				} catch (error) {
					this._reportInstructionError(error);
				}
			}
		}
	}

	/** Append one keyed developer for a standing value, frozen and marked committed. */
	private _appendStandingValue(key: string, content: string | TextContent[]): StandingDelivery {
		const copy = structuredClone(content);
		if (Array.isArray(copy)) {
			for (const part of copy) Object.freeze(part);
			Object.freeze(copy);
		}
		const message: DeveloperMessage = Object.freeze({ role: "developer", content: copy, timestamp: Date.now() });
		const entryId = this.sessionManager.appendMessage(message, { standingKey: key });
		this._entryIdsByMessage.set(message, entryId);
		this._committedInstructions.add(message);
		return { key, content: copy, message, entryId };
	}

	/**
	 * Append a compaction with its standing carry (§7.4) and return the entry `appendCompaction` wrote,
	 * plus one delivery per carried value that was pending before the append (its delivered event).
	 */
	private _appendCompactionWithCarry(
		args: [string, string, number, unknown, boolean, Usage | undefined],
		carry: CompactionCarry,
	): { entry: CompactionEntry | undefined; delivered: Array<Omit<StandingDelivery, "message">> } {
		const pendingBefore = new Set(
			this.sessionManager
				.getStandingState()
				.filter((state) => state.pending)
				.map((state) => state.key),
		);
		const entryId = this.sessionManager.appendCompaction(...args, { carry });
		const entry = this.sessionManager.getEntry(entryId);
		if (entry?.type !== "compaction") return { entry: undefined, delivered: [] };
		const nowPending = new Set(
			this.sessionManager
				.getStandingState()
				.filter((state) => state.pending)
				.map((state) => state.key),
		);
		const delivered = (entry.standing ?? [])
			.filter((item) => pendingBefore.has(item.key) && !nowPending.has(item.key))
			.map((item) => ({ key: item.key, content: item.message.content, entryId }));
		return { entry, delivered };
	}

	/** Emit standing_instruction_delivered per delivery, in order; handler errors are reported by the runner. */
	private async _emitStandingDelivered(deliveries: Array<Omit<StandingDelivery, "message">>): Promise<void> {
		for (const { key, content, entryId } of deliveries) {
			try {
				await this._extensionRunner.emit({ type: "standing_instruction_delivered", key, content, entryId });
			} catch (error) {
				this._reportBootstrapError(error);
			}
		}
	}

	/**
	 * Deliver eligible standing values at a request boundary (§7.3): pending values whose apply is
	 * `next-request`, or `next-input` after an input, or due after a failed delivery. The whole
	 * eligible batch is latched as due before the first append; any failure fails the request.
	 */
	private async _deliverStandingAtBoundary(inputArrived: boolean): Promise<AgentMessage[]> {
		const states = this.sessionManager.getStandingState();
		for (const key of [...this._standingDue]) {
			if (!states.some((state) => state.key === key && state.pending)) this._standingDue.delete(key);
		}
		const eligible = states.filter(
			(state) =>
				state.pending &&
				state.desired !== undefined &&
				(state.desired.apply === "next-request" || inputArrived || this._standingDue.has(state.key)),
		);
		if (eligible.length === 0) return [];
		for (const state of eligible) this._standingDue.add(state.key);
		const delivered: StandingDelivery[] = [];
		let failure: { key: string; error: unknown } | undefined;
		for (const state of eligible) {
			try {
				delivered.push(this._appendStandingValue(state.key, state.desired!.content));
				this._standingDue.delete(state.key);
			} catch (error) {
				failure = { key: state.key, error };
				break;
			}
		}
		if (delivered.length > 0) this._refreshFinalizedContext();
		await this._emitStandingDelivered(delivered);
		if (failure) {
			const cause = failure.error instanceof Error ? failure.error.message : String(failure.error);
			throw new Error(`Standing instruction "${failure.key}" could not be delivered: ${cause}`);
		}
		return delivered.map((delivery) => delivery.message);
	}

	setStandingInstruction(
		key: string,
		content: string | TextContent[],
		options?: { apply?: "next-input" | "next-request" },
	): void {
		this._assertStandingWritable(key);
		if (isBlankInstruction(content)) throw new Error("setStandingInstruction() requires non-blank content.");
		const desired = this.sessionManager.getStandingState().find((state) => state.key === key)?.desired;
		if (
			desired &&
			sameStandingContent(desired.content, content) &&
			(options?.apply === undefined || options.apply === desired.apply)
		) {
			return;
		}
		const apply =
			options?.apply ?? (desired && sameStandingContent(desired.content, content) ? desired.apply : "next-input");
		this._appendStandingEntry(key, content, apply);
	}

	clearStandingInstruction(key: string): void {
		this._assertStandingWritable(key);
		if (!this.sessionManager.getStandingState().some((state) => state.key === key && state.desired)) return;
		this._appendStandingEntry(key, undefined, undefined);
	}

	getStandingInstruction(key: string): StandingInstructionInfo | undefined {
		const state = this.sessionManager.getStandingState().find((item) => item.key === key);
		if (!state?.desired) return undefined;
		return {
			content: structuredClone(state.desired.content),
			apply: state.desired.apply,
			delivered: !state.pending,
			...(!state.pending && state.delivered ? { deliveredEntryId: state.delivered.entryId } : {}),
		};
	}

	private _assertStandingWritable(key: string): void {
		if (this._disposed) throw new Error("Standing instructions cannot be changed after the session is disposed.");
		if (!key) throw new Error("Standing instruction key must not be empty.");
		const persistenceError = this.sessionManager.getPersistenceError();
		if (persistenceError) throw persistenceError;
	}

	private _appendStandingEntry(
		key: string,
		content: string | TextContent[] | undefined,
		apply: "next-input" | "next-request" | undefined,
	): void {
		const entryId = this.sessionManager.appendStandingInstruction(key, content, apply);
		const entry = this.sessionManager.getEntry(entryId);
		if (entry) this._emit({ type: "entry_appended", entry });
	}

	private _appendContentMessage(message: CustomMessage | BashExecutionMessage): string {
		if (message.role === "custom") {
			return this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		} else {
			return this.sessionManager.appendMessage(message);
		}
	}

	private _createPendingInstruction(
		content: string | TextContent[],
		onCommit?: (entryId: string) => void,
	): PendingInstruction {
		return {
			pendingId: randomUUID(),
			message: { role: "developer", content, timestamp: Date.now() },
			onCommit,
			state: "pending",
		};
	}

	/**
	 * Commit one instruction to the session exactly once. On an append failure the item returns to
	 * `pending` and the error is rethrown. Persistence precedes every event; the committed message is
	 * frozen, and `onCommit` runs last, isolated from the commit.
	 */
	private _commitInstruction(
		pending: PendingInstruction,
		options: { refresh?: boolean; deferOnCommit?: boolean } = {},
	): string {
		if (pending.state === "committed" && pending.entryId !== undefined) return pending.entryId;
		// Unreachable today: appendMessage() is synchronous and calls back into nothing, so no caller
		// can observe the "committing" state. Guard against a future reentrant path double-appending.
		if (pending.state !== "pending") throw new Error("Developer instruction commit already in progress");
		pending.state = "committing";
		let entryId: string;
		try {
			entryId = this.sessionManager.appendMessage(pending.message);
		} catch (error) {
			pending.state = "pending";
			throw error;
		}
		pending.state = "committed";
		pending.entryId = entryId;
		const index = this._pendingInstructions.indexOf(pending);
		if (index !== -1) this._pendingInstructions.splice(index, 1);
		this._entryIdsByMessage.set(pending.message, entryId);
		this._committedInstructions.add(pending.message);
		const content = pending.message.content;
		if (Array.isArray(content)) {
			for (const part of content) Object.freeze(part);
			Object.freeze(content);
		}
		Object.freeze(pending.message);
		if (options.refresh) this._refreshFinalizedContext();
		if (pending.onCommit && !options.deferOnCommit) {
			try {
				pending.onCommit(entryId);
			} catch (error) {
				this._reportInstructionError(error);
			}
		}
		return entryId;
	}

	private _commitPendingInstructionsAtRunEnd(): void {
		// They stay pending; reporting each refused commit would only repeat the run's error.
		if (this._isSessionWriteBlocked()) return;
		// Also picks up items queued by onCommit callbacks while this runs (the run is still active).
		const attempted = new Set<PendingInstruction>();
		for (
			let pending = this._pendingInstructions.find((item) => !attempted.has(item));
			pending;
			pending = this._pendingInstructions.find((item) => !attempted.has(item))
		) {
			attempted.add(pending);
			try {
				this._commitInstruction(pending, { refresh: true });
			} catch {
				try {
					this._commitInstruction(pending, { refresh: true });
				} catch (error) {
					// Stays pending for the next run's first request.
					this._reportInstructionError(error);
				}
			}
		}
	}

	/**
	 * Commit earlier pending instructions in order before an idle or agent_end commit, so a later
	 * instruction never overtakes one left pending by a failed commit. Returns false when one still
	 * fails: it and everything after it stay pending.
	 */
	private _drainPendingInstructions(): boolean {
		for (const pending of this._pendingInstructions.slice()) {
			// A previous item's onCommit may have cancelled this snapshot item.
			if (!this._pendingInstructions.includes(pending)) continue;
			try {
				this._commitInstruction(pending, { refresh: true });
			} catch (error) {
				this._reportInstructionError(error);
				return false;
			}
		}
		return true;
	}

	private _reportInstructionError(error: unknown): void {
		this._extensionRunner.emitError({
			extensionPath: "<runtime>",
			event: "queue_developer_message",
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
	}

	private async _dispatchTurnEndBoundary(
		message: AssistantMessage,
		toolResults: ToolResultMessage[],
	): Promise<boolean> {
		this._lastActivityOutcome =
			message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" ? "error" : "completed";
		const messageEntryId = this._findPersistedMessageEntryId(message);
		if (!this._extensionRunner.hasHandlers("turn_end")) return false;
		// turn_end handlers get a persisted assistant entry and may write boundary entries; neither is
		// possible once writes are blocked, so the failed turn skips them (agent_end still fires).
		if (!messageEntryId && this._isSessionWriteBlocked()) return false;
		if (!messageEntryId) {
			this._extensionRunner.emitError({
				extensionPath: "<boundary>",
				event: "turn_end",
				error: "turn_end could not resolve the persisted assistant entry ID",
			});
			return false;
		}
		const toolResultEntryIds = toolResults.flatMap((result) => {
			const entryId = this._findPersistedMessageEntryId(result);
			return entryId ? [entryId] : [];
		});
		const boundary = await this._extensionRunner.emitBoundary(
			{
				type: "turn_end",
				turnIndex: this._turnIndex,
				message,
				toolResults,
				messageEntryId,
				toolResultEntryIds,
				outcome: this._lastActivityOutcome,
			},
			(entries) => this._buildBoundaryContext(entries, "turn_end"),
		);
		await this._commitBoundaryDrafts(boundary.entries);
		if (this._disposed) return false;
		if (boundary.continue && !this._buildBoundaryContext([], "turn_end").canContinue) {
			this._reportInvalidBoundaryContinuation("turn_end");
			return false;
		}
		return boundary.continue;
	}

	private _installAgentBoundaryHooks(): void {
		const previousFinishTurn = this.agent.finishTurn;
		this.agent.finishTurn = async (turn, signal) => {
			this._boundaryDispatchedMessages.add(turn.message);
			const extensionContinue = await this._dispatchTurnEndBoundary(turn.message, turn.toolResults);
			// dispose() during an awaited turn_end handler: abort() cannot stop natural continuations (queued
			// follow-ups, tool results), so end the low-level loop here, before any further hook, compaction or request.
			if (this._disposed) return { action: "end" };
			const previousDecision = await previousFinishTurn?.(turn, signal);
			if (previousDecision?.action === "end") return previousDecision;
			if (this._disposed) return { action: "end" };
			if (extensionContinue || previousDecision?.action === "continue") return { action: "continue" };
			return undefined;
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const context = await this._compactBeforeNextAssistantResponse(turn.context);
			const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
			const nextContext = previousSnapshot?.context ?? context;
			const runOptions = this._runSystemPromptOptions ?? this._baseSystemPromptOptions;
			const options = normalizeBuildSystemPromptOptions({
				...runOptions,
				selectedTools: this.getActiveToolNames(),
				toolSnippets: { ...this._baseSystemPromptOptions.toolSnippets, ...runOptions.toolSnippets },
				toolGuidelines: { ...this._baseSystemPromptOptions.toolGuidelines, ...runOptions.toolGuidelines },
			});
			const updateMessage = this._preparePromptAndToolLoadout(options, nextContext.messages);
			// Keep session.systemPrompt and ctx.getSystemPrompt() in step with what the provider sees.
			this._runSystemPromptOptions = options;

			return {
				...previousSnapshot,
				context: {
					...nextContext,
					tools: this.agent.state.tools.slice(),
				},
				messages: updateMessage
					? [...(previousSnapshot?.messages ?? []), updateMessage]
					: previousSnapshot?.messages,
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	private _refreshFinalizedContext(): void {
		const projection = this.sessionManager.buildSessionProjection();
		for (const entry of projection.entries) {
			for (const message of entry.messages) this._entryIdsByMessage.set(message, entry.sourceEntry.id);
		}
		this.agent.state.messages = projection.messages;
	}

	private _applyBoundaryDrafts(manager: SessionManager, drafts: SessionBoundaryDraft[]): SessionEntry[] {
		const appended: SessionEntry[] = [];
		for (const draft of drafts) {
			let entryId: string;
			switch (draft.type) {
				case "custom":
					entryId = manager.appendCustomEntry(draft.customType, draft.data);
					break;
				case "custom_message":
					entryId = manager.appendCustomMessageEntry(
						draft.customType,
						draft.content,
						draft.display,
						draft.details,
					);
					break;
				case "context_edit":
					entryId = manager.appendContextEdit(draft.targetId, draft.replacement);
					break;
				case "compaction": {
					const tokensBefore = estimateProjectedContextTokens(
						manager.buildSessionProjection(),
						manager.getBranch(),
					).tokens;
					entryId = manager.appendCompaction(
						draft.summary,
						draft.firstKeptEntryId,
						tokensBefore,
						draft.details,
						true,
						draft.usage,
					);
					break;
				}
			}
			const entry = manager.getEntry(entryId);
			if (entry) appended.push(entry);
		}
		return appended;
	}

	private _createBoundaryPreviewManager(drafts: SessionBoundaryDraft[]): SessionManager {
		const header = this.sessionManager.getHeader();
		if (!header) throw new Error("Session header is missing");
		const manager = SessionManager.inMemory(this._cwd, undefined, [header, ...this.sessionManager.getBranch()]);
		this._applyBoundaryDrafts(manager, drafts);
		return manager;
	}

	private _getPendingBoundaryMessages(): AgentMessage[] {
		const queued = this.agent.peekQueuedMessages();
		return [
			...queued.filter((message) => !this._customStore.has(message)),
			...[...this._customStore.values()].map((item) => item.handle),
		];
	}

	private _buildBoundaryContext(
		drafts: SessionBoundaryDraft[],
		boundary: "turn_end" | "agent_before_settle",
	): BoundaryContextPreview {
		const projection = this._createBoundaryPreviewManager(drafts).buildSessionProjection();
		const pendingMessages = this._getPendingBoundaryMessages();
		const llmMessages = convertToLlm(projection.messages);
		// The compaction boundary is not input: it never makes the context continuable.
		const finalRole = convertToLlm(projection.messages.filter((message) => !this.agent.isContextMarker?.(message)))
			.filter((message) => message.role !== "system" && message.role !== "developer")
			.at(-1)?.role;
		const contextCanContinue = finalRole !== undefined && finalRole !== "assistant";
		// Compaction notices are written at the next request boundary, not as a run of their own.
		const pendingCustomContext = [...this._customStore.values()].some(
			(item) => item.state === "buffered" && item.lane !== "notice" && !item.riderOf,
		);
		return {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			llmMessages,
			pendingMessages,
			canContinue:
				contextCanContinue ||
				pendingCustomContext ||
				(boundary === "turn_end"
					? this.agent.hasQueuedMessages()
					: finalRole === "assistant" && this.agent.hasQueuedMessages()),
		};
	}

	private async _commitBoundaryDrafts(drafts: SessionBoundaryDraft[]): Promise<void> {
		const appended = this._applyBoundaryDrafts(this.sessionManager, drafts);
		this._refreshFinalizedContext();
		for (const entry of appended) this._emit({ type: "entry_appended", entry });
		// After the whole batch is committed and the context refreshed: one event per change.
		for (const entry of appended) {
			// A handler may dispose the session: its runtime is invalidated, so no later event goes out.
			if (this._disposed) return;
			if (entry.type === "compaction" || entry.type === "context_edit") await this._emitSessionContextChange(entry);
		}
	}

	private _reportInvalidBoundaryContinuation(event: "turn_end" | "agent_before_settle"): void {
		this._extensionRunner.emitError({
			extensionPath: "<boundary>",
			event,
			error: `${event} requested continuation without runnable model context`,
		});
	}

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			outsideCompactionNoticeScope(() => l(event));
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	/** Only sends originating in this awaited dispatch become request-boundary notices. */
	private async _emitSessionCompact(event: SessionCompactEvent): Promise<void> {
		await withCompactionNoticeScope(this, () => this._extensionRunner.emit(event));
	}

	/** Context edits use the same source-scoped notice lane as compaction commits. */
	private async _emitSessionContextChange(entry: CompactionEntry | ContextEditEntry): Promise<void> {
		if (!this._extensionRunner.hasHandlers("session_context_change")) return;
		await withCompactionNoticeScope(this, () =>
			this._extensionRunner.emit({ type: "session_context_change", entry }),
		);
	}

	private async _emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			await this._extensionRunner.emit({ type: "session_compact_failed", ...event });
		}
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		this._schedulePendingCwd();
		if (!this.isIdle || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private async _emitAgentSettled(): Promise<void> {
		this._cacheWarmer?.onAgentSettled();
		this._isAgentRunActive = false;
		// The final flush can accept a trigger after the continuation loop exited. Its
		// queue handle still owns scheduling, but it needs a new run after settlement.
		// Never wake input from an aborted settlement or transfer an admitted handle.
		const pending = this.agent
			.peekQueuedMessages()
			.find((message) => this._customStore.get(message)?.state === "queued");
		if (pending && !this._agentRunAbortRequested && !this._disposed && !this._isSessionWriteBlocked()) {
			const admissionGen = this._admissionGen;
			this._deferredSettledActions.push(async () => {
				if (this._isAdmissionChanged(admissionGen) || this._agentRunAbortRequested || this._isSessionWriteBlocked())
					return;
				const item = this._customStore.get(pending);
				if (item?.state !== "queued" || !this.agent.removeQueued(pending)) return;
				item.state = "held";
				await this._startRun({ messageType: "custom", message: item.handle });
			});
		}
		this._isEmittingAgentSettled = true;
		try {
			const aborted = this._agentRunAbortRequested;
			await this._extensionRunner.emit({ type: "agent_settled", aborted });
			this._emit({ type: "agent_settled", aborted });
		} finally {
			this._isEmittingAgentSettled = false;
		}

		const deferred = this._deferredSettledActions.splice(0);
		if (deferred.length > 0) {
			try {
				for (const action of deferred) await action();
			} finally {
				this._resolveIdleWaitIfIdle();
				this._schedulePendingCwd();
			}
			return;
		}
		this._resolveIdleWaitIfIdle();
		this._schedulePendingCwd();
	}

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// No bash call survives a run: drop stale entries so a request without options cannot hang.
		if (event.type === "agent_start") this._settleAllBashHandoverWaiters();
		// Track bash calls before extensions see the event, so a handler can request a handover for it.
		if (event.type === "tool_execution_start" && event.toolName === "bash") {
			this._runningBashCalls.set(event.toolCallId, []);
		}
		// An abort requested while the run was starting, e.g. during before_agent_start, stops it
		// here. agent_start is awaited before the first request.
		if (event.type === "agent_start" && this._agentRunAbortRequested) this.agent.abort();
		// Record the calls a tool made through ctx.executeTool() and their usage on its result message.
		if (this._nestedToolCalls) {
			if (event.type === "message_start" && event.message.role === "toolResult") {
				const message = event.message;
				const summary = this._nestedToolCalls.takeRecord(message.toolCallId);
				if (summary?.calls) message.nestedCalls = summary.calls;
				if (summary?.usage) {
					message.usage = message.usage ? combineUsage(message.usage, summary.usage) : summary.usage;
				}
			} else if (event.type === "agent_end") {
				this._nestedToolCalls.clear();
			}
		}
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const queued = this._queuedUserInput.get(event.message);
			if (queued) {
				this._queuedUserInput.delete(event.message);
				const mirror = queued.lane === "steering" ? this._steeringMessages : this._followUpMessages;
				const index = mirror.indexOf(queued.text);
				if (index !== -1) mirror.splice(index, 1);
				this._emitQueueUpdate();
			}
		}

		// Transform hooks still precede persistence. An owned custom message's public receipt
		// follows its append and store retirement, so a listener never sees two owners.
		const ownedMessageEnd =
			event.type === "message_end" && [...this._customStore.values()].some((item) => item === event.admissionToken);
		await this._emitExtensionEvent(event);
		if (!ownedMessageEnd) {
			this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
		}

		if (event.type === "tool_execution_end") {
			this._settleBashHandoverWaiters(event.toolCallId);
		} else if (event.type === "agent_end") {
			this._settleAllBashHandoverWaiters();
		}

		// Handle session persistence
		if (event.type === "message_end") {
			let entryId: string | undefined;
			if (this._committedInstructions.has(event.message)) {
				// Queued developer instructions are committed before their lifecycle events.
			} else if (this._isUnwritableRunFailure(event.message)) {
				// The run's terminal error report cannot be written once the session refuses writes (§3.6).
				// Throwing here would skip turn_end/agent_end and leave the run without its end events.
			} else if (event.message.role === "custom") {
				// Custom message from extensions
				// Persist as CustomMessageEntry
				entryId = this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "system" ||
				event.message.role === "developer" ||
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				entryId = this.sessionManager.appendMessage(event.message);
			}
			let customReceipt: (() => void) | undefined;
			if (entryId) {
				this._entryIdsByMessage.set(event.message, entryId);
				// The loop captures this token for the whole batch before lifecycle awaits. A hook
				// replacing the message cannot transfer or destroy its pending ownership.
				for (const [handle, item] of this._customStore) {
					if (item === event.admissionToken) {
						this._customStore.delete(handle);
						customReceipt = this._takeCustomReceipt(item, { status: "committed", entryId });
					}
				}
			}
			try {
				if (ownedMessageEnd && entryId) this._emit(event);
				if (entryId && this._runStart?.message === event.message) this._runStart.persisted = true;
				if (entryId && (event.message.role === "user" || event.message.role === "custom"))
					this._inputArrived = true;
				// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

				if (event.message.role === "assistant") {
					const assistantMsg = event.message as AssistantMessage;
					this._lastAssistantMessage = assistantMsg;
					if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
						this._overflowRecoveryAttempted = false;
					}

					// Reset retry counter immediately on successful assistant response
					// This prevents accumulation across multiple LLM calls within a turn
					if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
						this._emit({
							type: "auto_retry_end",
							success: true,
							attempt: this._retryAttempt,
						});
						this._retryAttempt = 0;
					}
				}
			} finally {
				customReceipt?.();
			}
		}

		// A turn ends after its assistant message and every tool result has been appended,
		// so this is the first point in the run where a context-only custom message can be
		// inserted without landing between a tool call and its result. Flushing after the
		// extension and listener dispatch above also picks up messages that turn_end
		// handlers queued.
		if (event.type === "turn_end") {
			this._lastAssistantToolResults = event.toolResults;
			if (!this._agentRunAbortRequested) this._flushPendingCustomMessages({ keepCompactionNotices: true });
		}
	};

	/** After an ambiguous append the session refuses every write until it is reopened (§3.6). */
	private _isSessionWriteBlocked(): boolean {
		return this.sessionManager.getPersistenceError() !== undefined;
	}

	/**
	 * A terminal assistant error/abort while writes are blocked: the loop stops after it, and it cannot
	 * be written. Classified by session state and stop reason, never by its (wrappable) text.
	 */
	private _isUnwritableRunFailure(message: AgentMessage): boolean {
		return (
			this._isSessionWriteBlocked() &&
			message.role === "assistant" &&
			(message.stopReason === "error" || message.stopReason === "aborted")
		);
	}

	private async _requestNewSession(options?: RequestNewSessionOptions): Promise<RequestNewSessionResult> {
		if (this._pendingNewSessionRequest) {
			return { queued: false, reason: "already_pending" };
		}

		let resolveCompletion: (result: { cancelled: boolean }) => void = () => {};
		let rejectCompletion: (error: unknown) => void = () => {};
		const completion = new Promise<{ cancelled: boolean }>((resolve, reject) => {
			resolveCompletion = resolve;
			rejectCompletion = reject;
		});
		completion.catch(() => undefined);

		this._pendingNewSessionRequest = {
			options,
			resolve: resolveCompletion,
			reject: rejectCompletion,
		};
		return { queued: true, completion };
	}

	private async _drainPendingNewSessionRequest(): Promise<"none" | "cancelled" | "replaced" | "failed"> {
		const request = this._pendingNewSessionRequest;
		if (!request) {
			return "none";
		}
		this._pendingNewSessionRequest = undefined;

		const newSession = this._extensionCommandContextActions?.newSession;
		if (!newSession) {
			const error = new Error("ctx.requestNewSession() requires session replacement support in this mode.");
			request.reject(error);
			this._extensionRunner.emitError({
				extensionPath: "<runtime>",
				event: "request_new_session",
				error: error.message,
			});
			return "failed";
		}

		this._isDrainingNewSessionRequest = true;
		try {
			const result = await newSession(request.options);
			request.resolve(result);
			return result.cancelled ? "cancelled" : "replaced";
		} catch (error) {
			request.reject(error);
			this._extensionRunner.emitError({
				extensionPath: "<runtime>",
				event: "request_new_session",
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			return "failed";
		} finally {
			this._isDrainingNewSessionRequest = false;
		}
	}

	/** @internal Settle the outgoing runtime without waiting on its own deferred replacement. */
	async prepareForSessionReplacement(): Promise<void> {
		this._cancelPendingCwd("the session was closed or replaced");
		this._background.abortNotifications();
		if (!this._isDrainingNewSessionRequest) {
			await this.abort();
			return;
		}
		// The low-level run and its event handlers have finished. Public idle waiters
		// must still wait for replacement (or cancellation and queued continuations).
		await this.agent.waitForIdle();
		this._flushPendingBashMessages();
		this._flushPendingCustomMessages();
	}

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		// The post-run loop does not retry once writes are refused (§3.6).
		if (this._agentRunAbortRequested || this._isSessionWriteBlocked()) return false;
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	private _findPersistedMessageEntryId(message: AgentMessage): string | undefined {
		const mapped = this._entryIdsByMessage.get(message);
		if (mapped) return mapped;
		for (const entry of [...this.sessionManager.getBranch()].reverse()) {
			if (entry.type === "message" && entry.message === message) return entry.id;
		}

		const messageIndex = this.agent.state.messages.indexOf(message);
		if (messageIndex < 0) return undefined;
		const projection = this.sessionManager.buildSessionProjection();
		let projectedIndex = 0;
		for (const entry of projection.entries) {
			for (let i = 0; i < entry.messages.length; i++) {
				if (projectedIndex === messageIndex) {
					this._entryIdsByMessage.set(message, entry.sourceEntry.id);
					return entry.sourceEntry.id;
				}
				projectedIndex++;
			}
		}
		return undefined;
	}

	private async _omitRecoveryAttempt(message: AssistantMessage, toolResults: AgentMessage[] = []): Promise<void> {
		const targets = [message, ...toolResults];
		const targetIds = targets.map((target) => this._findPersistedMessageEntryId(target));
		const unresolvedProjectedTarget = targets.some(
			(target, index) => targetIds[index] === undefined && this.agent.state.messages.includes(target),
		);
		if (unresolvedProjectedTarget) {
			throw new Error("Cannot persist recovery omission because a projected message has no source entry");
		}
		const edits: ContextEditEntry[] = [];
		for (const targetId of targetIds) {
			if (!targetId) continue;
			const editId = this.sessionManager.appendContextEdit(targetId, null);
			const entry = this.sessionManager.getEntry(editId);
			if (entry) {
				this._emit({ type: "entry_appended", entry });
				if (entry.type === "context_edit") edits.push(entry);
			}
		}
		this._refreshFinalizedContext();
		for (const entry of edits) await this._emitSessionContextChange(entry);
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			this._isEmittingAgentEndExtensionEvent = true;
			try {
				await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
			} finally {
				this._isEmittingAgentEndExtensionEvent = false;
			}
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			if (event.message.role === "assistant" && !this._boundaryDispatchedMessages.delete(event.message)) {
				await this._dispatchTurnEndBoundary(event.message, event.toolResults);
			}
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement && this._committedInstructions.has(event.message)) {
				console.warn(
					"Ignoring a message_end replacement of a committed developer instruction: its lifecycle events are observation-only.",
				);
			} else if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
				...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		let active = true;
		const subscription: AgentSessionEventListener = (event) => {
			if (active) listener(event);
		};
		this._eventListeners.push(subscription);

		// Explicit unsubscription also retires a saved post-append observation.
		return () => {
			active = false;
			const index = this._eventListeners.indexOf(subscription);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(options?: { keepSessionResources?: boolean }): void {
		if (this._disposed || this._disposing) return;
		// Cancellation announces synchronously; observers must not admit new work.
		this._disposing = true;
		this.closeAdmission();
		// The runtime's internal cwd transfer is not a user stop of the applied request.
		if (!options?.keepSessionResources || this._pendingCwdChange?.state !== "applying")
			this._cancelPendingCwd("the session was closed or replaced");
		if (this._cwdImmediate) clearImmediate(this._cwdImmediate);
		this._cwdImmediate = undefined;
		this._background.abortNotifications();
		// A synchronous dispose cannot await handlers, but each terminal observer
		// must start before invalidation. Shutdown custom sends join the stop writer.
		this._isStoppingCustom = true;
		try {
			this._background.cancel("disposed", undefined, true);
			this._background.deliverBeforeInvalidation();
		} finally {
			this._isStoppingCustom = false;
		}
		this._branchGeneration++;
		this._disposed = true;
		this._agentRunAbortRequested = true;
		// Active admissions belong to the loop until unwind; idle owned items must be
		// receipted on this branch before the runtime is disconnected.
		try {
			this._writeStoppedCustomMessages();
		} catch (error) {
			this._extensionRunner.emitError({
				...SESSION_PERSISTENCE_REPORT,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		// A stop writer can also refuse without throwing. Never drop an admission that can still append.
		const callbacks: Array<() => void> = [];
		for (const [handle, item] of this._customStore) {
			if (item.state === "admitted") continue;
			this._customStore.delete(handle);
			this.agent.removeQueued(handle);
			const callback = this._takeCustomReceipt(item, { status: "dropped" });
			if (callback) callbacks.push(callback);
		}
		for (const callback of callbacks) callback();
		this._discardStaged();
		for (const pending of this._pendingInstructions.splice(0)) {
			try {
				this._commitInstruction(pending);
			} catch (error) {
				// The session is going away: report and drop.
				this._reportInstructionError(error);
			}
		}
		this._settleAllBashHandoverWaiters();
		this._bashHandoverRequests.clear();
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		if (this._cacheWarmer) {
			this._cacheWarmer.onWarmed = undefined;
			this._cacheWarmer.cancel();
		}
		if (!options?.keepSessionResources) cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Refresh the public finalized transcript from the canonical session projection. */
	refreshContext(): void {
		this._refreshFinalizedContext();
	}

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current cache-warming state and the policy inputs that produced it. */
	get cacheWarmingStatus(): CacheWarmingStatus | undefined {
		return this._cacheWarmer?.status;
	}

	/** Persist the cache-warming mode and immediately reconcile active warming. */
	setCacheWarmingMode(mode: CacheWarmingMode): void {
		this.settingsManager.setCacheWarmingMode(mode);
		this._cacheWarmer?.onModeChanged();
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Under a virtual selection, the physical model and thinking level of the latest successful response. */
	get routedModel(): { model: Model<any>; thinkingLevel?: ThinkingLevel } | undefined {
		if (!this.model || !isVirtualModel(this.model)) return undefined;
		const latest = findLatestResponse(this.agent.state.messages);
		const model = latest && this._modelRuntime.getPhysicalModel(latest.provider, latest.model);
		return model && { model, thinkingLevel: latest?.thinkingLevel };
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, compaction, branch summary, retry, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive && !this.isCompacting;
	}

	/** Current effective system prompt, including changes not yet sent to the model. */
	get systemPrompt(): string {
		return buildSystemPrompt(this._runSystemPromptOptions ?? this._baseSystemPromptOptions);
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools, which are the tools declared to the model.
	 * Tools with `codemode` or `deferred` exposure are callable from other tools without being active.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/** Get the names of the tools that tools can call through `ctx.executeTool()`. */
	getCallableToolNames(): string[] {
		return this._getCallableTools().map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			exposure: this._getToolExposure(definition.name),
			...(definition.namespace ? { namespace: definition.namespace } : {}),
			...(definition.annotations ? { annotations: { ...definition.annotations } } : {}),
			...(definition.reachesTools ? { reachesTools: definition.reachesTools } : {}),
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown and hidden tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const previous = this.getActiveToolNames();
		this._setActiveTools(toolNames);
		// A loadout that deactivates a tool replaces the restored one, whose pending tools are dropped.
		// One that only adds tools, like activating tool_search, keeps them.
		const active = new Set(this.getActiveToolNames());
		if (previous.some((name) => !active.has(name))) this._pendingToolNames.clear();
	}

	private _setActiveTools(toolNames: string[]): void {
		const tools = this._applyToolLoadout(toolNames);
		for (const tool of tools) this._pendingToolNames.delete(tool.name);
		this._rebuildSystemPrompt(tools.map((tool) => tool.name));
	}

	/**
	 * Whether `--tools` and `--exclude-tools` keep the tool registered. MCP tools stay registered
	 * unless the allowlist filters them (see `_allowlistFiltersMcp`).
	 */
	private _isAllowedTool(name: string): boolean {
		if (this._excludedTools?.(name)) return false;
		if (!this._allowedTools || this._allowedTools(name)) return true;
		return !this._allowlistFiltersMcp && isMcpToolName(name);
	}

	/**
	 * Whether the tool may be active, which declares it to the model. MCP tools the allowlist keeps
	 * without matching them are only for codemode and tool_search: they may be declared only when
	 * tool_search can load them (non-`direct` exposure and tool_search registered). This also applies
	 * to tools restored from the transcript or set by extensions.
	 */
	private _isActivatable(name: string): boolean {
		if (!this._allowedTools || this._allowedTools(name) || !isMcpToolName(name)) return true;
		return this._getToolExposure(name) !== "direct" && this._toolRegistry.has("tool_search");
	}

	private _getToolExposure(name: string): ToolExposure {
		return this._toolDefinitions.get(name)?.definition.exposure ?? "direct";
	}

	/**
	 * Tools callable through `ctx.executeTool()`: the active `direct` tools and every registered
	 * `codemode` or `deferred` tool.
	 */
	private _getCallableTools(active: ReadonlySet<string> = new Set(this.getActiveToolNames())): AgentTool[] {
		return [...this._toolRegistry.values()].filter((tool) => {
			const exposure = this._getToolExposure(tool.name);
			return exposure === "codemode" || exposure === "deferred" || (exposure === "direct" && active.has(tool.name));
		});
	}

	/**
	 * Set the agent's tools for the given active tool names and return them. The active tools are
	 * the registered, non-hidden ones; they are declared to the model. Active tools with a
	 * `prepareLoadout` hook can change the declared descriptions and hide declarations from
	 * requests (see {@link _installHiddenDeclarationsProjection}).
	 */
	private _applyToolLoadout(toolNames: string[]): AgentTool[] {
		const tools = [...new Set(toolNames)].flatMap((name) => {
			const tool = this._toolRegistry.get(name);
			return tool && this._getToolExposure(name) !== "hidden" && this._isActivatable(name) ? [tool] : [];
		});
		const hooks = tools.flatMap((tool) => {
			const entry = this._toolDefinitions.get(tool.name);
			return entry?.definition.prepareLoadout ? [entry] : [];
		});
		const hidden = new Set<string>();
		let hiddenOwner: string | undefined;
		let declared = tools;
		if (hooks.length > 0) {
			const loadout: ToolLoadout = {
				declared: tools,
				callable: this._getCallableTools(new Set(tools.map((tool) => tool.name))),
				registered: [...this._toolRegistry.values()],
				getExposure: (name) => this._getToolExposure(name),
				getNamespace: (name) => this._toolDefinitions.get(name)?.definition.namespace,
				getPromptGuidelines: (name) => this._toolPromptGuidelines.get(name) ?? [],
			};
			const descriptions = new Map<string, string>();
			for (const { definition, sourceInfo } of hooks) {
				try {
					const changes = definition.prepareLoadout?.(loadout);
					for (const [name, description] of Object.entries(changes?.descriptions ?? {})) {
						descriptions.set(name, description);
					}
					for (const name of changes?.hiddenDeclarations ?? []) {
						hidden.add(name);
						hiddenOwner ??= definition.name;
					}
				} catch (error) {
					this._extensionRunner.emitError({
						extensionPath: sourceInfo.path,
						event: "prepare_loadout",
						error: error instanceof Error ? error.message : String(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
				}
			}
			declared = tools.map((tool) => {
				const description = descriptions.get(tool.name);
				return description === undefined ? tool : { ...tool, description };
			});
		}
		this._hiddenDeclarations = hidden;
		this._hiddenDeclarationOwner = hiddenOwner;
		this.agent.state.tools = declared;
		return declared;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined ||
			this._manualBackgroundController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): void {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		for (const name of this._toolRegistry.keys()) {
			const snippet = this._toolPromptSnippets.get(name);
			// Tools without a snippet are not listed.
			if (snippet) toolSnippets[name] = snippet;
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : "";
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
			rendersToolCalls: this._extensionMode === "tui",
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			hiddenTools: [...this._hiddenDeclarations],
			toolSnippets,
			toolGuidelines: Object.fromEntries(this._toolPromptGuidelines),
		});
	}

	/**
	 * Apply a prompt and tool loadout for the next request. Sets the executable tools and
	 * returns a system message patching the prompt sections the model currently has (replayed
	 * from `messages`), or undefined when the prompt is unchanged. Tool changes are declared by
	 * the agent loop before the request.
	 *
	 * A forced prompt does not affect the transcript: the structured sections are still diffed
	 * and persisted, and the forced text is projected onto the request by
	 * {@link _installAgentForcedPromptProjection}.
	 */
	private _preparePromptAndToolLoadout(
		options: NormalizedBuildSystemPromptOptions,
		messages: AgentMessage[] = this.agent.state.messages,
	): SystemMessage | undefined {
		// Rendering belongs to the current binding, not the run's before_agent_start snapshot.
		// Refresh just this fact so active/preparing rebinds keep extension-owned run options.
		options.rendersToolCalls = this._extensionMode === "tui";
		options.selectedTools = this._applyToolLoadout(options.selectedTools).map((tool) => tool.name);
		// The tool list and rules must match the declarations the request carries.
		options.hiddenTools = [...this._hiddenDeclarations];
		const sections = diffSystemPromptSections(
			getCurrentSystemMessage(messages)?.sections ?? {},
			buildSystemPromptSections(options),
		);
		return sections ? { role: "system", content: "", sections, timestamp: Date.now() } : undefined;
	}

	/**
	 * Send a forced prompt as the provider's leading system prompt without recording it.
	 *
	 * A `before_agent_start` handler that returns `systemPrompt` needs that exact text at the
	 * head of the request; a mid-conversation system message would leave the original prompt
	 * in place. The forced text is a rendering of the current prompt, so the transcript keeps
	 * its structured sections and the request is projected instead: the system messages
	 * collapse into one head holding the forced text and the current tools. Runs after the
	 * `context` extension handlers.
	 */
	/**
	 * Remove the declarations that `prepareLoadout` hooks hide from every request. The whole
	 * transcript is filtered with the current set, so the projected declarations stay consistent
	 * across requests and only change when the loadout does.
	 */
	private _installHiddenDeclarationsProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const hidden = this._hiddenDeclarations;
			if (hidden.size === 0) return transformed;
			return transformed.map((message) => {
				if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
				const { toolsAdded, toolsRemoved, ...rest } = message;
				const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
				const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
				return {
					...rest,
					...(added.length > 0 ? { toolsAdded: added } : {}),
					...(removed.length > 0 ? { toolsRemoved: removed } : {}),
				};
			});
		};
	}

	private _installAgentForcedPromptProjection(): void {
		const previousTransformContext = this.agent.transformContext;
		this.agent.transformContext = async (messages, signal) => {
			const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
			const forced = this._runSystemPromptOptions?.forceSystemPrompt;
			if (forced === undefined) return transformed;
			const current = getCurrentSystemMessage(transformed);
			const head: SystemMessage = {
				role: "system",
				content: forced,
				...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
				timestamp: current?.timestamp ?? Date.now(),
			};
			return [head, ...transformed.filter((message) => message.role !== "system")];
		};
	}

	/**
	 * Restore the active tool loadout declared by the session transcript, if it declares one.
	 * Tools reachable only from other tools are never declared, but they do not depend on the active
	 * set, so the transcript's declarations are the whole loadout.
	 * @param modifiers `+name`/`-name` entries applied to the restored loadout.
	 */
	private _restoreToolsFromTranscript(modifiers: readonly string[] = []): void {
		this._pendingToolNames.clear();
		const current = getCurrentSystemMessage(this.sessionManager.buildSessionContext().messages);
		if (!current) return;
		const names = applyToolModifiers(
			(current.toolsAdded ?? []).map((tool) => tool.name),
			modifiers,
		);
		this._pendingToolNames = new Set(names.filter((name) => this._isAllowedTool(name)));
		this._setActiveTools(names);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * Start a run from a user or custom message. The session counts as busy from here on, so
	 * messages sent while before_agent_start handlers run are queued into this run instead of
	 * starting another, and an abort requested meanwhile aborts the run as soon as it exists.
	 * @param onStarted Called once the run's messages are prepared, before the first request.
	 */
	private async _startRun(
		trigger: BeforeAgentStartTrigger,
		onStarted?: () => void,
		admissionGen = this._admissionGen,
		deferredStart?: DeferredStart,
		onStartMessagePersistence?: (outcome: StartMessagePersistence) => void,
		manualAdmission?: { stopGeneration: number; followUp: boolean; onQueued(): void },
		startRecorded = false,
		cwdStopGeneration?: number,
	): Promise<void> {
		// Readiness barrier: a run requested during binding or reload starts after it. The loop awaits
		// only while a barrier exists, so its last check and the reservation below run in the same
		// continuation (no reload can slip in between, and back-to-back starts see this one as busy).
		while (this._readiness) {
			deferredStart?.follow();
			await this._readiness;
		}
		this._throwIfAdmissionChanged(admissionGen);
		this._throwIfCwdInputCancelled(cwdStopGeneration);
		// A stop during a newer readiness barrier must not revive the cwd wakeup afterwards.
		if (startRecorded && (trigger.messageType !== "custom" || this._cwdContinuation?.message !== trigger.message))
			return;
		// After an ambiguous append the session refuses runs until it is reopened (§3.6).
		const persistenceError = this.sessionManager.getPersistenceError();
		if (persistenceError) throw persistenceError;
		// Final synchronous admission check, after readiness, input and auth awaits.
		// A manual hold or a release spanning preflight transfers the prompt to its queue.
		if (
			trigger.messageType === "user" &&
			manualAdmission &&
			(this._manualBackgroundController || manualAdmission.stopGeneration !== this._manualBackgroundStopGeneration)
		) {
			if (manualAdmission.followUp) await this._queueFollowUp(trigger.prompt, trigger.images);
			else await this._queueSteer(trigger.prompt, trigger.images);
			deferredStart?.release();
			manualAdmission.onQueued();
			return;
		}
		// Input/auth preflight does not reserve a run. A starter that lost that race must not
		// reset abort state, consume queues, or apply its prompt/tool changes to the winner.
		if (this._isAgentRunActive) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		this._isAgentRunActive = true;
		this._cwdContinuation = undefined;
		this._agentRunAbortRequested = false;
		deferredStart?.release();
		let prepared: PreparedRun;
		let nextTurn: CustomMessage[] = [];
		const needsSnapshot = this._needsBootstrap();
		const bootstrap = needsSnapshot || this._stagedInstructions.length > 0 || this._stagedContent.length > 0;
		const failStart = (error: unknown): void => {
			this._isAgentRunActive = false;
			if (trigger.messageType === "custom") {
				const item = this._customStore.get(trigger.message);
				if (item) item.state = "buffered";
			}
			if (!this._isAdmissionChanged(admissionGen)) {
				if (bootstrap) {
					// Staged content is data: it waits for the next B instead of being committed (§3.6).
					this._stagePreflightBuffers();
				} else {
					this._flushPendingAtRunEnd();
				}
			}
			// nextTurn messages consumed by this run go back to the front (Sol F4b).
			this._pendingNextTurnMessages.unshift(...nextTurn);
			this._resolveIdleWaitIfIdle();
			if (this._agentRunAbortRequested && error instanceof Error && error.name === "AbortError") {
				if (trigger.messageType === "custom") return;
				if (onStartMessagePersistence) {
					try {
						onStartMessagePersistence({
							message: {
								role: "user",
								content: [{ type: "text", text: trigger.prompt }, ...(trigger.images ?? [])],
								timestamp: Date.now(),
							},
							persisted: false,
							stopped: true,
						});
					} catch {
						/* Observer only. */
					}
					return;
				}
			}
			throw error;
		};
		try {
			prepared = await this._prepareRun(trigger, admissionGen);
			// Loadout hooks can schedule shutdown in a microtask before this await resumes.
			this._throwIfAdmissionChanged(admissionGen);
		} catch (error) {
			return failStart(error);
		}
		// Consumed only after the final admission check (Sol F4b).
		nextTurn = this._pendingNextTurnMessages;
		this._pendingNextTurnMessages = [];
		let update = prepared.update;
		if (bootstrap) {
			try {
				await this._bootstrapCommit(
					needsSnapshot ? update : undefined,
					needsSnapshot,
					trigger.messageType === "user",
				);
				// A callback of B may have disposed the session or closed admission.
				this._throwIfAdmissionChanged(admissionGen);
			} catch (error) {
				return failStart(error);
			}
			if (needsSnapshot) update = undefined;
		} else {
			try {
				// Bash output and user-run context held during startup precede its starting messages.
				// Passive messages received during custom preflight instead wait for the turn boundary,
				// so they cannot precede their triggering notification.
				this._flushPendingBashMessages();
				if (trigger.messageType === "user") this._flushPendingCustomMessages();
				else {
					// An idle passive whose append failed still precedes a later same-key trigger.
					// Only earlier arrivals are eligible: passives received in this custom
					// preflight must remain behind their starter (or ride with it).
					const starter = this._customStore.get(trigger.message);
					for (const item of this._customStore.values()) {
						if (item === starter) break;
						if (item.key === starter?.key && this._isCustomWritable(item)) this._writeOwnedCustom(item);
					}
				}
			} catch (error) {
				return failStart(error);
			}
		}
		const messages: AgentMessage[] = [
			...(update ? [update] : []),
			...(startRecorded ? [] : [prepared.start]),
			...nextTurn,
			...prepared.returned,
		];
		const runStart = { message: prepared.start, persisted: startRecorded };
		this._runStart = runStart;
		onStarted?.();

		// Compaction before the prompt may have scheduled a retry; the new prompt replaces it.
		this._failedResponse = undefined;
		this._recordSelection();
		// The run records the loadout in the transcript; restored tools that did not register by now
		// are dropped, so a tool that never registers does not stay pending.
		this._pendingToolNames.clear();
		try {
			await this.agent.prompt(messages);
			this._recoverCustomAdmissions();
			// No retry, compaction, queued continuation or before-settle boundary once writes are blocked:
			// each would start another refused run; queued input stays queued (§3.6).
			while (!this._agentRunAbortRequested && !this._disposed && !this._isSessionWriteBlocked()) {
				if ((await this._drainPendingNewSessionRequest()) === "replaced" || this._disposed) break;
				// Each await below may hit the first refused write (e.g. a failed replacement's flush):
				// recheck before anything that would start another run.
				if (this._isSessionWriteBlocked()) break;
				// dispose() during an await below cannot cancel a run that has not started: recheck it too.
				if (await this._handlePostAgentRun()) {
					if (this._agentRunAbortRequested || this._disposed || this._isSessionWriteBlocked()) break;
					if (!(await this._gatePostRunContinuation())) break;
					await this.agent.continue();
					this._recoverCustomAdmissions();
					continue;
				}
				if (this._agentRunAbortRequested || !(await this._runBeforeSettleBoundary())) break;
				if (this._agentRunAbortRequested || this._disposed || this._isSessionWriteBlocked()) break;
				if (!(await this._gatePostRunContinuation())) break;
				await this.agent.continue();
				this._recoverCustomAdmissions();
			}
		} finally {
			// Settlement must always happen: nothing in the finalization may skip agent_settled.
			try {
				if (this._runStart === runStart) this._runStart = undefined;
				try {
					onStartMessagePersistence?.({ message: runStart.message, persisted: runStart.persisted });
				} catch {
					// An observer hook must not change how the run ends.
				}
				this._inputArrived = false;
				if (!this._disposed) this._commitPendingInstructionsAtRunEnd();
				if (this._agentRunAbortRequested) this._finishCancelledRetry();
				this._failedResponse = undefined;
				this._runSystemPromptOptions = undefined;
				this._recoverCustomAdmissions();
				this._flushPendingAtRunEnd();
				this._pendingNewSessionRequest?.resolve({ cancelled: true });
				this._pendingNewSessionRequest = undefined;
			} finally {
				if (this._disposed) {
					this._isAgentRunActive = false;
					this._resolveIdleWaitIfIdle();
				} else {
					await this._emitAgentSettled();
				}
			}
		}
	}

	/**
	 * Prepare a run and return its starting messages: compact first when needed, emit
	 * before_agent_start, apply the run's prompt options and tool loadout, and build the starting
	 * message followed by pending nextTurn messages (consumed here) and handler messages, with a
	 * system patch first when the prompt changed.
	 */
	private async _prepareRun(trigger: BeforeAgentStartTrigger, admissionGen: number): Promise<PreparedRun> {
		await this._backgroundGate("desired");
		// Check if we need to compact before sending (catches aborted responses).
		// The starting message is sent below, so do not call agent.continue() here.
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) {
			await this._checkCompaction(lastAssistant, false, [], "desired");
		}
		this._throwIfRunStopped();

		const selectedToolsBefore = this._baseSystemPromptOptions.selectedTools;
		let result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>;
		this._isPreparingRun = true;
		try {
			result = await this._extensionRunner.emitBeforeAgentStart(trigger, this._baseSystemPromptOptions);
		} finally {
			this._isPreparingRun = false;
		}
		this._throwIfAdmissionChanged(admissionGen);
		// Handlers may edit event.systemPromptOptions.selectedTools or call setActiveTools(),
		// which updates the live loadout instead. An explicit edit wins; otherwise the live
		// loadout is authoritative, so a setActiveTools() call is not undone here.
		const handlerEditedTools =
			result.systemPromptOptions.selectedTools.length !== selectedToolsBefore.length ||
			result.systemPromptOptions.selectedTools.some((name, index) => name !== selectedToolsBefore[index]);
		if (!handlerEditedTools) result.systemPromptOptions.selectedTools = this.getActiveToolNames();

		let start: AgentMessage;
		if (trigger.messageType === "custom") {
			start = trigger.message;
		} else {
			// Normalize images after before_agent_start so extension-driven model selection
			// determines the resize profile used for the request and history.
			const normalized = await this._normalizePromptImages(trigger.images);
			// Last await before consuming nextTurn context or applying the run's loadout.
			this._throwIfAdmissionChanged(admissionGen);
			const text =
				normalized.hints.length > 0 ? `${trigger.prompt}\n\n${normalized.hints.join("\n")}` : trigger.prompt;
			start = {
				role: "user",
				content: [{ type: "text", text }, ...normalized.images],
				timestamp: Date.now(),
			};
		}
		// Pending "nextTurn" messages are added by _startRun after the final admission check.
		const returned: AgentMessage[] = [];
		for (const msg of result.messages) {
			returned.push({
				role: "custom",
				customType: msg.customType,
				// Untyped extensions can pass null/missing content; normalize at ingestion.
				content: msg.content ?? [],
				display: msg.display,
				details: msg.details,
				timestamp: Date.now(),
			});
		}
		const update = this._preparePromptAndToolLoadout(result.systemPromptOptions);
		this._runSystemPromptOptions = result.systemPromptOptions;
		return { update, start, returned };
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const message = this._lastAssistantMessage;
		const toolResults = this._lastAssistantToolResults;
		this._lastAssistantMessage = undefined;
		this._lastAssistantToolResults = [];
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}
		if (!message) return this.agent.hasQueuedMessages();

		if (this._isRetryableError(message) && (await this._prepareRetry(message))) {
			if (this._agentRunAbortRequested) this._finishCancelledRetry();
			this._failedResponse = message;
			return !this._agentRunAbortRequested;
		}
		if (this._agentRunAbortRequested) {
			this._finishCancelledRetry();
			return false;
		}

		if (message.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(message, true, toolResults, "desired")) {
			return !this._agentRunAbortRequested;
		}

		// The low-level loop drains both queues before agent_end. Messages queued by
		// agent_end handlers require a fresh run before pre-settlement handlers fire.
		return !this._agentRunAbortRequested && this.agent.hasQueuedMessages();
	}

	private async _runBeforeSettleBoundary(): Promise<boolean> {
		if (!this._extensionRunner.hasHandlers("agent_before_settle")) return this.agent.hasQueuedMessages();
		this._isBeforeSettle = true;
		this._abortDuringBeforeSettle = false;
		try {
			const result = await this._extensionRunner.emitBoundary(
				{ type: "agent_before_settle", outcome: this._lastActivityOutcome },
				(entries) => this._buildBoundaryContext(entries, "agent_before_settle"),
			);
			if (this._disposed) return false;
			await this._commitBoundaryDrafts(result.entries);
			// A change handler may have disposed the session: settle without another run.
			if (this._disposed) return false;
			this._flushPendingCustomMessages({ keepCompactionNotices: true });
			const finalContext = this._buildBoundaryContext([], "agent_before_settle");
			if (this._abortDuringBeforeSettle) return false;
			const shouldContinue = result.continue || this.agent.hasQueuedMessages();
			if (shouldContinue && !finalContext.canContinue) {
				if (result.continue) this._reportInvalidBoundaryContinuation("agent_before_settle");
				return false;
			}
			return shouldContinue;
		} finally {
			this._isBeforeSettle = false;
		}
	}

	private async _runInputHandlers(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<{ text: string; images: ImageContent[] | undefined } | undefined> {
		if (!this._extensionRunner.hasHandlers("input")) {
			return { text, images };
		}

		const inputResult = await this._extensionRunner.emitInput(text, images, source, streamingBehavior);
		if (inputResult.action === "handled") {
			return undefined;
		}
		if (inputResult.action === "transform") {
			return { text: inputResult.text, images: inputResult.images ?? images };
		}
		return { text, images };
	}

	private async _normalizePromptImages(
		images: ImageContent[] | undefined,
	): Promise<{ images: ImageContent[]; hints: string[] }> {
		if (!images) return { images: [], hints: [] };

		const normalizedImages: ImageContent[] = [];
		const hints: string[] = [];
		for (const image of images) {
			const processed = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
				resizeOptions: this._limitsModel()?.inputLimits?.images?.resize,
			});
			if (!processed.ok) {
				hints.push(processed.message);
				continue;
			}
			normalizedImages.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
			hints.push(...processed.hints);
		}
		return { images: normalizedImages, hints };
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		// Input already in preflight owns this wakeup, even if an input/auth hook outlives binding.
		// If it is handled without a run, release the wakeup after that preflight instead.
		const pending = this._cwdContinuation;
		if (pending) pending.inputs++;
		try {
			await this._prompt(
				text,
				options,
				this._admissionGen,
				this._manualBackgroundStopGeneration,
				pending ? this._cwdInputStopGeneration : undefined,
			);
		} finally {
			if (pending) {
				pending.inputs--;
				this._startCwdContinuation(pending);
			}
		}
	}

	/**
	 * Stop admitting prompts: a prompt whose preflight is still running is cancelled before it is
	 * queued or starts a run, and later prompts are rejected. Used by RPC shutdown.
	 */
	closeAdmission(): void {
		this._cwdContinuation = undefined;
		this._admissionGen++;
		this._admissionClosed = true;
	}

	private async _prompt(
		text: string,
		options: PromptOptions | undefined,
		admissionGen: number,
		manualStopGeneration: number,
		cwdStopGeneration?: number,
	): Promise<void> {
		if (this._isEmittingAgentSettled) {
			this._deferredSettledActions.push(async () => {
				// Rejected, so preflightResult is not called (same as a prompt that throws).
				if (this._isAdmissionChanged(admissionGen)) return;
				await this._prompt(text, options, admissionGen, manualStopGeneration, cwdStopGeneration);
			});
			return;
		}
		if (!this._readiness)
			return this._promptWhenReady(text, options, admissionGen, undefined, manualStopGeneration, cwdStopGeneration);
		// Readiness barrier: commands, input hooks and expansion see the ready resources.
		const run = this._promptAfterReadiness(text, options, admissionGen, manualStopGeneration, cwdStopGeneration);
		const tracked = run.then(
			() => {},
			() => {},
		);
		this._deferredPrompts.add(tracked);
		void tracked.finally(() => this._deferredPrompts.delete(tracked));
		return run;
	}

	private async _promptAfterReadiness(
		text: string,
		options: PromptOptions | undefined,
		admissionGen: number,
		manualStopGeneration: number,
		cwdStopGeneration?: number,
	): Promise<void> {
		const deferredStart = this._trackDeferredStart();
		try {
			// Same no-gap rule as _startRun: the last readiness check and the dispatch below share a continuation.
			while (this._readiness) {
				deferredStart.follow();
				await this._readiness;
			}
			// Admission may have closed while waiting: no command or input hook runs then.
			this._throwIfAdmissionChanged(admissionGen);
			await this._promptWhenReady(
				text,
				options,
				admissionGen,
				deferredStart,
				manualStopGeneration,
				cwdStopGeneration,
			);
		} finally {
			deferredStart.release();
		}
	}

	/**
	 * Register a start deferred by the current readiness barrier. Each readiness wait calls `follow()`
	 * before awaiting, so a start always belongs to the barrier it is waiting on: meeting a newer
	 * barrier releases the older binder, and no bind or reload waits on a start that waits on a later
	 * barrier. The barrier holding it waits (after
	 * its own release) until the start reserves its run, settles, reaches extension code, or moves to
	 * a newer barrier (`follow()`). One set per barrier.
	 */
	private _trackDeferredStart(): DeferredStart {
		let released = false;
		let held: { starters: Set<Promise<void>>; ticket: Promise<void>; resolve: () => void } | undefined;
		const drop = () => {
			if (!held) return;
			held.starters.delete(held.ticket);
			held.resolve();
			held = undefined;
		};
		const follow = () => {
			if (released) return;
			const starters = this._readinessStarters;
			if (held?.starters === starters) return;
			drop();
			if (!starters) return;
			let resolve = () => {};
			const ticket = new Promise<void>((r) => {
				resolve = r;
			});
			starters.add(ticket);
			held = { starters, ticket, resolve };
		};
		follow();
		return {
			follow,
			release: () => {
				released = true;
				drop();
			},
		};
	}

	/**
	 * Wait for every prompt deferred by a readiness barrier to settle, including command, input-hook
	 * and auth preflight, then for the session to be idle. Print mode calls it after binding so that
	 * startup-triggered prompts complete before output and disposal (dispose cancels them instead).
	 * Never call it from extension code that a deferred prompt may itself be waiting on.
	 */
	async waitForDeferredPrompts(): Promise<void> {
		while (this._deferredPrompts.size > 0) {
			await Promise.all([...this._deferredPrompts]);
		}
		await this.waitForIdle();
	}

	private async _promptWhenReady(
		text: string,
		options: PromptOptions | undefined,
		admissionGen: number,
		deferredStart: DeferredStart | undefined,
		manualStopGeneration: number,
		cwdStopGeneration?: number,
	): Promise<void> {
		// Admission is checked on every path (also without a barrier) before commands or input hooks.
		this._throwIfAdmissionChanged(admissionGen);
		this._throwIfCwdInputCancelled(cwdStopGeneration);
		const releaseDeferred = () => deferredStart?.release();
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		// Handle extension commands first (execute immediately, even during streaming)
		// Extension commands manage their own LLM interaction via pi.sendMessage()
		if (expandPromptTemplates && text.startsWith("/")) {
			const handled = await this._tryExecuteExtensionCommand(text, releaseDeferred);
			if (handled) {
				// Extension command executed, no prompt to send
				preflightResult?.("handled");
				return;
			}
		}

		if (this._compactionAbortController !== undefined && !this._manualBackgroundController) {
			throw new Error(
				"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
			);
		}

		this._throwIfAdmissionChanged(admissionGen);
		const manualAtInput = this._manualBackgroundController;
		// Emit input event for extension interception (before skill/template expansion)
		if (this._extensionRunner.hasHandlers("input")) releaseDeferred();
		const processedInput = await this._runInputHandlers(
			text,
			options?.images,
			options?.source ?? "interactive",
			this.isStreaming ? options?.streamingBehavior : undefined,
		);
		if (!processedInput) {
			preflightResult?.("handled");
			return;
		}
		// A stop of the held cwd continuation also owns input still in async preflight.
		this._throwIfCwdInputCancelled(cwdStopGeneration);
		const { text: currentText, images: currentImages } = processedInput;

		// Expand skill commands (/skill:name args) and prompt templates (/template args)
		let expandedText = currentText;
		if (expandPromptTemplates) {
			expandedText = this._expandSkillCommand(expandedText);
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		}

		// If streaming (including run preflight), queue via steer() or followUp().
		if (this._manualBackgroundController || manualAtInput?.signal.aborted || this.isStreaming) {
			if (!this._manualBackgroundController && !manualAtInput?.signal.aborted && !options?.streamingBehavior) {
				throw new Error(
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			this._throwIfAdmissionChanged(admissionGen);
			if (options?.streamingBehavior === "followUp") {
				await this._queueFollowUp(expandedText, currentImages);
			} else {
				await this._queueSteer(expandedText, currentImages);
			}
			preflightResult?.("queued");
			return;
		}

		// Validate model
		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}

		let hasConfiguredAuth = this._modelRuntime.hasConfiguredAuth(this.model.provider);
		if (!hasConfiguredAuth) {
			// Async auth can run provider code: the binder does not wait for it.
			releaseDeferred();
			hasConfiguredAuth = (await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
		}
		if (!hasConfiguredAuth) {
			const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
			if (isOAuth) {
				throw new Error(
					`Authentication failed for "${this.model.provider}". ` +
						`Credentials may have expired or network is unavailable. ` +
						`Run '/login ${this.model.provider}' to re-authenticate.`,
				);
			}
			throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
		}

		await this._startRun(
			{ messageType: "user", prompt: expandedText, images: currentImages },
			() => preflightResult?.("started"),
			admissionGen,
			deferredStart,
			options?.onStartMessagePersistence,
			{
				stopGeneration: manualStopGeneration,
				followUp: options?.streamingBehavior === "followUp",
				onQueued: () => preflightResult?.("queued"),
			},
			false,
			cwdStopGeneration,
		);
	}

	private _throwIfCwdInputCancelled(stopGeneration: number | undefined): void {
		if (stopGeneration !== undefined && stopGeneration !== this._cwdInputStopGeneration)
			throw new Error("prompt cancelled: conversation stopped");
	}

	private _isAdmissionChanged(admissionGen: number): boolean {
		return this._admissionClosed || admissionGen !== this._admissionGen;
	}

	private _throwIfAdmissionChanged(admissionGen: number): void {
		if (this._isAdmissionChanged(admissionGen)) throw new Error("prompt cancelled: session shutting down");
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string, releaseDeferred: () => void = () => {}): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;
		// The binder never waits for a command: it may await ctx.reload() or anything else.
		releaseDeferred();

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	private async _queueUserInput(
		text: string,
		images: ImageContent[] | undefined,
		behavior: "steer" | "followUp",
		source: InputSource,
	): Promise<QueuedInputDisposition> {
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		const processedInput = await this._runInputHandlers(
			text,
			images,
			source,
			this.isStreaming ? behavior : undefined,
		);
		if (!processedInput) return "handled";

		let expandedText = this._expandSkillCommand(processedInput.text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		if (behavior === "steer") {
			await this._queueSteer(expandedText, processedInput.images);
		} else {
			await this._queueFollowUp(expandedText, processedInput.images);
		}
		return "queued";
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async steer(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "steer", options?.source ?? "interactive");
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @param options Input source; defaults to interactive
	 * @throws Error if text is an extension command
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<QueuedInputDisposition> {
		return this._queueUserInput(text, images, "followUp", options?.source ?? "interactive");
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) content.push(...images);
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		this._queuedUserInput.set(message, { text, lane: "steering" });
		this.agent.steer(message);
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) content.push(...images);
		const message: AgentMessage = { role: "user", content, timestamp: Date.now() };
		this._queuedUserInput.set(message, { text, lane: "followUp" });
		this.agent.followUp(message);
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	appendDeveloperMessage(content: string | TextContent[]): void {
		this._appendDeveloperMessage(content);
	}

	private _appendDeveloperMessage(content: string | TextContent[], owner?: ExtensionRunner): void {
		if (isBlankInstruction(content)) return;

		if (this.isStreaming && !this._isPreparingRun && !this._isEmittingAgentEndExtensionEvent) {
			throw new Error(
				"appendDeveloperMessage() can only be called while idle or from a before_agent_start or agent_end extension handler.",
			);
		}

		const pending = this._createPendingInstruction(content);
		pending.owner = owner;
		if (this._shouldStage()) {
			this._stagedInstructions.push(pending);
			return;
		}
		if (!this._drainPendingInstructions()) {
			// An earlier instruction still fails to commit: queue behind it (committed later, in order).
			this._pendingInstructions.push(pending);
			return;
		}
		this._commitInstruction(pending, { refresh: true });
	}

	/**
	 * Queue a passive developer instruction. Committed now while idle or from before_agent_start or
	 * agent_end handlers; during a run it is committed before the next anchored provider request (after that
	 * turn's tool results and steering messages), otherwise at run end or dispose. clearQueue() and
	 * abort() do not discard it. `onCommit` is called once with the entry id.
	 */
	queueDeveloperMessage(
		content: string | TextContent[],
		options?: QueueDeveloperMessageOptions,
	): QueueDeveloperMessageResult {
		return this._queueDeveloperMessage(content, options);
	}

	private _queueDeveloperMessage(
		content: string | TextContent[],
		options: QueueDeveloperMessageOptions | undefined,
		owner?: ExtensionRunner,
	): QueueDeveloperMessageResult {
		if (this._disposed) throw new Error("queueDeveloperMessage() cannot be called after the session is disposed.");
		if (isBlankInstruction(content)) throw new Error("queueDeveloperMessage() requires non-blank content.");
		const onCommit = options?.onCommit;
		const pending = this._createPendingInstruction(
			content,
			// A stale extension runtime's callback is skipped, not called (§3.7).
			onCommit && owner ? (entryId) => (owner.isInvalidated() ? undefined : onCommit(entryId)) : onCommit,
		);
		pending.owner = owner;
		if (this._shouldStage()) {
			this._stagedInstructions.push(pending);
			return { status: "staged", pendingId: pending.pendingId };
		}
		if (
			(!this.isStreaming || this._isPreparingRun || this._isEmittingAgentEndExtensionEvent) &&
			this._drainPendingInstructions()
		) {
			return { status: "committed", entryId: this._commitInstruction(pending, { refresh: true }) };
		}
		this._pendingInstructions.push(pending);
		return { status: "pending", pendingId: pending.pendingId };
	}

	/**
	 * Cancel an instruction that is still pending. A cancelled instruction is never committed and
	 * its onCommit callback is never called. Unknown, committing, committed or disposed returns false.
	 */
	cancelQueuedDeveloperMessage(pendingId: string): boolean {
		if (this._disposed) return false;
		const stagedIndex = this._stagedInstructions.findIndex((item) => item.pendingId === pendingId);
		if (stagedIndex !== -1) {
			this._stagedInstructions.splice(stagedIndex, 1);
			return true;
		}
		const index = this._pendingInstructions.findIndex(
			(item) => item.pendingId === pendingId && item.state === "pending",
		);
		if (index === -1) return false;
		this._pendingInstructions.splice(index, 1);
		return true;
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles four cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Streaming + triggerTurn false: appended to state/session once the current turn ends (sent from a
	 *   `session_compact` handler: at the next provider request boundary instead)
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: SendMessageOptions,
	): Promise<void> {
		if (options?.deliverAs === "nextTurn" && options.onReceipt)
			throw new Error('onReceipt is not supported with deliverAs "nextTurn"');
		if (this._disposed) throw new Error("sendCustomMessage() cannot be called after the session is disposed.");
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
			return;
		}
		const activeInput =
			this.isStreaming &&
			options?.triggerTurn !== false &&
			!this._isStoppingCustom &&
			!this._manualBackgroundController;
		const lane = activeInput
			? options?.deliverAs === "followUp"
				? "followUp"
				: "steer"
			: options?.triggerTurn
				? "trigger"
				: isCompactionNoticeSource(this)
					? "notice"
					: "passive";
		const item: OwnedCustomMessage = {
			handle: appMessage,
			key: options?.orderKey === undefined ? `type:${message.customType}` : `key:${options.orderKey}`,
			lane,
			state: activeInput ? "queued" : options?.triggerTurn ? "held" : "buffered",
			delivery: options?.deliverAs === "followUp" ? "followUp" : "steer",
			onReceipt: options?.onReceipt,
		};
		if (lane === "passive") {
			item.riderOf = [...this._customStore.values()].findLast(
				(older) =>
					older.key === item.key &&
					(older.lane === "steer" || (older.lane === "trigger" && older.delivery !== "followUp")) &&
					older.state !== "admitted",
			);
		}
		this._customStore.set(appMessage, item);
		// Reentrant notifications join this stop writer's arrival-ordered pass. A trigger
		// must not reserve a run while its predecessor's passive receipt is announced.
		if (this._isStoppingCustom) return;
		if (options?.triggerTurn && this._isEmittingAgentSettled) {
			// Acceptance owns the original handle now. Only its scheduling is deferred:
			// same-key passives can ride it and teardown can receipt it on this branch.
			const admissionGen = this._admissionGen;
			this._deferredSettledActions.push(async () => {
				if (this._isAdmissionChanged(admissionGen) || !this._customStore.has(appMessage)) return;
				if (this._agentRunAbortRequested) {
					this._writeStoppedCustomMessages();
					return;
				}
				if (!this._manualBackgroundController) await this._startOwnedCustomRun(item);
			});
			return;
		}
		if (activeInput) {
			if (lane === "followUp") this.agent.followUp(appMessage);
			else this.agent.steer(appMessage);
		} else if (options?.triggerTurn) {
			if (this._manualBackgroundController) return;
			await this._startOwnedCustomRun(item);
		} else if (!this.isStreaming) {
			this._flushPendingCustomMessages();
		}
	}

	private async _startOwnedCustomRun(item: OwnedCustomMessage): Promise<void> {
		try {
			await this._startRun({ messageType: "custom", message: item.handle });
		} catch (error) {
			if (this._customStore.has(item.handle)) item.state = "buffered";
			if (!this.isStreaming) this._flushPendingAtRunEnd();
			throw error;
		}
	}

	/** Queue entries are handles; the store owns every item through its append/staging receipt. */
	private _installCustomAdmissions(): void {
		const previousToken = this.agent.getMessageAdmissionToken;
		const previousRiders = this.agent.getMessageRiders;
		this.agent.getMessageAdmissionToken = (message) => {
			const item = this._customStore.get(message);
			if (!item) return previousToken?.(message);
			item.state = "admitted";
			return item;
		};
		this.agent.getMessageRiders = (message) => {
			const predecessor = this._customStore.get(message);
			return [
				...(previousRiders?.(message) ?? []),
				...[...this._customStore.values()]
					.filter((item) => item.riderOf === predecessor && predecessor !== undefined)
					.map((item) => item.handle),
			];
		};
	}

	/** Each low-level loop has unwound; recover failed receipts before any continuation drains younger handles. */
	private _recoverCustomAdmissions(): void {
		let recovered = false;
		const callbacks: Array<() => void> = [];
		for (const item of this._customStore.values()) {
			if (item.state !== "admitted") continue;
			if (this._disposed) {
				this._customStore.delete(item.handle);
				this.agent.removeQueued(item.handle);
				const callback = this._takeCustomReceipt(item, { status: "dropped" });
				if (callback) callbacks.push(callback);
				continue;
			}
			item.state = "buffered";
			item.riderOf = undefined;
			recovered = true;
		}
		for (const callback of callbacks) callback();
		if (recovered) this._flushPendingAtRunEnd();
	}

	private _isCustomWritable(item: OwnedCustomMessage): boolean {
		if (item.state !== "buffered") return false;
		if (item.riderOf && !this._customStore.has(item.riderOf.handle)) item.riderOf = undefined;
		if (item.riderOf) return false;
		if (item.lane === "notice") return true;
		for (const older of this._customStore.values()) {
			if (older === item) return true;
			if (
				older.key === item.key &&
				older.lane !== "followUp" &&
				older.lane !== "notice" &&
				!(older.lane === "trigger" && older.delivery === "followUp")
			)
				return false;
		}
		return false;
	}

	private _stageOwnedCustom(item: OwnedCustomMessage, announced: boolean): void {
		this._stagedContent.push({ message: structuredClone(item.handle), announced, onReceipt: item.onReceipt });
		item.onReceipt = undefined;
		this._customStore.delete(item.handle);
		this.agent.removeQueued(item.handle);
	}

	/** Synchronous receipt before announcement, including reentrant sends from listeners. */
	private _writeOwnedCustom(item: OwnedCustomMessage): void {
		if (!this._customStore.has(item.handle)) return;
		let callback: (() => void) | undefined;
		if (this._isStagingBranch()) this._stageOwnedCustom(item, true);
		else {
			const entryId = this._writeCustomMessage(item.handle);
			this._customStore.delete(item.handle);
			this.agent.removeQueued(item.handle);
			callback = this._takeCustomReceipt(item, { status: "committed", entryId });
		}
		try {
			this._announceCustomMessage(item.handle);
		} finally {
			callback?.();
		}
	}

	/** No request follows a stop. Do not overtake a batch still owned by the loop. */
	private _writeStoppedCustomMessages(): void {
		if (this._isWritingCustom || this._isSessionWriteBlocked()) return;
		if ([...this._customStore.values()].some((item) => item.state === "admitted")) return;
		this._isWritingCustom = true;
		this._isStoppingCustom = true;
		try {
			for (const item of this._customStore.values()) this._writeOwnedCustom(item);
		} finally {
			this._isStoppingCustom = false;
			this._isWritingCustom = false;
		}
	}

	private _writeCustomMessage(appMessage: CustomMessage): string {
		return this.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
		);
	}

	private _announceCustomMessage(appMessage: CustomMessage): void {
		this._refreshFinalizedContext();
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * Append custom messages queued while the agent was running.
	 * Called once the current turn's tool results are in agent state and session history.
	 */
	/**
	 * Write the bash and passive custom content buffered during a run, after its agent_end (or after a
	 * failed start). Never throws: a write failure here comes after the run's terminal events, so it
	 * keeps the unwritten items buffered, is reported once on the runtime error channel (RPC
	 * `extension_error`, interactive error line) and lets the run settle (§3.6). A sticky failure
	 * makes the next prompt refuse with the same text.
	 */
	private _flushPendingAtRunEnd(): void {
		try {
			this._flushPendingBashMessages();
			if (this._agentRunAbortRequested) this._writeStoppedCustomMessages();
			else this._flushPendingCustomMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Once writes are refused, these items live only in this session object: /resume and a
			// restart build a new session from the file, so they are lost (a transient failure retries).
			const kept = this._pendingBashMessages.length + this._customStore.size;
			const lost =
				kept > 0 && this._isSessionWriteBlocked()
					? kept === 1
						? " 1 buffered message of this run (bash result or extension message) was not written and is lost when the session is resumed or restarted."
						: ` ${kept} buffered messages of this run (bash results or extension messages) were not written and are lost when the session is resumed or restarted.`
					: "";
			this._extensionRunner.emitError({ ...SESSION_PERSISTENCE_REPORT, error: `${message}${lost}` });
		}
	}

	/**
	 * Write the buffered compaction notices at a provider request boundary, before the projection and the
	 * `context` hooks: after the boundary's input and tool results, so tool-call adjacency holds, and
	 * where the request sends them (F2). Other buffered passive messages keep waiting for the turn end.
	 * Skipped while writes are refused (the request is refused too); a failed append throws, which
	 * refuses the request, and keeps that notice and the later ones buffered (§3.6).
	 */
	private _flushCompactionNotices(): CustomMessage[] {
		const written: CustomMessage[] = [];
		if (this._isSessionWriteBlocked()) return written;
		for (const item of [...this._customStore.values()]) {
			if (item.lane !== "notice" || item.state !== "buffered") continue;
			// Writable older passives of the same key precede a notice; queued inputs never block it.
			for (const older of this._customStore.values()) {
				if (older === item) break;
				if (older.key === item.key && this._isCustomWritable(older)) {
					this._writeOwnedCustom(older);
					written.push(older.handle);
				}
			}
			if (!this._customStore.has(item.handle)) continue;
			this._writeOwnedCustom(item);
			written.push(item.handle);
		}
		return written;
	}

	/**
	 * `_flushCompactionNotices()` at a request boundary, then refuse the request when writes are refused:
	 * an announcement listener can hit a sticky append failure and swallow its error (§3.6).
	 */
	private _flushCompactionNoticesBeforeRequest(): CustomMessage[] {
		const written = this._flushCompactionNotices();
		const persistenceError = this.sessionManager.getPersistenceError();
		if (persistenceError) throw persistenceError;
		return written;
	}

	/**
	 * Write the buffered passive messages. Turn-end and before-settle drains pass `keepCompactionNotices`:
	 * compaction notices wait for the next request boundary (after its input, F2) or the run end, so they
	 * neither precede a queued follow-up nor become a trailing message a continuation would answer.
	 */
	private _flushPendingCustomMessages(options?: { keepCompactionNotices?: boolean }): void {
		// Kept, not dropped, while writes are blocked: a failing flush must not cut a run's end short.
		if (this._isSessionWriteBlocked()) return;
		if (this._isWritingCustom) return;
		const keepNotices = options?.keepCompactionNotices === true;
		this._isWritingCustom = true;
		try {
			for (const item of this._customStore.values()) {
				if (!this._isCustomWritable(item) || (keepNotices && item.lane === "notice")) continue;
				this._writeOwnedCustom(item);
			}
		} finally {
			this._isWritingCustom = false;
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 * @param options.expandPromptTemplates Whether to dispatch extension commands and expand skill commands and prompt templates. Default: false.
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Remove only user input still owned by the queues and return its text to the editor.
	 * Admitted input and non-user messages are never transferred.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const result: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
		for (const [handle, queued] of [...this._queuedUserInput]) {
			if (this.agent.removeQueued(handle)) result[queued.lane].push(queued.text);
			// A failed removal means the loop has already admitted it. It belongs only to the run,
			// never also to the editor, even before message_start updates the display mirror.
			this._queuedUserInput.delete(handle);
			const mirror = queued.lane === "steering" ? this._steeringMessages : this._followUpMessages;
			const index = mirror.indexOf(queued.text);
			if (index !== -1) mirror.splice(index, 1);
		}
		this._emitQueueUpdate();
		return result;
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Offer running model-invoked bash calls (or only `options.toolCallId`) to `bash_timeout`
	 * handlers with reason "steer". A call that started but has not spawned its process yet is
	 * offered once it spawns. Resolves with the number of calls taken over and completed.
	 */
	async requestBashHandover(options?: RequestBashHandoverOptions): Promise<number> {
		const toolCallIds =
			options?.toolCallId !== undefined
				? [options.toolCallId]
				: [...new Set([...this._runningBashCalls.keys(), ...this._bashHandoverRequests.keys()])];
		const results = await Promise.all(toolCallIds.map((toolCallId) => this._requestBashHandoverFor(toolCallId)));
		return results.filter(Boolean).length;
	}

	private _requestBashHandoverFor(toolCallId: string): Promise<boolean> {
		const request = this._bashHandoverRequests.get(toolCallId);
		if (request) return request().catch(() => false);
		const waiters = this._runningBashCalls.get(toolCallId);
		if (!waiters) return Promise.resolve(false);
		return new Promise((resolve) => waiters.push(resolve));
	}

	private _registerBashHandover(toolCallId: string, request: () => Promise<boolean>): () => void {
		this._bashHandoverRequests.set(toolCallId, request);
		const waiters = this._runningBashCalls.get(toolCallId)?.splice(0) ?? [];
		if (waiters.length > 0) {
			const result = request().catch(() => false);
			for (const resolve of waiters) void result.then(resolve);
		}
		return () => {
			if (this._bashHandoverRequests.get(toolCallId) === request) this._bashHandoverRequests.delete(toolCallId);
		};
	}

	private _settleBashHandoverWaiters(toolCallId: string): void {
		const waiters = this._runningBashCalls.get(toolCallId);
		this._runningBashCalls.delete(toolCallId);
		for (const resolve of waiters ?? []) resolve(false);
	}

	private _settleAllBashHandoverWaiters(): void {
		for (const toolCallId of [...this._runningBashCalls.keys()]) this._settleBashHandoverWaiters(toolCallId);
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	private _requestRunStop(): void {
		if (this._isAgentRunActive || this._isEmittingAgentSettled) this._agentRunAbortRequested = true;
		this._background.abortWait();
		this.agent.abort();
	}

	async abort(): Promise<void> {
		this._cancelPendingCwd("the conversation was stopped");
		this._requestRunStop();
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		if (this._isBeforeSettle) this._abortDuringBeforeSettle = true;
		this.agent.abort();
		if (!this._isAgentRunActive) this._writeStoppedCustomMessages();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured and saves to the session transcript.
	 * Persists to global defaults only when options.persist is true.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			this._addPersistedDefaultToNonEmptyScope(model);
		}

		// Apply thinking level for the new model.
		// Per-model thinking level overrides take priority over the global default.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	private _addPersistedDefaultToNonEmptyScope(model: Model<any>): void {
		if (this._scopedModels.length === 0) return;
		if (this._scopedModels.some((scoped) => modelsAreEqual(scoped.model, model))) return;

		this._scopedModels = [...this._scopedModels, { model }];

		const enabledModels = this.settingsManager.getEnabledModels();
		if (!enabledModels?.length) return;

		const modelReference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === modelReference.toLowerCase())) return;
		this.settingsManager.setEnabledModels([...enabledModels, modelReference]);
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);

		// Apply model
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
			this._addPersistedDefaultToNonEmptyScope(next.model);
		}

		// Apply thinking level for the new model.
		// - Explicit scoped model thinking level overrides defaults
		// - Per-model thinking level overrides take priority over the global default
		// setThinkingLevel clamps to model capabilities.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch(nextModel);
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
			this._addPersistedDefaultToNonEmptyScope(nextModel);
		}

		// Apply thinking level for the new model.
		// Model persistence does not implicitly rewrite the global thinking default.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves the clamped level to the session transcript only if the level actually changes.
	 * Persists the requested level to global defaults only when options.persist is true.
	 */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (options.persist) {
			this.settingsManager.setDefaultThinkingLevel(level);
		}

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		// Per-model default takes priority when switching to a model that has one
		if (targetModel) {
			const perModel = this.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			if (perModel !== undefined) {
				return perModel;
			}
		}
		return this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/** Start only on explicit request. The job owns its detached request policy until terminal. */
	startBackgroundCompaction(options: {
		source: "user" | "model";
		customInstructions?: string;
	}): CompactionJobStartResult {
		const selected = this.model;
		if (!selected) return { status: "unavailable", reason: "no-model" };
		const model = structuredClone(selected);
		const captured: SummarizationRequestContext = {
			messages: structuredClone(this.messages),
			thinkingLevel: this.thinkingLevel,
			streamFunction: this.agent.streamFunction,
			transport: this.agent.transport,
			retry: structuredClone(this.settingsManager.getRetrySettings()),
		};
		let accountingModel = model;
		return this._background.start({
			...options,
			settings: this.settingsManager.getCompactionSettings(model),
			blockingCompaction: !!(
				this._compactionAbortController ||
				this._autoCompactionAbortController ||
				this._branchSummaryAbortController
			),
			accountUsage: (usage) => {
				this.sessionManager.appendUsage(
					"background-compaction",
					accountingModel.provider,
					accountingModel.id,
					usage,
				);
			},
			summarize: async (request) => {
				const jobId = this._background.current!.id;
				const event = {
					type: "session_before_compact" as const,
					preparation: structuredClone(request.preparation),
					branchEntries: structuredClone(request.branch),
					customInstructions: request.customInstructions,
					reason: "manual" as const,
					willRetry: false,
					signal: request.signal,
					background: { jobId, source: options.source },
				};
				const hook = (await this._extensionRunner.emit(event)) as SessionBeforeCompactResult | undefined;
				// A signal-ignoring hook can finish after cancellation with billed usage.
				// Report it before rejecting the result; it must not revive or install the job.
				if (hook?.compaction?.usage && (hook.cancel || request.signal.aborted))
					request.onUsage(hook.compaction.usage);
				if (hook?.cancel) {
					this._background.cancel("extension-cancel", jobId);
					throw new DOMException("Compaction cancelled", "AbortError");
				}
				request.signal.throwIfAborted();
				if (hook?.compaction) return { ...hook.compaction, fromHook: true };
				// Resolve a virtual selection once against the launch transcript, not once per split/retry.
				const route = isVirtualModel(model)
					? await this._modelRuntime.resolveModel(model, convertToLlm(captured.messages), {
							reason: "direct",
							thinkingLevel: captured.thinkingLevel,
							signal: request.signal,
						})
					: { model, thinkingLevel: captured.thinkingLevel };
				request.signal.throwIfAborted();
				const physicalModel = structuredClone(route.model);
				accountingModel = physicalModel;
				const stream: StreamFn = async (_model, context, options) => {
					request.signal.throwIfAborted();
					const auth = await this._getSummarizationRequestAuth(physicalModel, request.signal, {
						...captured,
						thinkingLevel: route.thinkingLevel,
					});
					request.signal.throwIfAborted();
					return captured.streamFunction(auth.model, context, {
						...options,
						apiKey: auth.apiKey,
						headers: auth.headers,
						env: auth.env,
						transport: captured.transport,
					});
				};
				return compact(
					request.preparation,
					physicalModel,
					undefined,
					undefined,
					request.customInstructions,
					request.signal,
					route.thinkingLevel,
					stream,
					undefined,
					captured.retry,
					undefined,
					undefined,
					request.onUsage,
				);
			},
		});
	}

	getBackgroundCompaction() {
		const job = this._background.current;
		if (!job) return undefined;
		return {
			jobId: job.id,
			source: job.source,
			phase: job.phase,
			hardThreshold: this._hardCompactionThreshold(this._limitsModel()),
		};
	}

	cancelBackgroundCompaction(jobId?: string): boolean {
		const cancelled = this._background.cancel("user-cancel", jobId);
		if (cancelled && !this.isStreaming) this._writeStoppedCustomMessages();
		return cancelled;
	}

	private _hardCompactionThreshold(model: Model<any> | undefined): number {
		return model ? model.contextWindow - this.settingsManager.getCompactionSettings(this.model).reserveTokens : 0;
	}

	private _throwIfRunStopped(): void {
		if (this._disposed || (this.isStreaming && this._agentRunAbortRequested))
			throw new DOMException("The operation was aborted", "AbortError");
		const error = this.sessionManager.getPersistenceError();
		if (error) throw error;
	}

	private async _backgroundGate(carry: CompactionCarry, checkModel?: Model<any>, wait = false): Promise<boolean> {
		this._throwIfRunStopped();
		// Ordinary selections are live after a wait; an explicit virtual route stands.
		const resolveHardThreshold = () => this._hardCompactionThreshold(checkModel ?? this._limitsModel());
		const options = { carry, hardThreshold: resolveHardThreshold(), resolveHardThreshold };
		let result = await this._background.installReady(options);
		this._throwIfRunStopped();
		if (result.status === "applied") return true;
		if (wait && this._background.current) {
			result = await this._background.waitAndInstall(options);
			if (result.status === "aborted") throw new DOMException("The operation was aborted", "AbortError");
			this._throwIfRunStopped();
		}
		return result.status === "applied";
	}

	private async _gatePostRunContinuation(): Promise<boolean> {
		try {
			if (!this._failedResponse) await this._backgroundGate("desired");
			this._throwIfRunStopped();
			return true;
		} catch (error) {
			if (this._agentRunAbortRequested) return false;
			throw error;
		}
	}

	/** Explicit blocking adoption. The manual reservation covers append and all notifications. */
	async compactNow(
		customInstructions?: string,
	): Promise<
		BackgroundCompactionInstallResult | { status: "released" } | { status: "compacted"; result: CompactionResult }
	> {
		if (this._manualBackgroundController) throw new Error("Compaction is already in progress");
		do {
			await this.abort();
		} while (this.isStreaming);
		if (this._manualBackgroundController) throw new Error("Compaction is already in progress");
		const controller = new AbortController();
		this._manualBackgroundController = controller;
		let applied = false;
		try {
			const started = this.startBackgroundCompaction({ source: "user", customInstructions });
			if (started.status === "unavailable") {
				const result = await this._compactBlocking(customInstructions);
				applied = true;
				return { status: "compacted", result };
			}
			const result = await this._background.waitAndInstall({
				carry: "desired",
				hardThreshold: this._hardCompactionThreshold(this._limitsModel()),
				resolveHardThreshold: () => this._hardCompactionThreshold(this._limitsModel()),
				waitSignal: controller.signal,
			});
			applied = result.status === "applied";
			return result.status === "aborted" ? { status: "released" } : result;
		} finally {
			if (!applied || controller.signal.aborted) this._manualBackgroundStopGeneration++;
			if (this._manualBackgroundController === controller) this._manualBackgroundController = undefined;
			try {
				if (applied && !controller.signal.aborted && !this._disposed && !this._admissionClosed)
					this._releaseCompactionInput();
				else this._writeStoppedCustomMessages();
			} catch (error) {
				this._extensionRunner.emitError({
					...SESSION_PERSISTENCE_REPORT,
					error: error instanceof Error ? error.message : String(error),
				});
			} finally {
				this._resolveIdleWaitIfIdle();
			}
		}
	}

	/** Installation opens admission before starting held input; release/stop never starts it. */
	private _releaseCompactionInput(): void {
		const triggers = [...this._customStore.values()].filter(
			(item) => item.state === "held" && item.lane === "trigger",
		);
		const first = triggers.shift();
		for (const item of triggers) {
			item.state = "queued";
			item.lane = item.delivery ?? "steer";
			if (item.lane === "followUp") this.agent.followUp(item.handle);
			else this.agent.steer(item.handle);
		}
		let run: Promise<void> | undefined;
		if (first) run = this._startRun({ messageType: "custom", message: first.handle });
		else {
			for (const [handle, queued] of this._queuedUserInput) {
				if (!this.agent.removeQueued(handle)) continue;
				this._queuedUserInput.delete(handle);
				const mirror = queued.lane === "steering" ? this._steeringMessages : this._followUpMessages;
				const index = mirror.indexOf(queued.text);
				if (index !== -1) mirror.splice(index, 1);
				this._emitQueueUpdate();
				run = this._startRun({
					messageType: "user",
					prompt: queued.text,
					images:
						handle.role === "user" && Array.isArray(handle.content)
							? handle.content.filter((part): part is ImageContent => part.type === "image")
							: undefined,
				});
				break;
			}
		}
		void run?.catch((error) =>
			this._extensionRunner.emitError({
				extensionPath: "<runtime>",
				event: "send_message",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}

	private async _raceCompaction<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
		let stop = () => {};
		try {
			return await new Promise<T>((resolve, reject) => {
				stop = () => reject(new DOMException("Compaction cancelled", "AbortError"));
				if (signal.aborted) stop();
				else signal.addEventListener("abort", stop, { once: true });
				void operation.then(resolve, reject);
			});
		} finally {
			signal.removeEventListener("abort", stop);
		}
	}

	/** Generate Pi's built-in compaction summary for manual and automatic compaction. */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		model: Model<any>,
		customInstructions: string | undefined,
		signal: AbortSignal,
		reason: "manual" | "threshold" | "overflow",
	): Promise<CompactionResult> {
		// Resolve the request only when Pi summarizes itself: routing may call models or fail.
		const request = await this._getSummarizationRequestAuth(model, signal);
		return compact(
			preparation,
			request.model,
			request.apiKey,
			request.headers,
			customInstructions,
			signal,
			request.thinkingLevel,
			this.agent.streamFunction,
			request.env,
			this.settingsManager.getRetrySettings(),
			this._summarizationRetryCallbacks({ source: "compaction", reason }),
			undefined, // sessionId
		);
	}

	private _clearManualCompactionState(): void {
		this._compactionAbortController = undefined;
		this._resolveIdleWaitIfIdle();
		this._schedulePendingCwd();
	}

	/**
	 * Manually compact the session context.
	 *
	 * This is the blocking SDK/extension entry point. Interactive and RPC compaction
	 * use startBackgroundCompaction()/compactNow(). It is separate from the safety
	 * net's threshold/overflow compaction, which enters through
	 * `_checkCompaction()` and `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * Aborts the current agent operation first. Manual compaction never retries or
	 * continues the interrupted agent turn.
	 *
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		return this._compactBlocking(customInstructions);
	}

	private async _compactBlocking(customInstructions?: string): Promise<CompactionResult> {
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });
		let fromExtension = false;
		let cancelledByExtension = false;

		try {
			const model = this.model;
			if (!model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const settings = this.settingsManager.getCompactionSettings(model);
			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._raceCompaction(
					this._extensionRunner.emit({
						type: "session_before_compact",
						preparation,
						branchEntries: pathEntries,
						customInstructions,
						reason: "manual",
						willRetry: false,
						signal: this._compactionAbortController.signal,
					}),
					this._compactionAbortController.signal,
				)) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by automatic compaction.
				const result = await this._raceCompaction(
					this._runDefaultCompaction(
						preparation,
						model,
						customInstructions,
						this._compactionAbortController.signal,
						"manual",
					),
					this._compactionAbortController.signal,
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			const { entry: savedCompactionEntry, delivered } = this._appendCompactionWithCarry(
				[summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage],
				"desired",
			);
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			await this._emitStandingDelivered(delivered);
			if (this._extensionRunner && savedCompactionEntry) {
				await this._emitSessionCompact({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = this._compactionAbortController.signal.aborted || cancelledByExtension;
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			await this._emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension,
			});
			throw error;
		} finally {
			this._clearManualCompactionState();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._background.abortWait();
		this._manualBackgroundController?.abort();
		if (this._isAgentRunActive && this.isCompacting) this._requestRunStop();
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Dispatch automatic compaction after `agent_end` or before prompt submission.
	 * Manual compaction does not call this method; it enters through `compact()`.
	 *
	 * Automatic cases:
	 * 1. Overflow with retry: a context-overflow error or recoverable length stop;
	 *    remove the failed assistant message, compact, and retry the turn once.
	 * 2. Overflow without retry: a successful response exceeded the configured
	 *    context window; compact but preserve the completed response.
	 * 3. Threshold without retry: valid or estimated context usage crossed the
	 *    configured threshold; compact without retrying the completed response.
	 *
	 * Each case calls `_runAutoCompaction()`. After preparation and the
	 * `session_before_compact` hook, that method calls the lower-level `compact()`
	 * function imported from `./compaction/index.ts`, unless the hook cancels or
	 * supplies a custom result.
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 * @returns Whether the post-run loop should call `agent.continue()` for overflow recovery or queued messages
	 */
	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		toolResults: AgentMessage[] = [],
		carry: CompactionCarry = "delivered",
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings(this.model);
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model. Under a virtual selection, the
		// physical model that produced the message supplies the limits.
		const messageModel = this._modelForMessage(assistantMessage);
		const sameModel = messageModel !== undefined;
		const contextWindow = (messageModel ?? this.model)?.contextWindow ?? 0;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Automatic cases 1 and 2: context overflow.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		const currentProjection = this.sessionManager.buildSessionProjection();
		const assistantEntryId = this._findPersistedMessageEntryId(assistantMessage);
		const assistantIsProjected =
			assistantEntryId === undefined ||
			currentProjection.entries.some(
				(entry) =>
					entry.sourceEntry.id === assistantEntryId &&
					entry.messages.some((message) => message.role === "assistant"),
			);
		const branch = this.sessionManager.getBranch();
		const assistantIndex = assistantEntryId ? branch.findIndex((entry) => entry.id === assistantEntryId) : -1;
		const entriesAfterAssistant = assistantIndex >= 0 ? branch.slice(assistantIndex + 1) : [];
		const hasPostAssistantContextEdit = entriesAfterAssistant.some((entry) => entry.type === "context_edit");
		const latestAssistantEdit = entriesAfterAssistant
			.filter(
				(entry): entry is ContextEditEntry => entry.type === "context_edit" && entry.targetId === assistantEntryId,
			)
			.at(-1);
		const assistantRetainedForExplicitRecovery =
			assistantEntryId === undefined ||
			(!entriesAfterAssistant.some((entry) => entry.type === "compaction") &&
				latestAssistantEdit?.replacement !== null);
		const assistantUsageMatchesProjection = assistantIsProjected && !hasPostAssistantContextEdit;
		const explicitOverflow = assistantMessage.stopReason === "error" && isContextOverflow(assistantMessage);
		const contextOverflow =
			sameModel &&
			((explicitOverflow && assistantRetainedForExplicitRecovery) ||
				(assistantUsageMatchesProjection && isContextOverflow(assistantMessage, contextWindow)));
		const recoverableLength =
			sameModel && assistantIsProjected && isRecoverableLength(assistantMessage, messageModel.maxTokens);
		if (contextOverflow || recoverableLength) {
			const willRetry = assistantMessage.stopReason !== "stop";

			// Case 2: the response completed successfully. Compact, but do not retry because
			// agent.continue() cannot continue from a completed assistant response.
			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false, carry);
			}

			if (this._overflowRecoveryAttempted) {
				const errorMessage = contextOverflow
					? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: "Truncated response recovery failed after one compact-and-retry attempt.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason: "overflow",
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
				return false;
			}

			// Persistently omit the selected final attempt before post-run recovery compaction.
			this._overflowRecoveryAttempted = true;
			await this._omitRecoveryAttempt(assistantMessage, toolResults);
			// The omission's context-change handlers are awaited: an abort, disposal or refused write meanwhile
			// must not start the recovery compaction.
			if (this._agentRunAbortRequested || this._disposed || this._isSessionWriteBlocked()) return false;
			const retry = await this._runAutoCompaction("overflow", willRetry);
			if (retry) this._failedResponse = assistantMessage;
			return retry;
		}

		// Case 3: threshold compaction without retry.
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const projection = currentProjection;
		const hasContextEdits = projection.entries.some((entry) => entry.sourceEntry.type === "context_edit");
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (hasContextEdits) {
			contextTokens = estimateProjectedContextTokens(projection, branch).tokens;
		} else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			// Without provider usage, estimate.tokens is the pure message-size estimate.
			// Only usage-backed estimates need the stale pre-compaction check.
			if (estimate.lastUsageIndex !== null) {
				// Verify the usage source is post-compaction. Kept pre-compaction messages
				// have stale usage reflecting the old (larger) context and would falsely
				// trigger compaction right after one just finished.
				const usageMsg = messages[estimate.lastUsageIndex];
				if (
					compactionEntry &&
					usageMsg.role === "assistant" &&
					(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
				) {
					return false;
				}
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false, carry);
		}
		return false;
	}

	/**
	 * Execute threshold or overflow compaction. Manual compaction uses
	 * `AgentSession.compact()` instead. Both paths call the lower-level `compact()`
	 * function imported from `./compaction/index.ts` after preparation and extension
	 * interception.
	 *
	 * @param reason Automatic trigger selected by `_checkCompaction()`
	 * @param willRetry Whether to continue the interrupted turn after overflow compaction
	 * @returns Whether the post-run loop should call `agent.continue()`
	 */
	private async _runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		carry: CompactionCarry = "delivered",
		checkModel?: Model<any>,
	): Promise<boolean> {
		try {
			if (await this._backgroundGate(carry, checkModel, true)) return willRetry || this.agent.hasQueuedMessages();
		} catch (error) {
			if (this._agentRunAbortRequested) return false;
			throw error;
		}
		const model = this.model;
		const settings = this.settingsManager.getCompactionSettings(model);
		let abortController: AbortController | undefined;
		let started = false;
		let fromExtension = false;
		let cancelledByExtension = false;

		try {
			// After dispose() nothing would cancel the fresh controller below, and the session must not change.
			if (!model || this._disposed) {
				return false;
			}

			const pathEntries = this.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			abortController = new AbortController();
			this._autoCompactionAbortController = abortController;
			started = true;
			this._emit({ type: "compaction_start", reason });
			abortController.signal.throwIfAborted();

			let extensionCompaction: CompactionResult | undefined;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._raceCompaction(
					this._extensionRunner.emit({
						type: "session_before_compact",
						preparation,
						branchEntries: pathEntries,
						customInstructions: undefined,
						reason,
						willRetry,
						signal: abortController.signal,
					}),
					abortController.signal,
				)) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					cancelledByExtension = true;
					throw new Error("Compaction cancelled");
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}
			abortController.signal.throwIfAborted();

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Shared default summary generator, also used by manual compaction.
				const compactResult = await this._raceCompaction(
					this._runDefaultCompaction(preparation, model, undefined, abortController.signal, reason),
					abortController.signal,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}
			abortController.signal.throwIfAborted();

			const { entry: savedCompactionEntry, delivered } = this._appendCompactionWithCarry(
				[summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage],
				carry,
			);
			this._refreshFinalizedContext();
			const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);

			await this._emitStandingDelivered(delivered);
			if (this._extensionRunner && savedCompactionEntry) {
				await this._emitSessionCompact({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) return true;

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const message = error instanceof Error ? error.message : "compaction failed";
			const aborted = abortController?.signal.aborted === true || cancelledByExtension;
			// An extension veto cancels the compaction, not the enclosing run. Only
			// an actual abort (Escape/Q13) suppresses the next request.
			if (abortController?.signal.aborted && this.isStreaming) this._requestRunStop();
			if (started) {
				const errorMessage = aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${message}`
						: `Auto-compaction failed: ${message}`;
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason,
					errorMessage,
					aborted,
					willRetry: false,
					fromExtension,
				});
			}
			return false;
		} finally {
			if (this._autoCompactionAbortController === abortController) {
				this._autoCompactionAbortController = undefined;
			}
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (this._readiness) {
			throw new Error("Cannot bind extensions while extensions are binding or reloading");
		}
		const barrier = this._beginReadiness();
		try {
			await this._bindExtensions(bindings);
		} finally {
			barrier.release();
		}
		await barrier.deferredStarts();
	}

	/**
	 * Install the readiness barrier. `release()` always releases it; `deferredStarts()` then resolves once
	 * every start this barrier deferred has reserved its run, settled, or reached extension code.
	 */
	private _beginReadiness(): { release: () => void; deferredStarts: () => Promise<void> } {
		let resolve = () => {};
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		const starters = new Set<Promise<void>>();
		this._readiness = promise;
		this._readinessStarters = starters;
		return {
			release: () => {
				if (this._readiness === promise) {
					this._readiness = undefined;
					this._readinessStarters = undefined;
				}
				resolve();
				this._schedulePendingCwd();
			},
			deferredStarts: async () => {
				while (starters.size > 0) await Promise.all([...starters]);
			},
		};
	}

	private async _bindExtensions(bindings: ExtensionBindings): Promise<void> {
		this._extensionsBound = true;
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
			// Bind before session_start so startup prompts see the mode's stable rendering facts.
			this._rebuildSystemPrompt(this.getActiveToolNames());
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		this._extensionRunner.reportUnhandledMcpServers();
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._rebuildSystemPrompt(this.getActiveToolNames());
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = isSyntheticPath(entry.extensionPath) ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (isSyntheticPath(extensionPath)) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					if (options?.deliverAs === "nextTurn" && options.onReceipt)
						throw new Error('onReceipt is not supported with deliverAs "nextTurn"');
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendDeveloperMessage: (content) => {
					this._appendDeveloperMessage(content, runner);
				},
				queueDeveloperMessage: (content, options) => this._queueDeveloperMessage(content, options, runner),
				cancelQueuedDeveloperMessage: (pendingId) => this.cancelQueuedDeveloperMessage(pendingId),
				setStandingInstruction: (key, content, options) => this.setStandingInstruction(key, content, options),
				clearStandingInstruction: (key) => this.clearStandingInstruction(key),
				getStandingInstruction: (key) => this.getStandingInstruction(key),
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				getSettings: () => this.settingsManager.getSettings(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				getStagedMessages: () => this.stagedMessages.map((message) => structuredClone(message)),
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				startBackgroundCompaction: (options) => this.startBackgroundCompaction(options),
				cancelBackgroundCompaction: (jobId) => this.cancelBackgroundCompaction(jobId),
				getBackgroundCompaction: () => this.getBackgroundCompaction(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				requestNewSession: (options) => this._requestNewSession(options),
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
				requestBashHandover: (options) => this.requestBashHandover(options),
				executeTool: (callerId, name, args, options) => this._executeNestedToolCall(callerId, name, args, options),
				getCallableTools: () => this._getCallableTools(),
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
				registerVirtualModel: (definition) => {
					this._modelRuntime.registerVirtualModel(definition);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterVirtualModel: (provider, id) => {
					this._modelRuntime.unregisterVirtualModel(provider, id);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: {
		activeToolNames?: string[];
		includeAllExtensionTools?: boolean;
		previousDefaultActiveToolNames?: string[];
	}): void {
		// Tools that were already activated on registration. A tool whose exposure changes to
		// `direct` or `model-only` (for example from `hidden`) is activated like a new tool.
		const previousActivatedOnRegistration = new Set(
			options?.previousDefaultActiveToolNames ??
				[...this._toolRegistry.keys()].filter((name) => this._isActivatedOnRegistration(name)),
		);
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedTools = this._allowedTools;

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => this._isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => this._isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => this._isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${definition.name}`, {
						source: "builtin",
					}),
				})),
			runner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => this._isAllowedTool(name));

		if (allowedTools) {
			for (const toolName of this._toolRegistry.keys()) {
				// Naming or matching a tool activates it even when it is not active by default. MCP tools
				// kept registered without being named stay inactive.
				if (allowedTools(toolName) && this._isDeclarable(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				if (this._isActivatedOnRegistration(tool.name)) nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames || options.previousDefaultActiveToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousActivatedOnRegistration.has(toolName) && this._isActivatedOnRegistration(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}
		// Pending tools that are registered now become active.
		nextActiveToolNames.push(...this._pendingToolNames);

		this._setActiveTools([...new Set(nextActiveToolNames)]);
	}

	/** Whether activating the tool declares it to the model. */
	private _isDeclarable(name: string): boolean {
		const exposure = this._getToolExposure(name);
		return exposure === "direct" || exposure === "model-only";
	}

	/** Whether registering the tool activates it, which declares it to the model. */
	private _isActivatedOnRegistration(name: string): boolean {
		return this._isDeclarable(name) && this._toolDefinitions.get(name)?.definition.defaultActive !== false;
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
		previousDefaultActiveToolNames?: string[];
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: {
						commandPrefix: shellCommandPrefix,
						shellPath,
						// Reads the runner at call time so extension reloads apply without rebuilding tools.
						onTimeout: (event) => {
							const runner = this._extensionRunner;
							if (!runner?.hasHandlers("bash_timeout")) return;
							return runner.emit(event);
						},
						registerHandover: (toolCallId, request) => this._registerBashHandover(toolCallId, request),
						onBackground: (event) => {
							const runner = this._extensionRunner;
							if (!runner?.hasHandlers("bash_background")) return;
							return runner.emitBashBackground(event);
						},
					},
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._extensionRunner.setRequestCwdChange(
			this._cwdChangeHandler ? (path, options) => this.requestCwdChange(path, options) : undefined,
		);
		this._extensionRunner.setBeforeShutdown(async (event) => {
			this._requestRunStop();
			this.abortCompaction();
			this._background.abortNotifications();
			this._background.cancel(
				event.reason === "reload" || event.reason === "cwd" ? "reload" : "disposed",
				undefined,
				true,
			);
			this._background.deliverBeforeInvalidation();
			// Terminal consumers have started on the valid outgoing branch. Unrelated
			// signal-ignoring observers must not own shutdown's completion.
			this._background.abortNotifications();
			await this._background.flushEvents();
		});
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
			previousDefaultActiveToolNames: options.previousDefaultActiveToolNames,
		});
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const backgroundOperation = this._background.current?.phase === "claimed" || !!this._manualBackgroundController;
		if (this._readiness || ((this._isAgentRunActive || this.isCompacting) && !backgroundOperation)) {
			throw new Error("Cannot reload while a run is active, compaction is running, or extensions are binding");
		}
		// Reserve readiness before releasing a claimed wait: new prompts cannot enter
		// the outgoing runtime, and the stopped run must unwind before it is replaced.
		const barrier = this._beginReadiness();
		try {
			this._requestRunStop();
			this.abortCompaction();
			this._background.cancel("reload", undefined, true);
			this._background.deliverBeforeInvalidation();
			this._background.abortNotifications();
			await this.waitForIdle();
			this._branchGeneration++;
			await this._reload(options);
		} finally {
			barrier.release();
		}
		await barrier.deferredStarts();
	}

	private async _reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		// Staged instructions created through the extension API belong to the old runtime. A bound
		// session's extensions rebuild them from the journal at session_start(reload); a never-bound
		// session keeps them without onCommit (its runtime is invalidated). Staged content is kept (§3.7).
		this._releaseExtensionStagedInstructions();
		// A due latch belongs to the runtime being replaced (§7.3); derivation keeps the value pending.
		this._standingDue.clear();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		// session_shutdown handlers may have staged more through the old runtime: apply the same rule.
		this._releaseExtensionStagedInstructions();
		const getDefaultTools = () =>
			this._usesDefaultTools
				? applyToolModifiers(
						this.settingsManager.getDefaultTools() ?? DEFAULT_TOOL_NAMES,
						this._defaultToolModifiers,
					)
				: [];
		const previousDefaultTools = new Set(getDefaultTools());
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		// Activate tools newly added to defaultTools. Removed ones stay active, and tools disabled
		// during the session stay disabled unless the setting newly adds them.
		const addedDefaultTools = getDefaultTools().filter((name) => !previousDefaultTools.has(name));
		// Tools the new extensions register later, such as MCP tools, are pending until then.
		for (const name of this.getActiveToolNames()) this._pendingToolNames.add(name);
		this._buildRuntime({
			activeToolNames: [...this.getActiveToolNames(), ...addedDefaultTools],
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		// Every bound session re-runs startup (recheck N2); a never-bound SDK session does not.
		if (this._extensionsBound) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			this._extensionRunner.reportUnhandledMcpServers();
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, (this._modelForMessage(message) ?? this.model)?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	private _finishCancelledRetry(): void {
		if (this._retryAttempt === 0) return;
		const attempt = this._retryAttempt;
		this._retryAttempt = 0;
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt,
			finalError: "Retry cancelled",
		});
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = retryDelayMs(settings, this._retryAttempt);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// The retry is cancellable from here on (abortRetry), also while the omission's handlers run.
		const controller = new AbortController();
		this._retryAbortController = controller;
		try {
			// Keep the failed attempt in raw history while durably omitting it from model projection.
			await this._omitRecoveryAttempt(message);
			// Its context-change handlers are awaited: on an abort, disposal or refused write meanwhile, finish
			// the cancelled retry instead of arming its backoff.
			if (
				controller.signal.aborted ||
				this._agentRunAbortRequested ||
				this._disposed ||
				this._isSessionWriteBlocked()
			) {
				this._finishCancelledRetry();
				return false;
			}

			// Wait with exponential backoff (abortable)
			try {
				await sleep(delayMs, controller.signal);
			} catch {
				// Aborted during sleep - emit end event so UI can clean up
				this._finishCancelledRetry();
				return false;
			}
		} finally {
			if (this._retryAbortController === controller) this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
			this._schedulePendingCwd();
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else if (this._isStagingBranch()) {
			this._stagedContent.push({ message: bashMessage, announced: true });
		} else {
			this.sessionManager.appendMessage(bashMessage);
			this._refreshFinalizedContext();
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0 || this._isSessionWriteBlocked()) return;

		// Each item leaves the buffer only once written, so a failed append keeps it and the rest (§3.6).
		try {
			while (this._pendingBashMessages.length > 0) {
				this.sessionManager.appendMessage(this._pendingBashMessages[0]!);
				this._pendingBashMessages.shift();
			}
		} finally {
			this._refreshFinalizedContext();
		}
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}
		if (this.isCompacting) {
			throw new Error(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
		}

		// No-op navigation must not turn a flush-created leaf into an accidental branch change.
		if (targetId === this.sessionManager.getLeafId()) return { cancelled: false };
		// Terminal intent belongs to the launch branch, including when its event
		// was already queued. Start all remaining consumers before capturing the
		// source leaf; their synchronous receipts become part of the old branch.
		this._isStoppingCustom = true;
		try {
			this._cancelPendingCwd("the session tree was navigated");
			this._background.cancel("tree", undefined, true);
			this._background.deliverBeforeInvalidation();
		} finally {
			this._isStoppingCustom = false;
		}
		this._branchGeneration++;
		this._writeStoppedCustomMessages();
		const persistenceError = this.sessionManager.getPersistenceError();
		if (persistenceError) throw persistenceError;
		const oldLeafId = this.sessionManager.getLeafId();

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const signal = this._branchSummaryAbortController.signal;
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					...(await this._getSummarizationRequestAuth(this.model!, signal)),
					signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Staged items belong to the abandoned branch: discarded, no onCommit (§3.7).
			this._discardStaged();
			// So does the due latch (§7.3): the new branch's pending values wait for its next input.
			this._standingDue.clear();
			// Update finalized context from the canonical session projection.
			this._refreshFinalizedContext();
			this._restoreToolsFromTranscript();

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this._limitsModel();
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const projection = this.sessionManager.buildSessionProjection();
		const branch = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branch);

		if (latestCompaction) {
			const projectedAssistants = new Set(
				projection.entries.flatMap((entry) =>
					entry.messages.some(
						(message) =>
							message.role === "assistant" &&
							message.stopReason !== "aborted" &&
							message.stopReason !== "error" &&
							calculateContextTokens(message.usage) > 0,
					)
						? [entry.sourceEntry.id]
						: [],
				),
			);
			const compactionIndex = branch.findIndex((entry) => entry.id === latestCompaction.id);
			const hasPostCompactionUsage = branch
				.slice(compactionIndex + 1)
				.some((entry) => projectedAssistants.has(entry.id));
			if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
		}

		const estimate = estimateProjectedContextTokens(projection, branch);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @param options Optional export presentation settings
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolRenderers: (name) =>
				this._extensionRunner.resolveToolRenderers(name, () => this.getToolDefinition(name)),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	/**
	 * Ask the current model to describe what went wrong in this session for a bug report.
	 * Used when the user declines to share the transcript itself.
	 */
	async summarizeForBugReport(options: { hint?: string; signal: AbortSignal }): Promise<string> {
		const model = this.model;
		if (!model) {
			throw new Error("No model selected");
		}
		return generateBugReportSummary({
			...(await this._getSummarizationRequestAuth(model, options.signal)),
			messages: this.messages,
			hint: options.hint,
			signal: options.signal,
			streamFn: this.agent.streamFunction,
			retry: this.settingsManager.getRetrySettings(),
			sessionId: this.sessionId,
		});
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.appendDeveloperMessage = (content) => this.appendDeveloperMessage(content);
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
