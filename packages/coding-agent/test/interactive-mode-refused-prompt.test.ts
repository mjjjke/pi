import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { PromptOptions } from "../src/core/agent-session.ts";
import { SessionPersistenceError } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type Scenario = (context: Context, text: string, options: PromptOptions | undefined) => Promise<void>;
type Context = ReturnType<typeof createContext>;

/** A fake InteractiveMode `this`: chat, editor and a session whose prompt() runs a scenario. */
function createContext(scenario: Scenario) {
	let persistenceError: SessionPersistenceError | undefined;
	let editorText = "";
	const children: object[] = [];
	const context = {
		children,
		failWrites: () => {
			persistenceError = new SessionPersistenceError(Object.assign(new Error("denied"), { code: "EACCES" }));
			return persistenceError;
		},
		chatContainer: {
			children,
			addChild: (component: object) => children.push(component),
			removeChild: (component: object) => {
				const index = children.indexOf(component);
				if (index >= 0) children.splice(index, 1);
			},
		},
		editor: {
			getText: () => editorText,
			setText: vi.fn((text: string) => {
				editorText = text;
			}),
		},
		ui: { requestRender: vi.fn() },
		sessionManager: { getPersistenceError: () => persistenceError },
		session: {
			prompt: vi.fn(async (text: string, options?: PromptOptions) => scenario(context, text, options)),
			clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
			followUp: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
		},
		showError: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		isExtensionCommand: () => false,
		compactionQueuedMessages: [] as Array<{ text: string; mode: "steer" | "followUp" }>,
		userMessageComponents: new WeakMap<AgentMessage, object[]>(),
		addMessageToChat: (message: AgentMessage) => {
			children.push({ spacer: true }, { message });
		},
	};
	for (const method of ["renderUserMessageStart", "restorePromptToEditor", "promptAndTrackStart"]) {
		Reflect.set(context, method, (...args: unknown[]) => call(method, context, ...args));
	}
	return context;
}

