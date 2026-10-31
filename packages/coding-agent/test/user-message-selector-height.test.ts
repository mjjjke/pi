import {
	Container,
	Spacer,
	setKeybindings,
	setPointerHoverBackground,
	stripTerminalSequences,
	Text,
} from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function fixture(widgetRows = 1) {
	const selected = vi.fn();
	const selector = new UserMessageSelectorComponent(
		Array.from({ length: 16 }, (_, i) => ({ id: `${i}`, text: `prompt-${i} 界é\n${"long ".repeat(100)}` })),
		selected,
		vi.fn(),
	);
	const editor = new Container();
	editor.addChild(selector);
	const widgets = new Container();
	widgets.addChild(new Spacer(widgetRows));
	const viewport = createChatViewport({
		document: new Text("transcript", 0, 0),
		pendingMessages: new Container(),
		status: new Container(),
		widgetsAbove: widgets,
		editor,
		footer: new Text("footer1\nfooter2", 0, 0),
	});
	return { selector, selected, viewport, widgets };
}

function assertSelected(lines: string[], position: number) {
	const y = lines.findIndex((line) => line.startsWith("› "));
	expect(y).toBeGreaterThanOrEqual(0);
	expect(lines[y]).toContain(`prompt-${position - 1}`);
	expect(lines[y + 1]).toContain(`Message ${position} of 16`);
	expect(lines.some((line) => line.includes(`(${position}/16)`))).toBe(true);
}

describe("fork selector allocated height", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	for (const width of [100, 40, 20]) {
		for (const height of [8, 9, 10, 11, 12, 16, 24, 30, 40]) {
			it(`keeps selection, metadata and counter in the real dock at ${width}×${height}`, () => {
				const f = fixture();
				for (let step = 0; step < 34; step++) {
					const lines = renderLayoutFrame(f.viewport.root, width, height, vi.fn()).lines.map(
						stripTerminalSequences,
					);
					assertSelected(lines, ((15 - (step % 16) + 16) % 16) + 1);
					f.selector.getMessageList().handleInput("\x1b[A");
				}
			});
		}
	}
	for (const widgetRows of [2, 3, 5, 10]) {
		it(`accounts for ${widgetRows} widget rows at 100×30`, () => {
			const f = fixture(widgetRows);
			assertSelected(renderLayoutFrame(f.viewport.root, 100, 30, vi.fn()).lines.map(stripTerminalSequences), 16);
		});
	}
	for (const [width, height, widgetRows] of [
		[100, 30, 10],
		[40, 10, 1],
		[20, 12, 1],
	]) {
		it(`keeps rendered mouse/hover footprints aligned at ${width}×${height} with ${widgetRows} widget rows`, () => {
			const f = fixture(widgetRows);
			const terminal = new VirtualTerminal(width, height);
			const tui = new TuiAltScreen(terminal);
			tui.setLayoutRoot(f.viewport.root);
			tui.setFocus(f.selector.getMessageList());
			const hover = "\x1b[48;5;235m";
			setPointerHoverBackground(() => hover);
			tui.start();
			try {
				tui.renderNow();
				let lines = tui.getScreenLines().map(stripTerminalSequences);
				assertSelected(lines, 16);
				const y = lines.findIndex((line) => line.includes("Message 15 of 16"));
				expect(y).toBeGreaterThan(0);
				terminal.sendInput(`\x1b[<35;4;${y + 1}M`);
				tui.renderNow();
				const hovered = tui.getScreenLines();
				expect(hovered.flatMap((line, row) => (line.includes(hover) ? [row] : []))).toEqual([y - 1, y]);
				tui.renderNow();
				expect(tui.getScreenLines()).toEqual(hovered);
				// Separators and the counter are inert; metadata activates its actual entry.
				terminal.sendInput(`\x1b[<0;4;${y + 2}M`);
				terminal.sendInput(`\x1b[<0;4;${y + 2}m`);
				expect(f.selected).not.toHaveBeenCalled();
				terminal.sendInput(`\x1b[<64;4;${y + 1}M`);
				tui.renderNow();
				lines = tui.getScreenLines().map(stripTerminalSequences);
				assertSelected(lines, 15);
				expect(tui.getScreenLines().join("")).not.toContain(hover);
				const metadataY = lines.findIndex((line) => line.includes("Message 15 of 16"));
				terminal.sendInput(`\x1b[<0;4;${metadataY + 1}M`);
				terminal.sendInput(`\x1b[<0;4;${metadataY + 1}m`);
				expect(f.selected).toHaveBeenCalledExactlyOnceWith("14");
			} finally {
				tui.stop();
				setPointerHoverBackground(undefined);
			}
		});
	}
	it("degrades to selection, then metadata, then counter at zero to three allocated rows", () => {
		const f = fixture();
		for (const height of [0, 1, 2, 3]) {
			const lines = f.selector.render(40, height).map(stripTerminalSequences);
			expect(lines).toHaveLength(height);
			if (height >= 1) expect(lines[0]).toContain("› prompt-15");
			if (height >= 2) expect(lines[1]).toContain("Message 16 of 16");
			if (height >= 3) expect(lines[2]).toContain("(16/16)");
		}
	});

	it("recalculates after resizes and widget replacement without reading stdout.rows", () => {
		const f = fixture();
		for (const [width, height, widgetRows] of [
			[100, 30, 10],
			[40, 10, 1],
			[20, 12, 1],
			[80, 40, 5],
			[100, 30, 2],
		]) {
			f.widgets.clear();
			f.widgets.addChild(new Spacer(widgetRows));
			assertSelected(
				renderLayoutFrame(f.viewport.root, width, height, vi.fn()).lines.map(stripTerminalSequences),
				16,
			);
		}
	});
});

describe("fork selector chrome with a short list", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	it("keeps the chrome for a single message when its natural height fits", () => {
		const selector = new UserMessageSelectorComponent([{ id: "a", text: "only prompt" }], vi.fn(), vi.fn());
		const natural = selector.measureHeight(80);
		const full = selector.render(80, natural).map(stripTerminalSequences);
		expect(full.length).toBeLessThanOrEqual(natural);
		expect(full.some((line) => line.includes("Fork from Message"))).toBe(true);
		expect(full.some((line) => line.includes("only prompt"))).toBe(true);
		expect(full.filter((line) => /─{10}/.test(line)).length).toBeGreaterThanOrEqual(2);
	});
});
