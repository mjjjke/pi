import { ScrollView, setKeybindings, stripTerminalSequences, Text, VStack } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { models } from "./helpers/selector-mouse.ts";

vi.mock("../src/modes/interactive/model-catalog-refresh.ts", () => ({
	refreshModelCatalogs: () => new Promise(() => {}),
}));
describe("model selector fullscreen", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	for (const [count, width] of [
		[3, 80],
		[15, 80],
		[3, 24],
		[15, 24],
	])
		it(`preserves press identity after recentering, cancels drag, and routes wheel (${count} models, width ${width})`, () => {
			const terminal = new VirtualTerminal(width, 60);
			const tui = new TuiAltScreen(terminal);
			const selected = vi.fn();
			const items = models(count);
			const runtime = { getAvailableSnapshot: () => items } as unknown as ModelRuntime;
			const selector = new ModelSelectorComponent(tui, undefined, runtime, [], selected, vi.fn());
			const chat = new ScrollView(new Text(Array.from({ length: 100 }, (_, i) => `Chat ${i}`).join("\n"), 0, 0), {
				follow: "end",
				primary: true,
			});
			tui.setLayoutRoot(
				new VStack([
					{ component: chat, basis: 0, grow: 1, minSize: 1 },
					{ component: selector, basis: "auto", minSize: 1 },
				]),
			);
			tui.setFocus(selector);
			tui.start();
			tui.renderNow();
			const row = (label: string) => {
				const y =
					tui
						.getScreenLines()
						.map(stripTerminalSequences)
						.findIndex((s) => s.includes(label)) + 1;
				expect(y).toBeGreaterThan(0);
				return y;
			};
			try {
				terminal.sendInput(`\x1b[<64;4;${row("model-00")}M`);
				expect(chat.isFollowingEnd).toBe(count > 10);
				chat.scrollToEnd();
				tui.renderNow();
				terminal.sendInput(`\x1b[<64;4;${row("Model Name")}M`);
				expect(chat.isFollowingEnd).toBe(false);
				const label = count > 10 ? "model-08" : "model-01";
				const y = row(label);
				terminal.sendInput(`\x1b[<0;4;${y}M`);
				tui.renderNow();
				terminal.sendInput(`\x1b[<32;8;${y}M`);
				terminal.sendInput(`\x1b[<0;8;${y}m`);
				expect(selected).not.toHaveBeenCalled();
				// Reset by keyboard so the successful press itself recenters the clipped list.
				for (let i = 0; i < (count > 10 ? 8 : 1); i++) terminal.sendInput("\x1b[A");
				tui.renderNow();
				const freshY = row(label);
				terminal.sendInput(`\x1b[<0;4;${freshY}M`);
				tui.renderNow();
				if (count > 10) expect(row(label)).not.toBe(freshY);
				terminal.sendInput(`\x1b[<0;4;${freshY}m`);
				expect(selected).toHaveBeenCalledExactlyOnceWith(items[count > 10 ? 8 : 1]);
			} finally {
				selector.dispose();
				tui.stop();
			}
		});
});
