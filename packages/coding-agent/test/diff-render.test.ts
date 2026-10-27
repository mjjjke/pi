import { stripVTControlCharacters } from "node:util";
import { expect, it } from "vitest";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

it("preserves each source line's whitespace when highlighting a one-line replacement", () => {
	initTheme("dark", false);
	const diff = "-1 Run the script.\n+1 Run the script again.";
	expect(stripVTControlCharacters(renderDiff(diff))).toBe(diff);
});
