import { runInNewContext } from "node:vm";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("export HTML progress updates", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

	it("renders progress-update thinking blocks as visible text before collapsible thinking", () => {
		const update = templateJs.indexOf("block.type === 'thinking' && block.progressUpdate && block.thinking.trim()");
		const thinking = templateJs.indexOf("block.type === 'thinking' && block.thinking.trim()");
		expect(update).toBeGreaterThan(-1);
		expect(update).toBeLessThan(thinking);
		expect(templateJs).toMatch(
			/<div class="assistant-text markdown-content">\$\{safeMarkedParse\(block\.thinking\)\}<\/div>/,
		);
	});

	it("renders marked updates and commentary with the same HTML and Markdown input as ordinary text", () => {
		// Match the declaration's closing indentation, not the next function's name.
		const renderEntrySource = templateJs.match(/^([ \t]*)function renderEntry\([^)]*\)\s*\{[\s\S]*?^\1\}/m)?.[0];
		expect(renderEntrySource, "template.js must declare renderEntry").toBeDefined();
		const renderEntry = runInNewContext(`${renderEntrySource}; renderEntry`, {
			formatTimestamp: () => "",
			escapeHtml: (text: string) => text,
			renderCopyLinkButton: () => "",
			// Preserve the parser input verbatim so an injected bullet cannot be hidden by the stub.
			safeMarkedParse: (text: string) => `<parsed>${text}</parsed>`,
		}) as (entry: {
			type: "message";
			id: string;
			message: { role: "assistant"; content: AssistantMessage["content"] };
		}) => string;
		const text = "**Checking** `config.ts`.\n\n- First item\n- Second item";
		const render = (content: AssistantMessage["content"]) =>
			renderEntry({ type: "message", id: "test", message: { role: "assistant", content } });
		const ordinary = render([{ type: "text", text }]);
		const marked = render([{ type: "thinking", thinking: text, progressUpdate: true }]);
		const commentary = render([
			{ type: "text", text, textSignature: JSON.stringify({ v: 1, id: "msg", phase: "commentary" }) },
		]);
		expect(marked).toBe(ordinary);
		expect(commentary).toBe(ordinary);
		expect(marked).not.toContain("thinking-block");
		expect(marked).not.toContain("thinking-text");
		expect(render([{ type: "thinking", thinking: "private reasoning" }])).toContain('class="thinking-block"');
		expect(render([{ type: "thinking", thinking: "  ", progressUpdate: true }])).not.toContain("assistant-text");
	});
});
