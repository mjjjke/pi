import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionBeforeQuitEvent, SessionBeforeQuitResult } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function invoke(name: string, mode: object, ...args: unknown[]): unknown {
	return Reflect.apply(Reflect.get(InteractiveMode.prototype, name), mode, args);
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const harnesses: Harness[] = [];
beforeAll(() => initTheme("dark"));
afterEach(() => {
	vi.restoreAllMocks();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
async function setup(
	handler?: (
		event: SessionBeforeQuitEvent,
	) => Promise<SessionBeforeQuitResult | undefined> | SessionBeforeQuitResult | undefined,
	extra?: (pi: ExtensionAPI) => void,
) {
	const events: SessionBeforeQuitEvent[] = [];
	const errors: string[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				if (handler)
					pi.on("session_before_quit", (event) => {
						events.push(event);
						return handler(event);
					});
				extra?.(pi);
			},
		],
	});
	harnesses.push(harness);
	harness.session.extensionRunner.onError((error) => errors.push(error.error));
	const stop = vi.fn();
	const close = vi.spyOn(harness.session, "closeAdmission");
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session, dispose: vi.fn(async () => {}) },
		ui: { terminal: { drainInput: vi.fn(async () => {}) }, requestRender() {} },
		keybindings: new KeybindingsManager(),
		themeController: { disableAutoSync: vi.fn() },
		shutdownRequested: false,
		isShuttingDown: false,
		stop,
		editor: { setText: vi.fn(), getText: () => "" },
		defaultEditor: {},
		signalCleanupHandlers: [],
		lastSigintTime: 0,
		clearEditor: vi.fn(),
	});
	const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	return { harness, mode, stop, close, exit, events, errors };
}

