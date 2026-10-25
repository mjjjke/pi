import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompactionResult } from "../src/core/compaction/index.ts";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function call(method: string, self: unknown, ...args: unknown[]): unknown {
	return Reflect.get(InteractiveMode.prototype, method).apply(self, args);
}
const harnesses: Harness[] = [];
const indicators: StatusIndicator[] = [];
afterEach(() => {
	for (const indicator of indicators.splice(0)) indicator.dispose();
	for (const h of harnesses.splice(0)) h.cleanup();
});
async function setup(hard = false, background = true) {
	initTheme("dark");
	let finish!: (result: CompactionResult) => void;
	const summary = new Promise<CompactionResult>((resolve) => {
		finish = resolve;
	});
	const h = await createHarness({
		models: [{ id: "bgc", contextWindow: 10000, maxTokens: 1000 }],
		settings: { compaction: { keepRecentTokens: 10, reserveTokens: 1000 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", () => summary.then((compaction) => ({ compaction })));
			},
		],
	});
	harnesses.push(h);
	h.sessionManager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
	h.sessionManager.appendMessage({ role: "user", content: "x".repeat(hard ? 64000 : 16000), timestamp: 2 });
	const model = h.getModel();
	h.sessionManager.appendMessage({
		...fauxAssistantMessage("old"),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	const kept = h.sessionManager.appendMessage({ role: "user", content: "kept".repeat(40), timestamp: 4 });
	h.session.refreshContext();
	h.setResponses([fauxAssistantMessage("later")]);
	let text = "";
	const mode = {
		session: h.session,
		sessionManager: h.sessionManager,
		settingsManager: h.session.settingsManager,
		isInitialized: true,
		isBashMode: false,
		lastEscapeTime: 0,
		compactionQueuedMessages: [] as { text: string; mode: "steer" | "followUp" }[],
		defaultEditor: { onEscape: undefined as (() => void) | undefined, onAction: vi.fn() },
		editor: {
			getText: () => text,
			setText: (value: string) => {
				text = value;
			},
		},
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		showTreeSelector: vi.fn(),
		showUserMessageSelector: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		showStatusIndicator: vi.fn((indicator: StatusIndicator) => {
			indicators.push(indicator);
		}),
		clearStatusIndicator: vi.fn(),
		flushCompactionQueue: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
	};
	for (const method of [
		"restoreQueuedMessagesToEditor",
		"clearAllQueues",
		"beginBackgroundCompactionWait",
		"endBackgroundCompactionWait",
		"handleCompactCommand",
	]) {
		Reflect.set(mode, method, (...args: unknown[]) => call(method, mode, ...args));
	}
	call("setupKeyHandlers", mode);
	const original = mode.defaultEditor.onEscape;
	h.session.subscribe((event) => {
		if (
			event.type === "session_background_compaction" ||
			event.type === "compaction_start" ||
			event.type === "compaction_end"
		) {
			return call("handleEvent", mode, event) as Promise<void>;
		}
	});
	if (background) h.session.startBackgroundCompaction({ source: "user" });
	return { h, mode, original, finish: () => finish({ summary: "summary", firstKeptEntryId: kept, tokensBefore: 0 }) };
}

describe("Interactive background compaction Esc (real setupKeyHandlers and core)", () => {
	it.each(["", "typed meanwhile"])(
		"--now releases with editor %j, restores both queues, and restores its handler",
		async (text) => {
			const { h, mode, original, finish } = await setup();
			const now = h.session.compactNow();
			await vi.waitFor(() =>
				expect(h.eventsOfType("session_background_compaction").some((e) => e.phase === "waiting")).toBe(true),
			);
			mode.editor.setText(text);
			await h.session.prompt("SDK queued");
			mode.compactionQueuedMessages.push({ text: "TUI queued", mode: "followUp" });
			mode.defaultEditor.onEscape?.();
			expect((await now).status).toBe("released");
			await vi.waitFor(() => expect(mode.defaultEditor.onEscape).toBe(original));
			expect(mode.editor.getText()).toBe(["SDK queued", "TUI queued", text].filter(Boolean).join("\n\n"));
			expect(mode.showTreeSelector).not.toHaveBeenCalled();
			expect(h.eventsOfType("agent_start")).toHaveLength(0);
			expect(h.session.isCompacting).toBe(false);
			expect(h.session.getBackgroundCompaction()?.phase).toBe("summarizing");
			finish();
			await vi.waitFor(() => expect(h.session.getBackgroundCompaction()?.phase).toBe("ready"));
			await h.session.prompt("later");
			expect(h.sessionManager.getBranch().filter((e) => e.type === "compaction")).toHaveLength(1);
		},
	);

	it.each(["", "typed meanwhile"])(
		"L3 Esc with editor %j does not open a tree or send the held prompt",
		async (text) => {
			const { h, mode, original, finish } = await setup(true);
			const receipts: boolean[] = [];
			const run = h.session.prompt("held", {
				onStartMessagePersistence: (receipt) => receipts.push(receipt.persisted),
			});
			await vi.waitFor(() =>
				expect(h.eventsOfType("session_background_compaction").some((e) => e.phase === "waiting")).toBe(true),
			);
			mode.editor.setText(text);
			mode.compactionQueuedMessages.push({ text: "TUI queued", mode: "steer" });
			mode.defaultEditor.onEscape?.();
			await run;
			await vi.waitFor(() => expect(mode.defaultEditor.onEscape).toBe(original));
			expect(receipts).toEqual([false]);
			expect(mode.editor.getText()).toBe(["TUI queued", text].filter(Boolean).join("\n\n"));
			expect(mode.showTreeSelector).not.toHaveBeenCalled();
			expect(h.eventsOfType("agent_start")).toHaveLength(0);
			finish();
			await vi.waitFor(() => expect(h.session.getBackgroundCompaction()?.phase).toBe("ready"));
		},
	);

	it("blocking safety-net Esc also restores input rather than flushing another prompt", async () => {
		const { h, mode, original } = await setup(true, false);
		const run = h.session.prompt("held", { onStartMessagePersistence: () => {} });
		await vi.waitFor(() => expect(h.eventsOfType("compaction_start")).toHaveLength(1));
		mode.compactionQueuedMessages.push({ text: "TUI queued", mode: "steer" });
		mode.defaultEditor.onEscape?.();
		await run;
		expect(mode.editor.getText()).toBe("TUI queued");
		expect(mode.defaultEditor.onEscape).toBe(original);
		expect(mode.flushCompactionQueue).not.toHaveBeenCalled();
		expect(h.eventsOfType("agent_start")).toHaveLength(0);
	});

	it("/compact --now submission waits until one Esc releases it", async () => {
		const { h, mode, original } = await setup(false, false);
		call("setupEditorSubmitHandler", mode);
		const submit = Reflect.get(mode.defaultEditor, "onSubmit") as (text: string) => Promise<void>;
		const command = submit("/compact --now focus");
		await vi.waitFor(() =>
			expect(h.eventsOfType("session_background_compaction").some((e) => e.phase === "waiting")).toBe(true),
		);
		mode.defaultEditor.onEscape?.();
		await command;
		expect(h.session.isCompacting).toBe(false);
		expect(mode.defaultEditor.onEscape).toBe(original);
		expect(mode.showTreeSelector).not.toHaveBeenCalled();
	});

	it("releasing a wait does not overwrite a newer dialog Escape handler", async () => {
		const { h, mode } = await setup();
		const now = h.session.compactNow();
		await vi.waitFor(() =>
			expect(h.eventsOfType("session_background_compaction").some((e) => e.phase === "waiting")).toBe(true),
		);
		const dialog = vi.fn();
		mode.defaultEditor.onEscape = dialog;
		h.session.cancelBackgroundCompaction();
		await now;
		await vi.waitFor(() => expect(mode.clearStatusIndicator).toHaveBeenCalledWith("backgroundCompaction"));
		expect(mode.defaultEditor.onEscape).toBe(dialog);
	});

	it("/compact starts in background; --cancel does not wait for a signal-ignoring hook", async () => {
		const { h, mode } = await setup(false, false);
		await call("handleCompactCommand", mode, "focus");
		expect(h.session.getBackgroundCompaction()?.phase).toBe("summarizing");
		expect(mode.showStatus).toHaveBeenCalledWith("Background compaction started");
		await call("handleCompactCommand", mode, "--cancel");
		expect(h.session.getBackgroundCompaction()).toBeUndefined();
		expect(mode.showStatus).toHaveBeenCalledWith("Background compaction cancelled");
	});
});
