import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setCapabilities } from "@earendil-works/pi-tui";
import { afterAll, expect, it } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { editRenderers } from "../src/core/tools/renderers/edit.ts";
import { findRenderers } from "../src/core/tools/renderers/find.ts";
import { grepRenderers } from "../src/core/tools/renderers/grep.ts";
import { lsRenderers } from "../src/core/tools/renderers/ls.ts";
import { readRenderers } from "../src/core/tools/renderers/read.ts";
import { writeRenderers } from "../src/core/tools/renderers/write.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { configureLinkRendering } from "../src/utils/link-rendering.ts";

const cwd = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? "/tmp", "headers-"));
writeFileSync(join(cwd, "AGENTS.md"), "hello");
writeFileSync(join(cwd, "a.ts"), "a");
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
function context(args: unknown): ToolRenderContext<Record<string, unknown>, unknown> {
	return {
		args,
		cwd,
		toolCallId: "tool-1",
		invalidate() {},
		lastComponent: undefined,
		state: {},
		executionStarted: false,
		argsComplete: false,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 0,
	};
}
it("headers link the read range and compact row, write existence, file-only find/grep and edit refresh", () => {
	initTheme("dark");
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	configureLinkRendering(new TuiMainScreen(new VirtualTerminal()), cwd, "zed", "ctrl");
	for (const path of ["a.ts", "AGENTS.md"]) {
		const args = { path, offset: 12, limit: 4 };
		const output = readRenderers.renderCall!(args, theme, context(args))!.render(200).join("");
		expect(output).toContain(`zed://file${cwd}/${path}:12`);
		expect(output).toMatch(/:12-15[\s\S]*\x1b\]8;;/);
	}
	const args = { path: "new.ts", content: "a" };
	expect(writeRenderers.renderCall!(args, theme, context(args))!.render(200).join("")).not.toContain("zed://");
	writeFileSync(join(cwd, "new.ts"), "a");
	expect(writeRenderers.renderCall!(args, theme, context(args))!.render(200).join("")).toContain("new.ts:1");
	for (const renderer of [findRenderers, grepRenderers]) {
		expect(renderer.renderCall!({ path: "a.ts", pattern: "x" }, theme, context({}))!.render(200).join("")).toContain(
			"a.ts:1",
		);
		expect(renderer.renderCall!({ path: ".", pattern: "x" }, theme, context({}))!.render(200).join("")).not.toContain(
			"zed://",
		);
	}
	expect(lsRenderers.renderCall!({ path: "a.ts" }, theme, context({}))!.render(200).join("")).not.toContain("zed://");
	const editArgs = { path: "a.ts", oldText: "a", newText: "b" };
	const editContext = context(editArgs);
	const call = editRenderers.renderCall!(editArgs, theme, editContext)!;
	editRenderers.renderResult!(
		{ content: [], details: { diff: "", firstChangedLine: 7 } },
		{ expanded: false, isPartial: false },
		theme,
		editContext,
	);
	expect(call.render(200).join("")).toContain("a.ts:7");
});
