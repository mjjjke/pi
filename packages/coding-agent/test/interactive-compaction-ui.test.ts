import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Container, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
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
		showStatus: ReturnType<typeof vi.fn>;
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
		getMarkdownThemeWithSettings: getMarkdownTheme,
		getMarkdownTransformers: () => [],
		clearStatusIndicator: vi.fn(),
		endBackgroundCompactionWait: vi.fn(),
		flushCompactionQueue: vi.fn(),
		renderProjectTrustWarningIfNeeded: vi.fn(),
		showStatus: vi.fn(),
	});
	Object.defineProperties(mode, {
		sessionManager: { value: manager },
		session: { value: { stagedMessages: [], isStreaming: false } },
		settingsManager: { value: { getShowCacheMissNotices: () => showCosts, getShowTerminalProgress: () => false } },
	});
	return { mode, manager, chat, output: () => stripAnsi(chat.render(80).join("\n")) };
}

describe("interactive compaction UI", () => {
	test("initial rendering and rebuild keep summary, separator, tail in order without an applied notice", () => {
		const f = fixture();
		const before = JSON.stringify(f.manager.getEntries());
		f.mode.renderInitialMessages();
		for (let i = 0; i < 2; i++) {
			const output = f.output();
			expect(output.indexOf("[compaction]")).toBeLessThan(output.indexOf("kept context"));
			expect(output.indexOf("kept context")).toBeLessThan(output.indexOf("kept message"));
			expect(output).toContain("168,342 → ~");
			expect(output).not.toContain("✓ Context compacted");
			f.mode.rebuildChatFromMessages();
		}
		expect(JSON.stringify(f.manager.getEntries())).toBe(before);
	});

	test.each(["background", "foreground"])(
		"%s apply has exactly one bottom notice, removed by rebuild",
		async (path) => {
			const f = fixture();
			const event: AgentSessionEvent =
				path === "background"
					? { type: "session_background_compaction", phase: "applied", jobId: "job", source: "user" }
					: {
							type: "compaction_end",
							reason: "manual",
							result: { summary: "A useful summary", tokensBefore: 168342, firstKeptEntryId: "kept" },
							aborted: false,
							willRetry: false,
						};
			await f.mode.handleEvent(event);
			const output = f.output();
			expect(output.indexOf("[compaction]")).toBeLessThan(output.indexOf("kept context"));
			expect(output.indexOf("kept context")).toBeLessThan(output.indexOf("kept message"));
			expect(output.match(/✓ Context compacted/g)).toHaveLength(1);
			expect(output.trimEnd().split("\n").at(-1)).toMatch(/✓ Context compacted · 168k → ~\S+ ↑/);
			expect(f.mode.showStatus).not.toHaveBeenCalledWith("Context compacted");
			f.mode.rebuildChatFromMessages();
			expect(f.output()).not.toContain("✓ Context compacted");
		},
	);

	test("install-time estimate stays fixed after later turns and their usage", () => {
		const f = fixture();
		f.mode.rebuildChatFromMessages();
		const before = f.output().match(/168,342 → ~\S+/)?.[0];
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
		// Don't render the new assistant: this assertion concerns summary metadata only.
		f.mode.renderSessionEntries([f.manager.buildContextEntries()[0]]);
		expect(f.output().match(/168,342 → ~\S+/g)).toEqual([before, before]);
	});

	test.each(["background", "foreground"])("%s preserves the billing notice once, after summary", async (path) => {
		const f = fixture(true);
		await f.mode.handleEvent(
			path === "background"
				? { type: "session_background_compaction", phase: "applied", jobId: "job", source: "user" }
				: {
						type: "compaction_end",
						reason: "threshold",
						result: { summary: "A useful summary", tokensBefore: 168342, firstKeptEntryId: "kept" },
						aborted: false,
						willRetry: false,
					},
		);
		const output = f.output();
		expect(output.match(/Compaction: 100 tokens billed/g)).toHaveLength(1);
		expect(output).toContain("(~$0.13)");
		expect(output.indexOf("[compaction]")).toBeLessThan(output.indexOf("Compaction: 100"));
		expect(output.indexOf("Compaction: 100")).toBeLessThan(output.indexOf("kept context"));
	});

	test("boundary entry notification uses the same order, without an apply acknowledgement", async () => {
		const f = fixture();
		await f.mode.handleEvent({ type: "entry_appended", entry: f.manager.buildContextEntries()[0] });
		const output = f.output();
		expect(output.indexOf("[compaction]")).toBeLessThan(output.indexOf("kept context"));
		expect(output.indexOf("kept context")).toBeLessThan(output.indexOf("kept message"));
		expect(output).not.toContain("✓ Context compacted");
	});

	test("uncompacted context has no separator", () => {
		const f = fixture();
		f.mode.renderSessionEntries(f.manager.getBranch().filter((entry) => entry.type !== "compaction"));
		expect(f.output()).not.toContain("kept context");
	});

	test.each([1, 12, 40, 80])("separator fits full width %s", (width) => {
		const f = fixture();
		f.mode.rebuildChatFromMessages();
		const separatorComponent = f.chat.children.find((child) =>
			stripAnsi(child.render(80).join("\n")).includes("kept context"),
		);
		expect(separatorComponent).toBeDefined();
		const lines = separatorComponent!.render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		if (width >= 40) {
			const separator = lines.find((line) => stripAnsi(line).includes("kept context"));
			expect(separator && visibleWidth(separator)).toBe(width);
		}
	});
});
