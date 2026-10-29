import assert from "node:assert/strict";
import { test } from "node:test";
import { Image } from "../src/components/image.ts";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { hyperlink, setCapabilities } from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const plain = (text: string) => text;
const theme: MarkdownTheme = {
	heading: plain,
	link: plain,
	linkUrl: plain,
	code: plain,
	codeBlock: plain,
	codeBlockBorder: plain,
	quote: plain,
	quoteBorder: plain,
	hr: plain,
	listBullet: plain,
	bold: plain,
	italic: plain,
	strikethrough: plain,
	underline: plain,
};
const hostile = "\x1b]8;;smb://host/share\x07bad\x1b]8;;\x07\x1b]0;title\x07";

test("Markdown sanitizes every token sink and transformed source, with an explicit trusted opt-out", () => {
	for (const hyperlinks of [false, true]) {
		setCapabilities({ images: null, trueColor: true, hyperlinks });
		for (const source of [
			hostile,
			`\`${hostile}\``,
			`\`\`\`\n${hostile}\n\`\`\``,
			`<b>${hostile}</b>`,
			`<div>\n${hostile}\n</div>`,
			`| a | b |\n|---|---|\n| ${hostile} | x |`,
			`# ${hostile}`,
			`[${hostile}](smb://host/share)`,
		]) {
			const markdown = new Markdown(source, 0, 0, theme);
			assert.doesNotMatch(markdown.render(4).join("\n"), /\x1b\]8;|\x1b\]0;/);
			markdown.setText(source);
			assert.doesNotMatch(markdown.render(80).join("\n"), /\x1b\]8;|\x1b\]0;/);
		}
	}
	assert.doesNotMatch(
		new Markdown("hello", 0, 0, theme, undefined, { transform: () => hostile }).render(80).join(""),
		/\x1b/,
	);
	assert.match(
		new Markdown(hostile, 0, 0, theme, undefined, { allowTerminalSequences: true }).render(80).join(""),
		/\x1b/,
	);
});

test("plain click selects; ctrl click opens before enclosing row handlers; dragging cancels", async () => {
	const terminal = new VirtualTerminal(80, 10);
	const opened: string[] = [];
	const tui = new TuiAltScreen(terminal, false, process.env.PI_SCRATCH_DIR, {
		openUrl: (url) => opened.push(url),
		copyOnSelect: false,
	});
	tui.addChild(new Text(hyperlink("a link", "https://ok.test/"), 0, 0));
	tui.start();
	tui.renderNow();
	terminal.sendInput("\x1b[<0;2;1M");
	terminal.sendInput("\x1b[<0;2;1m");
	assert.deepEqual(opened, []);
	// Reset multi-click word selection before the independent modifier gesture.
	tui.resetTextSelection();
	terminal.sendInput("\x1b[<16;2;1M");
	terminal.sendInput("\x1b[<16;2;1m");
	assert.deepEqual(opened, ["https://ok.test/"]);
	tui.resetTextSelection();
	terminal.sendInput("\x1b[<16;2;1M");
	terminal.sendInput("\x1b[<48;3;1M");
	terminal.sendInput("\x1b[<16;3;1m");
	assert.equal(opened.length, 1);
	tui.stop();
	await terminal.flush();
});

test("S1 protects regular differential output, fullscreen frames and direct exit", async () => {
	for (const fullscreen of [false, true]) {
		const terminal = new VirtualTerminal(80, 10);
		const writes: string[] = [];
		const write = terminal.write.bind(terminal);
		terminal.write = (data) => {
			writes.push(data);
			write(data);
		};
		const tui = fullscreen
			? new TuiAltScreen(terminal, false, process.env.PI_SCRATCH_DIR)
			: new TuiMainScreen(terminal, false, process.env.PI_SCRATCH_DIR);
		const text = new Text("hello", 0, 0);
		tui.addChild(text);
		tui.start();
		tui.renderNow();
		text.setText(`\x1b]0;${"t".repeat(30)}\x07${"x".repeat(80)}${hostile}`);
		assert.doesNotThrow(() => tui.renderNow());
		tui.stop();
		await terminal.flush();
		assert.doesNotMatch(writes.join(""), /\x1b\]8;;smb:/);
	}
});

test("real iTerm Image survives width repair in the regular screen", async () => {
	setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
	const image = new Image(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=",
		"image/png",
		{ fallbackColor: plain },
		{ maxWidthCells: 40 },
	);
	const original = image.render(80);
	const terminal = new VirtualTerminal(80, 40);
	const writes: string[] = [];
	terminal.write = (data) => {
		writes.push(data);
	};
	const tui = new TuiMainScreen(terminal, false, process.env.PI_SCRATCH_DIR);
	tui.addChild({
		render: () => original.map((line) => (line.includes("\x1b]1337;") ? `${line}\x9c` : line)),
		invalidate() {},
	});
	tui.start();
	tui.renderNow();
	tui.stop();
	assert.ok(writes.join("").includes(original.find((line) => line.includes("\x1b]1337;"))!));
	assert.doesNotMatch(writes.join(""), /\x9c/);
});
