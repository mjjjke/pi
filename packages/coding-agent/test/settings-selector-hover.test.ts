import { setCapabilities, setKeybindings, setPointerHoverBackground } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const bg = "\x1b[48;5;235m";
beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setPointerHoverBackground(undefined));

for (const automatic of [false, true]) {
	for (const exit of ["title", "hint"] as const) {
		for (const renderBetween of [false, true]) {
			it(`Theme first re-entry: automatic=${automatic}, exit=${exit}, render=${renderBetween}`, async () => {
				setPointerHoverBackground(() => bg);
				setCapabilities({ images: null, trueColor: true, hyperlinks: true, pointerShapes: true });
				const preview = vi.fn();
				const change = vi.fn();
				const config = {
					defaultModel: "not set",
					availableDefaultModels: [],
					modelThinkingLevels: {},
					currentTheme: automatic ? "light/dark" : "dark",
					terminalTheme: "dark",
					availableThemes: ["system", "dark", "light"],
					warnings: {},
				} as unknown as SettingsConfig;
				const selector = new SettingsSelectorComponent(config, {
					onThemePreview: preview,
					onThemeChange: change,
					onCancel: () => {},
				} as unknown as SettingsCallbacks);
				const list = selector.getSettingsList();
				list.selectItem("theme");
				list.handleInput("\r");
				if (automatic) list.handleInput("\r"); // Automatic Theme -> Light Theme, a second SettingsList.
				const terminal = new VirtualTerminal(80, 30);
				const tui = new TuiAltScreen(terminal);
				const writes: string[] = [];
				const write = terminal.write.bind(terminal);
				terminal.write = (data) => {
					writes.push(data);
					write(data);
				};
				tui.addChild(selector);
				tui.setFocus(list);
				tui.start();
				try {
					tui.renderNow();
					const before = tui.getScreenLines().map((line) => stripAnsi(line).trimEnd());
					const rows = before.flatMap((line, y) =>
						/^(system|dark|light)(?:\s|$)/.test(line.trim().replace(/^[→✓ ]+/, "")) ? [y] : [],
					);
					expect(rows).toHaveLength(3);
					const title = automatic ? "Light Theme" : "Theme";
					const exitRow = before.findIndex((line) =>
						exit === "title" ? line.trim() === title : line.includes("Enter to select"),
					);
					expect(exitRow).toBeGreaterThan(0);
					const selected = before.findIndex((line) => line.includes("→"));
					const move = (y: number) => terminal.sendInput(`\x1b[<35;3;${y + 1}M`);
					for (const from of rows) {
						for (const to of rows) {
							move(from);
							tui.renderNow();
							move(exitRow);
							if (renderBetween) tui.renderNow();
							writes.length = 0;
							move(to);
							tui.renderNow();
							expect(tui.getScreenLines()[to].includes(bg)).toBe(to !== selected);
							expect(writes.join("")).toContain("\x1b]22;pointer\x1b\\");
							expect(tui.getScreenLines().map((line) => stripAnsi(line).trimEnd())).toEqual(before);
							expect(tui.getFocusedComponent()).toBe(list);
						}
					}
					expect(preview).not.toHaveBeenCalled();
					expect(change).not.toHaveBeenCalled();
					await terminal.flush();
					expect(terminal.getViewport()[rows.at(-1)!]).toContain("light");
				} finally {
					tui.stop();
				}
			});
		}
	}
}
