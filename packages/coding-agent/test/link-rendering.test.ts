import * as fs from "node:fs";
import { join } from "node:path";
import { Markdown, setCapabilities, TuiAltScreen } from "@earendil-works/pi-tui";
import { afterAll, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";
import { openTranscriptLink } from "../src/utils/link-policy.ts";
import { configureLinkRendering } from "../src/utils/link-rendering.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof fs>("node:fs");
	return { ...actual, statSync: vi.fn(actual.statSync) };
});
vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));
const cwd = fs.mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? "/tmp", "link-rendering-"));
const path = join(cwd, "a.ts");
fs.writeFileSync(path, "");
afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));
it("reload invalidates existing Markdown and updates the sink and modifier without changing source messages", async () => {
	initTheme("dark");
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const terminal = new VirtualTerminal(80, 10);
	const tui = createInteractiveTui({
		tuiMode: "fullscreen",
		cwd,
		editorLinks: "file",
		showHardwareCursor: false,
		logDirectory: cwd,
		terminal,
	});
	const source = { role: "assistant", text: "See a.ts:12:3 and `a.ts`." };
	const before = JSON.stringify(source);
	const markdown = new Markdown(source.text, 0, 0, getMarkdownTheme());
	tui.addChild(markdown);
	tui.start();
	tui.renderNow();
	expect(tui.getScreenLines().join("")).not.toContain("zed://");
	configureLinkRendering(tui, cwd, "zed", "ctrl");
	tui.renderNow();
	expect(tui.getScreenLines().join("")).toContain(`zed://file${cwd}/a.ts:12:3`);
	vi.mocked(fs.statSync).mockClear();
	terminal.sendInput("\x1b[<35;6;1M");
	await terminal.waitForRender();
	markdown.invalidate();
	markdown.render(81);
	expect(fs.statSync).not.toHaveBeenCalled();
	const target = `zed://file${cwd}/a.ts:12:3`;
	expect(openTranscriptLink(target, { editorLinks: "zed" }, openBrowser)).toBeUndefined();
	expect(fs.statSync).toHaveBeenCalledTimes(1);
	expect(openBrowser).toHaveBeenCalledExactlyOnceWith(target);
	fs.unlinkSync(path);
	vi.mocked(openBrowser).mockClear();
	terminal.sendInput("\x1b[<16;6;1M");
	terminal.sendInput("\x1b[<16;6;1m");
	await terminal.waitForRender();
	expect(openBrowser).not.toHaveBeenCalled();
	expect(terminal.getViewport().join("\n")).toContain("Not opened:");
	expect(JSON.stringify(source)).toBe(before);
	tui.stop();
	expect(tui).toBeInstanceOf(TuiAltScreen);
});
