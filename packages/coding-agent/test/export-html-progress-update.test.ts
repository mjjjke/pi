import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML progress updates", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("renders progress-update thinking blocks as visible text before collapsible thinking", () => {
		const update = templateJs.indexOf("block.type === 'thinking' && block.progressUpdate && block.thinking.trim()");
		const thinking = templateJs.indexOf("block.type === 'thinking' && block.thinking.trim()");
		expect(update).toBeGreaterThan(-1);
		expect(update).toBeLessThan(thinking);
		expect(templateJs).toMatch(/safeMarkedParse\(`• \$\{block\.thinking\}`\)/);
	});
});
