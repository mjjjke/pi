import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Container, Spacer, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme, Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(KeybindingsManager.create());
});

function fixture(showCosts = false) {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "old context", timestamp: 1 });
	const kept = manager.appendMessage({ role: "user", content: "kept message", timestamp: 2 });
	manager.appendCompaction("A useful summary", kept, 168342, undefined, false, {
		input: 10,
		output: 20,
		cacheRead: 30,
		cacheWrite: 40,
		totalTokens: 100,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
	});
	const chat = new Container();
	const mode = Object.create(InteractiveMode.prototype) as {
		renderInitialMessages(): void;
		rebuildChatFromMessages(): void;
		renderSessionEntries(entries: ReturnType<SessionManager["getBranch"]>): void;
		handleEvent(event: AgentSessionEvent): Promise<void>;
		showStatus(message: string): void;
		setToolsExpanded(expanded: boolean): void;
	};
	Object.assign(mode, {
		isInitialized: true,
		chatContainer: chat,
		pendingTools: new Map(),
		entriesRenderedByBoundaryCompaction: new Set(),
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: { requestRender: vi.fn() },
		defaultEditor: {},
		editor: {},
		outputPad: 1,
		toolOutputExpanded: false,
		loadedResourcesContainer: new Container(),
		lastStatusMessage: "",
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
		clearStatusIndicator: vi.fn(),
		endBackgroundCompactionWait: vi.fn(),
		flushCompactionQueue: vi.fn(),
		renderProjectTrustWarningIfNeeded: vi.fn(),
	});
	Object.defineProperties(mode, {
		sessionManager: { value: manager },
		session: { value: { stagedMessages: [], isStreaming: false } },
		settingsManager: { value: { getShowCacheMissNotices: () => showCosts, getShowTerminalProgress: () => false } },
	});
	return { mode, manager, chat, output: () => stripAnsi(chat.render(80).join("\n")) };
}

function applyEvent(path: string): AgentSessionEvent {
	return path === "background"
		? { type: "session_background_compaction", phase: "applied", jobId: "job", source: "user" }
		: {
				type: "compaction_end",
				reason: "manual",
				result: { summary: "A useful summary", tokensBefore: 168342, firstKeptEntryId: "kept" },
				aborted: false,
				willRetry: false,
			};
}

function expectOrder(output: string) {
	expect(output).toContain("✓ compaction");
	expect(output.indexOf("✓ compaction")).toBeLessThan(output.indexOf("kept message"));
	expect(output).not.toContain("kept context");
	expect(output).not.toContain("[compaction]");
}

describe("interactive compaction UI", () => {
	test("initial and rebuild retain faithful order with no separator or applied receipt; entries unchanged", () => {
		const f = fixture();
		const before = JSON.stringify(f.manager.getEntries());
		f.mode.renderInitialMessages();
		for (let i = 0; i < 2; i++) {
			expectOrder(f.output());
			expect(f.output()).toContain("168k → ~");
			expect(f.output()).not.toContain("compaction applied");
			f.mode.rebuildChatFromMessages();
		}
		expect(JSON.stringify(f.manager.getEntries())).toBe(before);
	});

	test.each(["background", "foreground"])(
		"%s apply: one themed status, replaced by next status and removed on rebuild",
		async (path) => {
			const f = fixture();
			const before = JSON.stringify(f.manager.getEntries());
			const fg = vi.spyOn(Theme.prototype, "fg");
			try {
				await f.mode.handleEvent(applyEvent(path));
				expectOrder(f.output());
				expect(f.output().match(/✓ compaction applied/g)).toHaveLength(1);
				expect(f.output().trimEnd().split("\n").at(-1)?.trim()).toMatch(
					/^✓ compaction applied {2}168k → ~\S+ tokens$/,
				);
				expect(f.output()).not.toContain("Context compacted");
				expect(fg).toHaveBeenCalledWith("success", "✓");
				expect(fg.mock.calls.some(([key, text]) => key === "dim" && text.includes("compaction applied"))).toBe(
					true,
				);
				const length = f.chat.children.length;
				f.mode.showStatus("Next status");
				expect(f.chat.children).toHaveLength(length);
				expect(f.output()).not.toContain("compaction applied");
				expect(f.output()).toContain("Next status");
				await f.mode.handleEvent(applyEvent(path));
				f.mode.rebuildChatFromMessages();
				expect(f.output()).not.toContain("compaction applied");
				expect(JSON.stringify(f.manager.getEntries())).toBe(before);
			} finally {
				fg.mockRestore();
			}
		},
	);

	test("applied status is one width-safe row and does not change when a later non-adjacent status appears", async () => {
		const f = fixture();
		await f.mode.handleEvent(applyEvent("background"));
		const status = f.chat.children.at(-1)!;
		const original = stripAnsi(status.render(80).join("\n"));
		for (const width of [0, 1, 12, 30]) {
			const lines = status.render(width);
			expect(lines).toHaveLength(1);
			expect(visibleWidth(lines[0])).toBeLessThanOrEqual(width);
		}
		f.chat.addChild(new Spacer(1));
		f.mode.showStatus("Later status");
		expect(stripAnsi(status.render(80).join("\n"))).toBe(original);
	});

	test("global expansion toggles the summary and replaces the apply status", async () => {
		const f = fixture();
		await f.mode.handleEvent(applyEvent("background"));
		f.mode.setToolsExpanded(true);
		expect(f.output()).toContain("A useful summary");
		expect(f.output()).not.toContain("compaction applied");
		f.mode.setToolsExpanded(false);
		expect(f.output()).not.toContain("A useful summary");
	});

	test("install-time estimate remains fixed after later usage", () => {
		const f = fixture();
		f.mode.rebuildChatFromMessages();
		const before = f.output().match(/168k → ~\S+/)?.[0];
		expect(before).toBeDefined();
		f.manager.appendMessage({
			...fauxAssistantMessage("new"),
			usage: {
				input: 999000,
				output: 1000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1000000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		f.mode.renderSessionEntries([f.manager.buildContextEntries()[0]]);
		expect(f.output().match(/168k → ~\S+/g)).toEqual([before, before]);
	});

	test.each(["background", "foreground"])("%s preserves billing once between marker and tail", async (path) => {
		const f = fixture(true);
		await f.mode.handleEvent(applyEvent(path));
		const output = f.output();
		expect(output.match(/Compaction: 100 tokens billed/g)).toHaveLength(1);
		expect(output).toContain("(~$0.13)");
		expect(output.indexOf("✓ compaction")).toBeLessThan(output.indexOf("Compaction: 100"));
		expect(output.indexOf("Compaction: 100")).toBeLessThan(output.indexOf("kept message"));
	});

	test("boundary notification uses same order without applied status", async () => {
		const f = fixture();
		await f.mode.handleEvent({ type: "entry_appended", entry: f.manager.buildContextEntries()[0] });
		expectOrder(f.output());
		expect(f.output()).not.toContain("compaction applied");
	});

	test("uncompacted context has no marker or separator", () => {
		const f = fixture();
		f.mode.renderSessionEntries(f.manager.getBranch().filter((entry) => entry.type !== "compaction"));
		expect(f.output()).not.toContain("kept context");
		expect(f.output()).not.toContain("✓ compaction");
	});
});
