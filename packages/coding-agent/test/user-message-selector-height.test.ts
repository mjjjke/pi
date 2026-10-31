import { setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

describe("fork selector height budget", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	for (const height of [16, 24, 30, 40, 60]) {
		it(`keeps the selected message, metadata and counter visible at ${height} rows`, () => {
			const originalHeight = process.stdout.rows;
			process.stdout.rows = height;
			try {
				const selector = new UserMessageSelectorComponent(
					Array.from({ length: 16 }, (_, i) => ({ id: `${i}`, text: `prompt-${i}` })),
					vi.fn(),
					vi.fn(),
				);
				for (let step = 0; step < 34; step++) {
					const lines = selector.render(100).map(stripTerminalSequences);
					expect(lines.length).toBeLessThanOrEqual(height);
					const selected = lines.findIndex((line) => line.startsWith("› "));
					expect(selected).toBeGreaterThanOrEqual(0);
					expect(lines[selected + 1]).toContain("Message ");
					expect(lines.some((line) => /\(\d+\/16\)/.test(line))).toBe(true);
					selector.getMessageList().handleInput("\x1b[A");
				}
			} finally {
				process.stdout.rows = originalHeight;
			}
		});
	}
});