describe("interactive before quit", () => {
	it.each(["command", "ctrl-d", "ctrl-c", "selector"] as const)(
		"%s requests one user confirmation before admission and terminal stop",
		async (source) => {
			const { mode, stop, close, events, exit } = await setup(() => {
				expect(close).not.toHaveBeenCalled();
				expect(stop).not.toHaveBeenCalled();
				return undefined;
			});
			if (source === "command") {
				invoke("setupEditorSubmitHandler", mode);
				await mode.defaultEditor.onSubmit("/quit");
			} else if (source === "ctrl-d") invoke("handleCtrlD", mode);
			else if (source === "ctrl-c") {
				invoke("handleCtrlC", mode);
				invoke("handleCtrlC", mode);
			} else {
				Reflect.set(mode, "showSelector", (create: (done: () => void) => { component: object }) => {
					const { component } = create(() => {});
					Reflect.get(component, "sessionList").onExit();
				});
				invoke("showSessionSelector", mode);
			}
			await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
			expect(events.map((event) => event.source)).toEqual(["user"]);
			expect(close).toHaveBeenCalledOnce();
			expect(stop).toHaveBeenCalledOnce();
		},
	);

	it("cancel leaves admission and TUI live, clears the flag and accepts a later prompt", async () => {
		const { harness, mode, close, stop, exit } = await setup(() => ({ cancel: true }));
		mode.shutdownRequested = true;
		await invoke("shutdown", mode, { source: "extension" });
		expect(close).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
		expect(mode.shutdownRequested).toBe(false);
		harness.setResponses([fauxAssistantMessage("still running")]);
		await harness.session.prompt("next");
		expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(true);
	});

	it("no handler quits as before", async () => {
		const { mode, exit, close } = await setup();
		await invoke("shutdown", mode, { source: "user" });
		expect(close).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledOnce();
	});

	it("a throwing handler is reported and does not cancel", async () => {
		const { mode, errors, exit } = await setup(() => {
			throw new Error("hook failed");
		});
		await invoke("shutdown", mode, { source: "user" });
		expect(errors).toContain("hook failed");
		expect(exit).toHaveBeenCalledOnce();
	});

	it.each(["signal", "user"] as const)(
		"a second %s request aborts and exits without waiting for an answer",
		async (source) => {
			const answer = deferred<SessionBeforeQuitResult>();
			const { mode, events, exit } = await setup(() => answer.promise);
			const pending = invoke("shutdown", mode, { source: "user" });
			expect(events).toHaveLength(1);
			expect(exit).not.toHaveBeenCalled();
			await invoke("shutdown", mode, source === "signal" ? { fromSignal: true } : { source: "user" });
			expect(events[0].signal.aborted).toBe(true);
			expect(events).toHaveLength(1);
			expect(exit).toHaveBeenCalledOnce();
			answer.resolve({ cancel: true });
			await pending;
			expect(exit).toHaveBeenCalledOnce();
		},
	);

	it("extension reentry coalesces and does not force a pending confirmation", async () => {
		const answer = deferred<SessionBeforeQuitResult>();
		const { mode, events, exit } = await setup(() => answer.promise);
		mode.shutdownRequested = true;
		const pending = invoke("checkShutdownRequested", mode);
		mode.shutdownRequested = true;
		await invoke("shutdown", mode, { source: "extension" });
		await invoke("checkShutdownRequested", mode);
		expect(events).toHaveLength(1);
		expect(exit).not.toHaveBeenCalled();
		expect(events[0].signal.aborted).toBe(false);
		answer.resolve({ cancel: true });
		await pending;
		expect(mode.shutdownRequested).toBe(false);
		expect(exit).not.toHaveBeenCalled();
	});

	it("agent_settled shutdown consumes the flag before the public observer reenters", async () => {
		const answer = deferred<SessionBeforeQuitResult>();
		let shutdown = () => {};
		const { harness, mode, events, exit } = await setup(
			() => answer.promise,
			(pi) => {
				pi.on("agent_settled", (_event, ctx) => {
					ctx.shutdown();
				});
			},
		);
		shutdown = () => {
			mode.shutdownRequested = true;
			if (harness.session.isIdle) void invoke("shutdown", mode, { source: "extension" });
		};
		await harness.session.bindExtensions({ shutdownHandler: shutdown });
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") void invoke("checkShutdownRequested", mode);
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(events).toHaveLength(1);
		expect(events[0].signal.aborted).toBe(false);
		expect(exit).not.toHaveBeenCalled();
		answer.resolve({ cancel: true });
		await vi.waitFor(() => expect(mode.shutdownRequested).toBe(false));
		expect(exit).not.toHaveBeenCalled();
	});

	it("shortcut shutdown is deferred until the next settle", async () => {
		const { harness, mode, events, exit } = await setup(() => ({ cancel: true }));
		const runner = harness.session.extensionRunner;
		invoke("setupExtensionShortcuts", mode, {
			getShortcuts: () => new Map([["ctrl+x", { handler: (ctx: { shutdown(): void }) => ctx.shutdown() }]]),
			getModelRegistry: () => runner.getModelRegistry(),
		});
		expect(mode.defaultEditor.onExtensionShortcut("\x18")).toBe(true);
		expect(events).toHaveLength(0);
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") void invoke("checkShutdownRequested", mode);
		});
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("go");
		expect(events.map((event) => event.source)).toEqual(["extension"]);
		expect(mode.shutdownRequested).toBe(false);
		expect(exit).not.toHaveBeenCalled();
	});

	it("a signal without a pending confirmation never emits", async () => {
		const { mode, events, exit } = await setup(() => ({ cancel: true }));
		await invoke("shutdown", mode, { fromSignal: true });
		expect(events).toEqual([]);
		expect(exit).toHaveBeenCalledOnce();
	});

	it.each(["SIGTERM", "SIGHUP"] as const)("%s bypasses the hook and aborts a pending hook", async (signal) => {
		const { mode, events, exit } = await setup(() => new Promise(() => {}));
		invoke("registerSignalHandlers", mode);
		try {
			void invoke("shutdown", mode, { source: "user" });
			const handler = process.listeners(signal)[0] as () => void;
			handler();
			await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
			expect(events).toHaveLength(1);
			expect(events[0].signal.aborted).toBe(true);
		} finally {
			invoke("unregisterSignalHandlers", mode);
		}
	});

	it.each(["EIO", "ENOTTY"])("dead terminal %s exits 129 immediately while confirmation awaits", async (code) => {
		const { mode, exit } = await setup(() => new Promise(() => {}));
		invoke("registerSignalHandlers", mode);
		try {
			void invoke("shutdown", mode, { source: "user" });
			const handler = process.stdin.listeners("error").at(-1) as (error: Error) => void;
			// A real process.exit never returns; make the mock match that control flow.
			exit.mockImplementation((() => {
				throw new Error("exited");
			}) as never);
			expect(() => handler(Object.assign(new Error("dead tty"), { code }))).toThrow("exited");
			expect(exit).toHaveBeenCalledWith(129);
		} finally {
			invoke("unregisterSignalHandlers", mode);
		}
	});
});
