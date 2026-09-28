import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type ChildProcess, spawn } from "child_process";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type {
	BashHandover,
	BashHandoverResult,
	BashTimeoutEvent,
	ExtensionContext,
	ToolDefinition,
} from "../extensions/types.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./renderers/bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/** Running process offered to `onTimeout` when a command reaches its timeout. */
export interface BashTimeoutProcess {
	pid: number;
	/**
	 * Stop managing the process: output stops flowing to `onData` (stdout/stderr are paused),
	 * abort and shutdown no longer kill it, and exec resolves with `detached: true` once the
	 * `onTimeout` callback settles or the signal aborts, whichever comes first.
	 * Throws if the process was already detached, exited, or is being killed.
	 */
	detach(): ChildProcess;
}

/** Handle to a spawned process, offered to `onStart` so a handover can be requested on demand. */
export interface BashProcessControl {
	pid: number;
	/**
	 * Run `callback` like `onTimeout`, but without killing the process when it declines. Handlings
	 * are serialized with the timeout handling: a request made while another handling is in flight
	 * runs after it, and is skipped once the process was detached, exited, or is being killed.
	 * Resolves after the callback settles: true if the callback detached the process.
	 */
	requestHandover(callback: (process: BashTimeoutProcess) => Promise<void> | void): Promise<boolean>;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code. Report signal terminations as 128 + signal number;
	 * a null exit code is treated as a failed command. `detached: true` means `onTimeout` took the
	 * still-running process over; exitCode is then null.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			/**
			 * Called when the timeout elapses, before the process is killed. The process is killed after
			 * the callback settles unless it called `detach()` or the process exited meanwhile.
			 * Implementations without detach support may ignore it and keep killing on timeout.
			 */
			onTimeout?: (process: BashTimeoutProcess) => Promise<void> | void;
			/**
			 * Called once the process is spawned and its output is wired, with a control that can hand
			 * it over on demand. Implementations without detach support may ignore it.
			 */
			onStart?: (control: BashProcessControl) => void;
		},
	) => Promise<{ exitCode: number | null; detached?: true }>;
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env, onTimeout, onStart }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			let killRequested = false;
			let finished = false;
			let detached = false;
			// Tail of the serialized handover handlings (timeout and on-demand requests).
			let handling: Promise<void> | undefined;
			let handlingsInFlight = 0;
			let resolveFinished: () => void = () => {};
			const finishedPromise = new Promise<void>((resolve) => {
				resolveFinished = resolve;
			});
			const detachController = onTimeout || onStart ? new AbortController() : undefined;
			const onAbort = () => {
				killRequested = true;
				if (child.pid) killProcessTree(child.pid);
			};
			const killOnTimeout = () => {
				timedOut = true;
				killRequested = true;
				if (child.pid) killProcessTree(child.pid);
			};
			const hasExited = () => child.exitCode !== null || child.signalCode !== null;
			const detach = (): ChildProcess => {
				if (detached) throw new Error("Process already detached");
				if (killRequested) throw new Error("Process is being killed");
				if (finished || hasExited()) throw new Error("Process already exited");
				detached = true;
				// waitForChildProcess drops its error listener on detach; an unhandled late error would crash Pi.
				child.on("error", () => {});
				child.stdout?.off("data", onData);
				child.stderr?.off("data", onData);
				child.stdout?.pause();
				child.stderr?.pause();
				if (signal) signal.removeEventListener("abort", onAbort);
				if (child.pid) untrackDetachedChildPid(child.pid);
				detachController?.abort();
				return child;
			};
			// Do not skip when the shell already exited: like the stock path, the kill must also reach
			// descendants that still hold the output pipes, or waitForChildProcess keeps reading.
			const killUnlessHandled = () => {
				if (detached || finished || killRequested) return;
				killOnTimeout();
			};
			// After a detach, wait for the new owner's callback, but return as soon as the tool is aborted.
			const waitForTimeoutHandling = (handling: Promise<void>) =>
				new Promise<void>((resolve) => {
					if (signal?.aborted) return resolve();
					const onAbortWhileHandling = () => resolve();
					signal?.addEventListener("abort", onAbortWhileHandling, { once: true });
					void handling.then(() => {
						signal?.removeEventListener("abort", onAbortWhileHandling);
						resolve();
					});
				});
			const isSettled = () => detached || finished || killRequested || hasExited();
			// A failing callback must not keep a timed-out process alive. A synchronous callback
			// (e.g. no extension handlers) kills in the same tick, exactly like the stock path.
			const handleTimeout = (callback: NonNullable<typeof onTimeout>, pid: number): Promise<void> | undefined => {
				// A handover requested on demand may already own the process.
				if (detached) return undefined;
				let pending: Promise<void> | void;
				try {
					pending = callback({ pid, detach });
				} catch {
					pending = undefined;
				}
				if (!pending) {
					killUnlessHandled();
					return undefined;
				}
				return pending.then(killUnlessHandled, killUnlessHandled);
			};
			// On-demand handover: a declining callback leaves the process running in the foreground.
			const runRequestedHandover = async (
				callback: (process: BashTimeoutProcess) => Promise<void> | void,
				pid: number,
			): Promise<boolean> => {
				if (isSettled() || signal?.aborted) return false;
				try {
					await callback({ pid, detach });
				} catch {
					// The tool layer decides what a detach without a result means.
				}
				return detached;
			};
			const enqueueHandling = <T>(run: () => Promise<T> | T): Promise<T> => {
				handlingsInFlight++;
				const next = (handling ?? Promise.resolve()).then(run);
				const settled = next.then(
					() => {},
					() => {},
				);
				handling = settled;
				void settled.then(() => {
					handlingsInFlight--;
				});
				return next;
			};
			const requestHandover: BashProcessControl["requestHandover"] = (callback) => {
				const pid = child.pid;
				if (pid === undefined || isSettled()) return Promise.resolve(false);
				const requested = enqueueHandling(() => runRequestedHandover(callback, pid)).catch(() => false);
				// Never outlive the execution, e.g. behind a timeout handler that never settles after an abort.
				return Promise.race([requested, finishedPromise.then(() => false)]);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						const pid = child.pid;
						if (!onTimeout || pid === undefined) {
							killOnTimeout();
						} else if (handlingsInFlight === 0) {
							// Nothing in flight: keep the stock same-tick kill for synchronous callbacks.
							const pending = handleTimeout(onTimeout, pid);
							if (pending) {
								handlingsInFlight++;
								handling = pending;
								void pending.then(() => {
									handlingsInFlight--;
								});
							}
						} else {
							// An on-demand handling is in flight: the timeout handling runs after it settles.
							void enqueueHandling(() => handleTimeout(onTimeout, pid));
						}
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const waiting = waitForChildProcess(child, detachController?.signal);
				if (onStart && child.pid !== undefined) onStart({ pid: child.pid, requestHandover });
				const exitCode = await waiting;
				if (detached) {
					// The new owner decides the tool result while its callback runs. An abort ends the
					// wait; the caller reports it, and the process stays with its new owner.
					if (handling) await waitForTimeoutHandling(handling);
					return { exitCode: null, detached: true };
				}
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				// A signal-killed shell has no exit code. Use the standard shell convention so
				// callers do not mistake the termination for a successful command.
				const signalCode = child.signalCode;
				return { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) };
			} finally {
				finished = true;
				resolveFinished();
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current Pi session metadata as PI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
	/**
	 * Called when a command reaches its timeout (`reason: "timeout"`), before it is killed, or when a
	 * handover is requested through `registerHandover` (`reason: "steer"`). The handler can take the
	 * still-running process over with `event.takeOver()` and complete the tool call. Otherwise, on
	 * timeout the process is killed and the stock timeout error is reported; on request it keeps
	 * running. Ignored by custom operations that do not support `onTimeout`.
	 */
	onTimeout?: (event: BashTimeoutEvent) => Promise<void> | void;
	/**
	 * Called with a handover request for each running call once its process spawned (only when
	 * `onTimeout` is set and the operations support `onStart`). `request()` emits a `steer` event and
	 * resolves true if a handler took the process over and completed the call. Return a function
	 * that unregisters the call; it is called when the execution ends.
	 */
	registerHandover?: (toolCallId: string, request: () => Promise<boolean>) => () => void;
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	const onTimeout = options?.onTimeout;
	const registerHandover = options?.registerHandover;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			ctx?: ExtensionContext,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				ctx?.cwd || cwd,
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			// Handover state. Only used when onTimeout is configured.
			let takenPid: number | undefined;
			let takenReason: BashTimeoutEvent["reason"] | undefined;
			let takenChild: ChildProcess | undefined;
			let handoverFlushed: Promise<void> | undefined;
			let handoverResult: BashHandoverResult | undefined;
			let handoverClosed = false;
			const startedAt = Date.now();

			const takeOver = (timedOutProcess: BashTimeoutProcess, reason: BashTimeoutEvent["reason"]): BashHandover => {
				if (takenPid !== undefined) throw new Error("bash_timeout: process already taken");
				const child = timedOutProcess.detach();
				takenPid = timedOutProcess.pid;
				takenReason = reason;
				takenChild = child;
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				const flushed = output.closeTempFile();
				handoverFlushed = flushed.catch(() => {});
				return {
					child,
					output: {
						text: snapshot.content,
						truncation: snapshot.truncation,
						fullOutputPath: snapshot.fullOutputPath,
						flushed,
					},
					complete: (result) => {
						if (handoverResult) throw new Error("bash_timeout: handover already completed");
						if (handoverClosed) {
							throw new Error(
								"bash_timeout: tool call already finished; call complete() before the handler returns",
							);
						}
						handoverResult = { content: [...result.content], details: result.details };
					},
				};
			};

			// Only called with reason "timeout" when the call has a timeout, as the union requires.
			const createEvent = (runningProcess: BashTimeoutProcess, reason: BashTimeoutEvent["reason"]) =>
				({
					type: "bash_timeout",
					reason,
					toolCallId,
					toolName: "bash",
					command,
					cwd: spawnContext.cwd,
					pid: runningProcess.pid,
					timeout,
					startedAt,
					get taken() {
						return takenPid !== undefined;
					},
					takeOver: () => takeOver(runningProcess, reason),
				}) as BashTimeoutEvent;
			const handleTimeout =
				onTimeout && timeout !== undefined
					? (timedOutProcess: BashTimeoutProcess) => onTimeout(createEvent(timedOutProcess, "timeout"))
					: undefined;
			const handleSteer = (runningProcess: BashTimeoutProcess) => onTimeout?.(createEvent(runningProcess, "steer"));
			let unregisterHandover: (() => void) | undefined;
			const onStart =
				onTimeout && registerHandover
					? (control: BashProcessControl) => {
							let requested = false;
							unregisterHandover = registerHandover(toolCallId, async () => {
								if (requested || handoverClosed || takenPid !== undefined) return false;
								requested = true;
								try {
									const detachedNow = await control.requestHandover(handleSteer);
									return detachedNow && takenReason === "steer" && handoverResult !== undefined;
								} finally {
									requested = false;
								}
							});
						}
					: undefined;

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
						...(handleTimeout ? { onTimeout: handleTimeout } : {}),
						...(onStart ? { onStart } : {}),
					});
					handoverClosed = true;
					if (result.detached) {
						// Aborted after the takeover: report the stock abort; the process stays with its new owner.
						if (signal?.aborted) {
							await handoverFlushed;
							throw new Error("aborted");
						}
						if (handoverResult) return { content: handoverResult.content, details: handoverResult.details };
						// Taken over without a result: nobody owns the process. Kill it and fall back to the
						// stock timeout, or report the failed on-demand handover.
						if (takenPid !== undefined) killProcessTree(takenPid);
						takenChild?.stdout?.destroy();
						takenChild?.stderr?.destroy();
						await handoverFlushed;
						throw new Error(takenReason === "steer" ? "handover-failed" : `timeout:${timeout}`);
					}
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message === "handover-failed") {
						throw new Error(appendStatus(text, "Command stopped: background handover failed"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode === null) {
					throw new Error(appendStatus(outputText, "Command terminated without an exit code"));
				}
				if (exitCode !== 0) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				handoverClosed = true;
				unregisterHandover?.();
				clearUpdateTimer();
			}
		},
		...createShellRenderers(config.prompt),
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "pi-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