function call(method: string, self: unknown, ...args: unknown[]): unknown {
	const fn = Reflect.get(InteractiveMode.prototype, method) as ((...args: unknown[]) => unknown) | undefined;
	if (!fn) throw new Error(`InteractiveMode.${method} is missing`);
	return fn.apply(self, args);
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function render(context: Context, message: AgentMessage): void {
	call("renderUserMessageStart", context, message);
}

/** A started run whose start message reaches the chat; `persisted` is core's receipt. */
function startedRun(persisted: boolean, extra?: (context: Context) => void): Scenario {
	return async (context, text, options) => {
		options?.preflightResult?.("started");
		const start = userMessage(text);
		render(context, start);
		extra?.(context);
		if (!persisted) context.children.push({ assistantError: context.failWrites().message });
		options?.onStartMessagePersistence?.({ message: start, persisted });
	};
}

const submitPrompt = (context: unknown, text: string) => call("submitPrompt", context, text) as Promise<void>;

describe("InteractiveMode: a prompt that never reaches the journal goes back to the editor", () => {
	it("W4: core reports the start unsent; only its own bubble is removed (not a later queued one)", async () => {
		const context = createContext(startedRun(false, (self) => render(self, userMessage("queued"))));
		context.children.push({ earlier: true });

		await submitPrompt(context, "Responde solo: dos");

		expect(context.children).toEqual([
			{ earlier: true },
			{ spacer: true },
			{ message: userMessage("queued") },
			{ assistantError: expect.any(String) },
		]);
		expect(context.editor.getText()).toBe("Responde solo: dos");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("W4: a prompt refused by the sticky error is shown once and restored, before text typed meanwhile", async () => {
		const context = createContext(async () => {
			throw new Error("Session file write failed (EACCES): refused");
		});
		context.failWrites();
		context.editor.setText("typed meanwhile");

		await submitPrompt(context, "Responde solo: tres");

		expect(context.showError).toHaveBeenCalledOnce();
		expect(context.showError).toHaveBeenCalledWith("Session file write failed (EACCES): refused");
		expect(context.editor.getText()).toBe("Responde solo: tres\n\ntyped meanwhile");
	});

	it("W1: a first-run preflight failure keeps the prompt in the editor", async () => {
		const context = createContext(async () => {
			throw new TypeError("The first argument must be of type string or an instance of Buffer. Received null");
		});

		await submitPrompt(context, "FAILPF primer intento");

		expect(context.showError).toHaveBeenCalledOnce();
		expect(context.editor.getText()).toBe("FAILPF primer intento");
	});

	it("keeps a prompt core reports persisted, even when a later write of the run fails", async () => {
		const context = createContext(startedRun(true, (self) => self.failWrites()));

		await submitPrompt(context, "persisted");

		expect(context.children).toHaveLength(2);
		expect(context.editor.getText()).toBe("");
	});

	it("does not restore handled input, even when its handler hit a write failure", async () => {
		const context = createContext(async (self, _text, options) => {
			self.failWrites();
			options?.preflightResult?.("handled");
		});

		await submitPrompt(context, "handled");

		expect(context.editor.setText).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("does not restore a prompt that resolves without a receipt (deferred from agent_settled)", async () => {
		const context = createContext(async () => {});

		await submitPrompt(context, "deferred");

		expect(context.editor.setText).not.toHaveBeenCalled();
	});

	it("does not restore queued input", async () => {
		const context = createContext(async (_self, _text, options) => options?.preflightResult?.("queued"));

		await submitPrompt(context, "queued");

		expect(context.editor.setText).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode: the post-compaction queue keeps an unsent first prompt", () => {
	it("restores the compaction queue when core reports the first prompt unsent", async () => {
		const context = createContext(startedRun(false));
		const queued = [
			{ text: "two", mode: "steer" as const },
			{ text: "three", mode: "followUp" as const },
		];
		context.compactionQueuedMessages = [...queued];

		await call("flushCompactionQueue", context);
		await vi.waitFor(() => expect(context.compactionQueuedMessages).toEqual(queued));

		expect(context.session.clearQueue).toHaveBeenCalled();
		expect(context.children).toEqual([{ assistantError: expect.any(String) }]);
	});
});

describe("InteractiveMode: no /bug hint while the session cannot write", () => {
	it("is classified by session state, so a wrapped persistence failure is covered too", () => {
		const context = {
			suggestBugReport: vi.fn(),
			maybeShowInstallChangeWarning: vi.fn(() => false),
			sessionManager: {
				getPersistenceError: () =>
					new SessionPersistenceError(Object.assign(new Error("denied"), { code: "EACCES" })),
			},
		};
		const message: AssistantMessage = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: 'Standing instruction "mode" could not be delivered: Session file write failed (EACCES): …',
		});

		call("maybeSuggestBugReport", context, message);

		expect(context.suggestBugReport).not.toHaveBeenCalled();
		expect(context.maybeShowInstallChangeWarning).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode: runtime error reports", () => {
	function reportContext() {
		return { showError: vi.fn(), showExtensionError: vi.fn() };
	}

	it("shows a session write failure from the run-end flush as a plain Error, not an extension error", () => {
		const context = reportContext();
		const error = "Session file write failed (EACCES): the last entry may be missing or partial.";

		call("reportExtensionError", context, { extensionPath: "<runtime>", event: "session_persistence", error });

		expect(context.showError).toHaveBeenCalledWith(error);
		expect(context.showExtensionError).not.toHaveBeenCalled();
	});

	it("keeps the extension label for other errors, including other runtime events", () => {
		const context = reportContext();

		call("reportExtensionError", context, {
			extensionPath: "/ext/a.ts",
			event: "turn_end",
			error: "boom",
			stack: "s",
		});
		call("reportExtensionError", context, { extensionPath: "<runtime>", event: "session_bootstrap", error: "b" });

		expect(context.showError).not.toHaveBeenCalled();
		expect(context.showExtensionError.mock.calls).toEqual([
			["/ext/a.ts", "boom", "s"],
			["<runtime>", "b", undefined],
		]);
	});
});
