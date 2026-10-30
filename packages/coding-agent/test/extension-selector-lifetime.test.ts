import { ScrollView, setKeybindings, stripTerminalSequences, Text, VStack } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function row(tui: TuiAltScreen, label: string): number {
	const y =
		tui
			.getScreenLines()
			.map(stripTerminalSequences)
			.findIndex((line) => line.includes(label)) + 1;
	expect(y).toBeGreaterThan(0);
	return y;
}

function mouse(terminal: VirtualTerminal, y: number, type: "press" | "release"): void {
	terminal.sendInput(`\x1b[<0;4;${y}${type === "press" ? "M" : "m"}`);
}

describe("extension selector gesture lifetime", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterEach(() => vi.useRealTimers());

	for (const kind of ["Esc", "Enter", "countdown"] as const) {
		it(`press → ${kind} → release acts only through the keyboard or timeout`, () => {
			const terminal = new VirtualTerminal(40, 20);
			const tui = new TuiAltScreen(terminal);
			const log: string[] = [];
			if (kind === "countdown") vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			const selector = new ExtensionSelectorComponent(
				"Pick",
				["Yes", "No"],
				() => log.push("select"),
				() => {
					log.push("cancel");
					if (kind === "countdown") {
						const replacement = new Text("replacement");
						tui.clear();
						tui.addChild(replacement);
						tui.setFocus(replacement);
					}
				},
				{ tui, timeout: kind === "countdown" ? 1000 : undefined },
			);
			tui.addChild(selector);
			tui.setFocus(selector);
			tui.start();
			tui.renderNow();
			try {
				const y = row(tui, "Yes");
				mouse(terminal, y, "press");
				if (kind === "countdown") vi.advanceTimersByTime(1000);
				else terminal.sendInput(kind === "Esc" ? "\x1b" : "\r");
				tui.renderNow();
				mouse(terminal, y, "release");
				expect(log).toEqual([kind === "Enter" ? "select" : "cancel"]);
			} finally {
				selector.dispose();
				tui.stop();
			}
		});
	}

	for (const kind of ["early click", "early press, late release", "late click", "keyboard"] as const) {
		it(`mouse delay: ${kind}`, () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(1000);
			const terminal = new VirtualTerminal(40, 20);
			const tui = new TuiAltScreen(terminal);
			const selected = vi.fn();
			const selector = new ExtensionSelectorComponent("Confirm", ["Yes", "No"], selected, vi.fn(), {
				mouseDelayMs: 500,
			});
			tui.addChild(selector);
			tui.setFocus(selector);
			tui.start();
			tui.renderNow();
			try {
				const y = row(tui, "Yes");
				if (kind === "keyboard") terminal.sendInput("\r");
				else {
					if (kind === "late click") vi.setSystemTime(1500);
					mouse(terminal, y, "press");
					expect(selected).not.toHaveBeenCalled();
					if (kind === "early press, late release") vi.setSystemTime(1500);
					mouse(terminal, y, "release");
				}
				if (kind === "keyboard" || kind === "late click") expect(selected).toHaveBeenCalledExactlyOnceWith("Yes");
				else {
					expect(selected).not.toHaveBeenCalled();
					vi.setSystemTime(1600);
					mouse(terminal, y, "press");
					mouse(terminal, y, "release");
					expect(selected).toHaveBeenCalledExactlyOnceWith("Yes");
				}
			} finally {
				selector.dispose();
				tui.stop();
			}
		});
	}

	it("activates only once while the selected list remains mounted", () => {
		const terminal = new VirtualTerminal(40, 20);
		const tui = new TuiAltScreen(terminal);
		const selected = vi.fn();
		const selector = new ExtensionSelectorComponent("Pick", ["Yes", "No"], selected, vi.fn());
		tui.addChild(selector);
		tui.setFocus(selector);
		tui.start();
		tui.renderNow();
		try {
			const y = row(tui, "Yes");
			for (let i = 0; i < 2; i++) {
				mouse(terminal, y, "press");
				mouse(terminal, y, "release");
			}
			expect(selected).toHaveBeenCalledExactlyOnceWith("Yes");
		} finally {
			tui.stop();
		}
	});

	it("passes counter-row wheel input to chat even while the list is clipped", () => {
		const terminal = new VirtualTerminal(80, 32);
		const tui = new TuiAltScreen(terminal);
		const selected = vi.fn();
		const chat = new ScrollView(new Text(Array.from({ length: 60 }, (_, i) => `Chat ${i}`).join("\n"), 0, 0), {
			follow: "end",
			primary: true,
		});
		const selector = new ExtensionSelectorComponent(
			"Pick",
			Array.from({ length: 15 }, (_, i) => `Option ${i}`),
			selected,
			vi.fn(),
		);
		tui.setLayoutRoot(
			new VStack([
				{ component: chat, basis: 0, grow: 1, minSize: 1 },
				{ component: selector, basis: "auto", minSize: 1 },
			]),
		);
		tui.setFocus(selector);
		tui.start();
		tui.renderNow();
		try {
			expect(chat.isFollowingEnd).toBe(true);
			terminal.sendInput(`\x1b[<64;4;${row(tui, "(1/15)")}M`);
			expect(chat.isFollowingEnd).toBe(false);
			terminal.sendInput("\r");
			expect(selected).toHaveBeenCalledExactlyOnceWith("Option 0");
		} finally {
			tui.stop();
		}
	});
});
