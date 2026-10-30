import { setKeybindings, stripTerminalSequences, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { mouse } from "./helpers/selector-mouse.ts";

function fixture(count = 3) {
	const messages = Array.from({ length: count }, (_, i) => ({ id: `id-${i}`, text: `prompt-${i}` }));
	const selected = vi.fn();
	const cancelled = vi.fn();
	const selector = new UserMessageSelectorComponent(messages, selected, cancelled, "id-0");
	return { messages, selected, cancelled, selector };
}

describe("fork selector mouse", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	for (const label of ["prompt-1", "Message 2 of 3"])
		it(`press highlights and clicking ${label} forks once with list focus`, () => {
			const f = fixture();
			expect(mouse(f.selector, label, { type: "press" })?.focusTarget).toBe(f.selector.getMessageList());
			expect(f.selected).not.toHaveBeenCalled();
			expect(
				f.selector
					.render(80)
					.map(stripTerminalSequences)
					.find((line) => line.startsWith("›")),
			).toContain("prompt-1");
			mouse(f.selector, label, { clickSource: "captured" });
			mouse(f.selector, label);
			expect(f.selected).toHaveBeenCalledExactlyOnceWith("id-1");
		});
	it("ignores non-primary events, fallback clicks, headers and blank separators", () => {
		const f = fixture();
		for (const type of ["release", "drag"] as const) expect(mouse(f.selector, "prompt-1", { type })).toBeUndefined();
		const beforeHover = f.selector.render(80).map(stripTerminalSequences);
		for (const type of ["move", "leave"] as const) {
			expect(mouse(f.selector, "prompt-1", { type })?.handled).toBe(true);
			expect(f.selector.render(80).map(stripTerminalSequences)).toEqual(beforeHover);
			expect(f.selected).not.toHaveBeenCalled();
		}
		for (const button of ["middle", "right"] as const)
			expect(mouse(f.selector, "prompt-1", { type: "press", button })).toBeUndefined();
		expect(mouse(f.selector, "prompt-1", { clickSource: "fallback" })).toBeUndefined();
		for (const label of ["Fork from Message", "Select a user message"])
			for (const event of [{}, { type: "wheel", wheelDelta: 1 }] satisfies Partial<TuiMouseEvent>[])
				expect(mouse(f.selector, label, event)).toBeUndefined();
		const lines = f.selector.render(80).map(stripTerminalSequences);
		const y = lines.findIndex((line) => line.includes("Message 2 of 3")) + 1;
		expect(mouse(f.selector, "prompt-1", { y })).toBeUndefined();
		expect(mouse(f.selector, "prompt-1", { type: "wheel", wheelDelta: 1 })).toBeUndefined();
		expect(f.selected).not.toHaveBeenCalled();
	});
	it("wheel steps and clamps only in clipped item area, including interior blanks", () => {
		const f = fixture(15);
		for (let i = 0; i < 16; i++) {
			const lines = f.selector.render(80).map(stripTerminalSequences);
			const y = lines.findIndex((line) => line.startsWith("  Message ")) + 1;
			expect(mouse(f.selector, "Fork from Message", { type: "wheel", wheelDelta: 9, y })?.handled).toBe(true);
			expect(
				f.selector
					.render(80)
					.map(stripTerminalSequences)
					.find((line) => line.startsWith("›")),
			).toContain(`prompt-${Math.min(i + 1, 14)}`);
		}
		expect(mouse(f.selector, "prompt-14", { type: "wheel", wheelDelta: 1 })?.render).toBe(false);
		expect(mouse(f.selector, "(15/15)", { type: "wheel", wheelDelta: -1 })).toBeUndefined();
		const lines = f.selector.render(80).map(stripTerminalSequences);
		const y = lines.findIndex((line) => line.includes("Message 15 of 15")) + 1;
		expect(mouse(f.selector, "prompt-14", { type: "wheel", wheelDelta: -1, y })).toBeUndefined();
	});
	it("revalidates removed keys without closing mouse admission", () => {
		const f = fixture();
		mouse(f.selector, "prompt-1", { type: "press" });
		f.messages.splice(1, 1);
		mouse(f.selector, "prompt-2", { clickSource: "captured" });
		expect(f.selected).not.toHaveBeenCalled();
		mouse(f.selector, "prompt-2", { type: "press" });
		mouse(f.selector, "prompt-2", { clickSource: "captured" });
		expect(f.selected).toHaveBeenCalledExactlyOnceWith("id-2");
	});
	for (const key of ["\x1b", "\r"])
		it(`real renderer voids held clicks after ${JSON.stringify(key)} reaches list focus`, () => {
			const f = fixture();
			const terminal = new VirtualTerminal(80, 40);
			const tui = new TuiAltScreen(terminal);
			tui.addChild(f.selector);
			tui.setFocus(f.selector.getMessageList());
			tui.start();
			tui.renderNow();
			try {
				const y =
					tui
						.getScreenLines()
						.map(stripTerminalSequences)
						.findIndex((line) => line.includes("prompt-1")) + 1;
				expect(y).toBeGreaterThan(0);
				terminal.sendInput(`\x1b[<0;4;${y}M`);
				terminal.sendInput(key);
				terminal.sendInput(`\x1b[<0;4;${y}m`);
				expect(f.cancelled).toHaveBeenCalledTimes(key === "\x1b" ? 1 : 0);
				expect(f.selected).toHaveBeenCalledTimes(key === "\r" ? 1 : 0);
			} finally {
				tui.stop();
			}
		});
});

describe("review: orphan click ownership on fork", () => {
	it("lost row release then modified link cannot let an orphan release fork", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		const f = fixture();
		f.messages[1].text = "\x1b]8;;https://example.com\x07prompt-1\x1b]8;;\x07";
		const opened = vi.fn();
		const terminal = new VirtualTerminal(80, 40),
			tui = new TuiAltScreen(terminal, undefined, undefined, { openUrl: opened });
		tui.addChild(f.selector);
		tui.setFocus(f.selector.getMessageList());
		tui.start();
		tui.renderNow();
		try {
			const y =
				tui
					.getScreenLines()
					.map(stripTerminalSequences)
					.findIndex((line) => line.includes("prompt-1")) + 1;
			expect(y).toBeGreaterThan(0);
			terminal.sendInput(`\x1b[<0;4;${y}M`); // release lost
			terminal.sendInput(`\x1b[<16;4;${y}M`);
			terminal.sendInput(`\x1b[<16;4;${y}m`);
			expect(opened).toHaveBeenCalledExactlyOnceWith("https://example.com");
			expect(f.selected).not.toHaveBeenCalled();
			terminal.sendInput(`\x1b[<0;4;${y}m`); // orphan/duplicate release
			expect(f.selected).not.toHaveBeenCalled();
		} finally {
			tui.stop();
		}
	});
});
