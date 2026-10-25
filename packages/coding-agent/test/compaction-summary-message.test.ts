import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createCompactionSummaryMessage } from "../src/core/messages.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
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
	test.each([undefined, 62000])("collapsed with after=%s", (after) => {
		const component = new CompactionSummaryMessageComponent(message, undefined, 1, after);
		const output = stripAnsi(component.render(100).join("\n"));
		expect(output).toContain("[compaction] 14:05");
		expect(output).toContain(
			after === undefined ? "168,342 tokens (ctrl+o to expand)" : "168,342 → ~62k tokens (ctrl+o to expand)",
		);
		expect(output).not.toContain("useful");
		component.setExpanded(true);
		const expanded = stripAnsi(component.render(100).join("\n"));
		expect(expanded).toContain("Compacted from 168,342");
		expect(expanded).toContain("useful");
		expect(expanded).not.toContain("to expand");
	});

	test("collapsed body truncates rather than wrapping the hint", () => {
		const component = new CompactionSummaryMessageComponent(message, undefined, 1, 62000);
		const lines = component.render(20).map(stripAnsi);
		expect(lines).toHaveLength(5);
		expect(lines[3].trim()).toBe("168,342 → ~62k ...");
	});

	test.each([1, 3, 12, 20, 40])("fits and truncates at width %s", (width) => {
		const component = new CompactionSummaryMessageComponent(message, undefined, 1, 62000);
		expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		component.setExpanded(true);
		expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
	});
});
