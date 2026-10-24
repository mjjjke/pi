import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { SessionPersistenceError } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type Entry = { type: "message"; message: AgentMessage };

/** A fake InteractiveMode `this` with a chat, an editor and a session journal. */
function createContext(prompt: (context: ReturnType<typeof createContext>, text: string) => Promise<void>) {
	const entries: Entry[] = [];
	let persistenceError: SessionPersistenceError | undefined;
	let editorText = "";
	const children: object[] = [];
	const context = {
		entries,
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
		sessionManager: {
			getEntries: () => entries,
			getPersistenceError: () => persistenceError,
		},
		session: { prompt: vi.fn(async (text: string) => prompt(context, text)) },
		showError: vi.fn(),
		addMessageToChat: (message: AgentMessage) => {
			children.push({ spacer: true }, { message });
		},
		lastUserMessageRender: undefined as unknown,
		renderUserMessageStart: undefined as unknown as (message: AgentMessage) => void,
		restorePromptToEditor: undefined as unknown as (text: string) => void,
	};
	context.renderUserMessageStart = (message) => call("renderUserMessageStart", context, message);
	context.restorePromptToEditor = (text) => call("restorePromptToEditor", context, text);
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

const submitPrompt = (context: unknown, text: string) => call("submitPrompt", context, text) as Promise<void>;

describe("InteractiveMode: a prompt that never reaches the journal goes back to the editor", () => {
	it("W4: a write that fails on the start message removes the shown prompt and restores it, with no extra error", async () => {
		const context = createContext(async (self, text) => {
			// The loop shows the start message, its append fails, and the run ends with an error message.
			self.renderUserMessageStart(userMessage(text));
			const error = self.failWrites();
			self.children.push({ assistantError: error.message });
		});
		context.children.push({ earlier: true });

		await submitPrompt(context, "Responde solo: dos");

		expect(context.children).toEqual([{ earlier: true }, { assistantError: expect.any(String) }]);
		expect(context.editor.getText()).toBe("Responde solo: dos");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("W4: a prompt refused by the sticky error is shown once and restored, after text typed meanwhile", async () => {
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

	it("keeps a prompt that reached the journal, even when a later write of the run fails", async () => {
		const context = createContext(async (self, text) => {
			const message = userMessage(text);
			self.renderUserMessageStart(message);
			self.entries.push({ type: "message", message });
			self.failWrites();
		});

		await submitPrompt(context, "persisted");

		expect(context.children).toHaveLength(2);
		expect(context.editor.getText()).toBe("");
	});

	it("does not restore a prompt that resolves without a failed write (extension commands, handled input)", async () => {
		const context = createContext(async () => {});

		await submitPrompt(context, "/my-extension-command");

		expect(context.editor.setText).not.toHaveBeenCalled();
		expect(context.showError).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode: no /bug hint for a session write failure", () => {
	it("the persistence error is an environment problem with its own remedy", () => {
		const context = { suggestBugReport: vi.fn(), maybeShowInstallChangeWarning: vi.fn(() => false) };
		const error = new SessionPersistenceError(Object.assign(new Error("denied"), { code: "EACCES" }));
		const message: AssistantMessage = fauxAssistantMessage("", { stopReason: "error", errorMessage: error.message });

		call("maybeSuggestBugReport", context, message);

		expect(context.suggestBugReport).not.toHaveBeenCalled();
		expect(context.maybeShowInstallChangeWarning).not.toHaveBeenCalled();
	});
});
