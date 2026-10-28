import { ScrollView, setKeybindings, Text, type TuiMouseEvent, VStack } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function mouse(selector: ExtensionSelectorComponent, label: string, event: Partial<TuiMouseEvent> = {}, width = 80) {
	const lines = selector.render(width).map(stripAnsi);
	const y = lines.findIndex((line) => line.includes(label));
	expect(y).toBeGreaterThanOrEqual(0);
	return selector.handleMouse({
		type: "click",
		button: "left",
		x: 4,
		y,
		screenX: 4,
		screenY: y,
		width,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		...event,
	});
}

describe("extension selector mouse", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("selects a clicked option and preserves keyboard focus on the selector", () => {
		const selected = vi.fn();
		const selector = new ExtensionSelectorComponent("Approve?", ["Yes", "No"], selected, vi.fn());
		expect(mouse(selector, "No", { type: "press" })?.focusTarget).toBe(selector);
		expect(selected).not.toHaveBeenCalled();
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("→ No");
		mouse(selector, "No");
		expect(selected).toHaveBeenCalledExactlyOnceWith("No");
	});

	it("does not change selection on hover or consume short-list wheels and outside clicks", () => {
		const selected = vi.fn();
		const cancelled = vi.fn();
		const selector = new ExtensionSelectorComponent("Approve?", ["Yes", "No"], selected, cancelled);
		expect(mouse(selector, "No", { type: "move", button: "none" })).toBeUndefined();
		expect(mouse(selector, "No", { type: "wheel", button: "none", wheelDelta: 1 })).toBeUndefined();
		expect(mouse(selector, "Approve?")).toBeUndefined();
		expect(mouse(selector, "navigate")).toBeUndefined();
		expect(mouse(selector, "No", { button: "right" })).toBeUndefined();
		selector.handleInput("\r");
		expect(selected).toHaveBeenCalledExactlyOnceWith("Yes");
		expect(cancelled).not.toHaveBeenCalled();
	});

	it("hits wrapped options after a wrapped description using rendered row coordinates", () => {
		const selected = vi.fn();
		const option = "A long option that wraps across several lines ending TARGET";
		const selector = new ExtensionSelectorComponent("Approve?", ["Yes", option], selected, vi.fn(), {
			description: "A description that wraps across several terminal rows.",
		});
		expect(mouse(selector, "TARGET", {}, 24)?.handled).toBe(true);
		expect(selected).toHaveBeenCalledExactlyOnceWith(option);
	});

	it("bounds long lists, scrolls without confirming, and clicks the visible option", () => {
		const selected = vi.fn();
		const options = Array.from({ length: 15 }, (_, i) => `Option ${String(i).padStart(2, "0")}`);
		const selector = new ExtensionSelectorComponent("Approve?", options, selected, vi.fn());
		expect(stripAnsi(selector.render(80).join("\n"))).not.toContain("Option 14");
		for (let i = 0; i < 14; i++) {
			// Wheel events advance one option per event, like SelectList.
			const lines = selector.render(80).map(stripAnsi);
			const visible = lines.find((line) => line.includes("Option"))!;
			expect(mouse(selector, visible.trim(), { type: "wheel", button: "none", wheelDelta: 3 })?.handled).toBe(true);
		}
		expect(selected).not.toHaveBeenCalled();
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("→ Option 14");
		expect(mouse(selector, "Option 14", { type: "wheel", button: "none", wheelDelta: 1 })?.render).toBe(false);
		mouse(selector, "Option 13");
		expect(selected).toHaveBeenCalledExactlyOnceWith("Option 13");
	});

	it("routes fullscreen press/release to the original option even after recentering", async () => {
		const selected = vi.fn();
		const terminal = new VirtualTerminal(80, 32);
		const tui = new TuiAltScreen(terminal);
		const selector = new ExtensionSelectorComponent(
			"Approve?",
			Array.from({ length: 15 }, (_, i) => `Option ${i}`),
			selected,
			vi.fn(),
		);
		tui.addChild(selector);
		tui.setFocus(selector);
		tui.start();
		try {
			await terminal.waitForRender();
			const y = terminal.getViewport().findIndex((line) => line.includes("Option 8")) + 1;
			expect(y).toBeGreaterThan(0);
			terminal.sendInput(`\x1b[<0;5;${y}M`);
			await terminal.waitForRender();
			terminal.sendInput(`\x1b[<0;5;${y}m`);
			await terminal.waitForRender();
			expect(selected).toHaveBeenCalledExactlyOnceWith("Option 8");
		} finally {
			tui.stop();
		}
	});

	it.each([false, true])("does not confirm a fullscreen drag (returns to press point: %s)", async (returnsToStart) => {
		const selected = vi.fn();
		const terminal = new VirtualTerminal(80, 32);
		const tui = new TuiAltScreen(terminal);
		const selector = new ExtensionSelectorComponent("Approve?", ["Yes", "No"], selected, vi.fn());
		tui.addChild(selector);
		tui.setFocus(selector);
		tui.start();
		try {
			await terminal.waitForRender();
			const y = terminal.getViewport().findIndex((line) => line.includes("No")) + 1;
			expect(y).toBeGreaterThan(0);
			terminal.sendInput(`\x1b[<0;5;${y}M`);
			await terminal.waitForRender();
			expect(selected).not.toHaveBeenCalled();
			terminal.sendInput(`\x1b[<32;8;${y}M`);
			await terminal.waitForRender();
			expect(selected).not.toHaveBeenCalled();
			if (returnsToStart) terminal.sendInput(`\x1b[<32;5;${y}M`);
			const releaseX = returnsToStart ? 5 : 8;
			terminal.sendInput(`\x1b[<0;${releaseX};${y}m`);
			await terminal.waitForRender();
			expect(selected).not.toHaveBeenCalled();
			// A cancelled drag must not break the next ordinary click.
			terminal.sendInput(`\x1b[<0;5;${y}M`);
			terminal.sendInput(`\x1b[<0;5;${y}m`);
			await terminal.waitForRender();
			expect(selected).toHaveBeenCalledExactlyOnceWith("No");
		} finally {
			tui.stop();
		}
	});

	it.each([2, 15])("lets chat scroll only when the %i-option list fits", async (count) => {
		const terminal = new VirtualTerminal(80, 32);
		const tui = new TuiAltScreen(terminal);
		const chat = new ScrollView(new Text(Array.from({ length: 60 }, (_, i) => `Chat ${i}`).join("\n"), 0, 0), {
			follow: "end",
			primary: true,
		});
		const selector = new ExtensionSelectorComponent(
			"Approve?",
			Array.from({ length: count }, (_, i) => `Option ${i}`),
			vi.fn(),
			vi.fn(),
		);
		tui.setLayoutRoot(
			new VStack([
				{ component: chat, basis: 0, grow: 1, minSize: 1 },
				{ component: selector, basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		try {
			await terminal.waitForRender();
			const y = terminal.getViewport().findIndex((line) => line.includes("Option 0")) + 1;
			expect(y).toBeGreaterThan(0);
			terminal.sendInput(`\x1b[<64;5;${y}M`);
			await terminal.waitForRender();
			expect(chat.isFollowingEnd).toBe(count > 10);
		} finally {
			tui.stop();
		}
	});

	it("keeps regular mode keyboard-only", async () => {
		const terminal = new VirtualTerminal();
		const tui = new TuiMainScreen(terminal);
		const selected = vi.fn();
		const selector = new ExtensionSelectorComponent("Approve?", ["Yes", "No"], selected, vi.fn());
		tui.addChild(selector);
		tui.setFocus(selector);
		tui.start();
		try {
			await terminal.waitForRender();
			const y = terminal.getViewport().findIndex((line) => line.includes("No")) + 1;
			expect(y).toBeGreaterThan(0);
			terminal.sendInput(`\x1b[<0;5;${y}M`);
			terminal.sendInput(`\x1b[<0;5;${y}m`);
			expect(selected).not.toHaveBeenCalled();
			terminal.sendInput("\r");
			expect(selected).toHaveBeenCalledExactlyOnceWith("Yes");
		} finally {
			tui.stop();
		}
	});

	it("keeps clamped keyboard navigation, j/k, cancellation and tool expansion", () => {
		const selected = vi.fn();
		const cancelled = vi.fn();
		const expand = vi.fn();
		const selector = new ExtensionSelectorComponent("Approve?", ["Yes", "No"], selected, cancelled, {
			onToggleToolsExpanded: expand,
		});
		selector.handleInput("k");
		selector.handleInput("\r");
		selector.handleInput("j");
		selector.handleInput("j");
		selector.handleInput("\n");
		expect(selected.mock.calls.flat()).toEqual(["Yes", "No"]);
		selector.handleInput("\x1b");
		selector.handleInput("\x0f");
		expect(cancelled).toHaveBeenCalledOnce();
		expect(expand).toHaveBeenCalledOnce();
	});
});
