import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createCompactionSummaryMessage } from "../src/core/messages.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { initTheme, Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(KeybindingsManager.create());
});
const message = createCompactionSummaryMessage(
	"A **useful** summary",
	168342,
	new Date(2026, 0, 2, 14, 5).toISOString(),
);

describe("compaction summary display", () => {
	test.each([undefined, 62104])("one quiet row collapsed with after=%s; expanded header and Markdown", (after) => {
		const component = new CompactionSummaryMessageComponent(message, undefined, 1, after);
		const lines = component.render(100).map((line) => stripAnsi(line).trimEnd());
		expect(lines).toEqual([
			` ✓ compaction  14:05  ${after === undefined ? "168k" : "168k → ~62k"} tokens  (ctrl+o to expand)`,
		]);
		component.setExpanded(true);
		const expanded = component.render(100).map((line) => stripAnsi(line).trimEnd());
		expect(expanded[0]).toBe(` ✓ compaction  14:05  ${after === undefined ? "168,342" : "168,342 → ~62,104"} tokens`);
		expect(expanded[1]).toBe("");
		expect(expanded.slice(2).join("\n")).toContain("A useful summary");
	});

	test("drops hint first, then time, then truncates rather than wrapping", () => {
		const component = new CompactionSummaryMessageComponent(message, undefined, 1, 62104);
		expect(stripAnsi(component.render(50)[0]).trimEnd()).toBe(" ✓ compaction  14:05  168k → ~62k tokens");
		expect(stripAnsi(component.render(34)[0]).trimEnd()).toBe(" ✓ compaction  168k → ~62k tokens");
	});

	test.each([0, 1, 3, 12, 20, 34, 40])("fits width %s in both states", (width) => {
		const component = new CompactionSummaryMessageComponent(message, undefined, 1, 62104);
		expect(component.render(width)).toHaveLength(1);
		expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		component.setExpanded(true);
		expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	test("uses configured expansion binding and output padding", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
		try {
			const component = new CompactionSummaryMessageComponent(message, undefined, 3, 62104);
			expect(stripAnsi(component.render(100)[0])).toContain("   ✓ compaction");
			expect(stripAnsi(component.render(100)[0])).toContain("(ctrl+e to expand)");
			component.setOutputPad(0);
			expect(stripAnsi(component.render(100)[0])).toMatch(/^✓ compaction/);
		} finally {
			setKeybindings(new KeybindingsManager());
		}
	});

	test.each([
		[999, "999"],
		[1234, "1.2k"],
		[10000, "10k"],
		[1234567, "1.2M"],
	])("reuses compact formatter for %s", (count, expected) => {
		const component = new CompactionSummaryMessageComponent({ ...message, tokensBefore: count });
		expect(stripAnsi(component.render(100)[0])).toContain(`  ${expected} tokens`);
	});

	test("semantic theme spans, no background", () => {
		const fg = vi.spyOn(Theme.prototype, "fg");
		const bg = vi.spyOn(Theme.prototype, "bg");
		try {
			new CompactionSummaryMessageComponent(message, undefined, 1, 62104).render(100);
			for (const [key, text] of [
				["success", "✓"],
				["accent", "compaction"],
				["dim", "14:05"],
				["muted", "168k → ~62k tokens"],
				["dim", "(ctrl+o to expand)"],
			]) {
				expect(fg).toHaveBeenCalledWith(key, text);
			}
			expect(bg).not.toHaveBeenCalled();
		} finally {
			fg.mockRestore();
			bg.mockRestore();
		}
	});
});
