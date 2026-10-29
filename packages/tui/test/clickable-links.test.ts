import assert from "node:assert/strict";
import { test } from "node:test";
import { Image } from "../src/components/image.ts";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { Text } from "../src/components/text.ts";
import { hyperlink, linkTo, setCapabilities } from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { getOsc8LinkAtColumn, stripTerminalSequences, underlineOsc8Link } from "../src/utils.ts";
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
test("hover follows an occurrence id across wraps, restores styles and clears on keyboard/focus/wheel", async () => {
	const terminal = new VirtualTerminal(4, 5);
	let writes = 0;
	const write = terminal.write.bind(terminal);
	terminal.write = (data) => {
		writes++;
		write(data);
	};
	const tui = new TuiAltScreen(terminal, false, process.env.PI_SCRATCH_DIR);
	const first = linkTo("abcdef", "https://ok.test/", { id: "first" });
	const second = linkTo("abcdef", "https://ok.test/", { id: "second" });
	tui.addChild(new Text(`\x1b[44m${first}\x1b[49m\n${second}`, 0, 0));
	tui.start();
	tui.renderNow();
	assert.deepEqual(getOsc8LinkAtColumn(tui.getScreenLines()[0], 0), { url: "https://ok.test/", id: "first" });
	const plain = tui.getScreenLines().map(stripTerminalSequences);
	terminal.sendInput("\x1b[<35;1;1M");
	await terminal.waitForRender();
	const hovered = tui.getScreenLines();
	assert.match(hovered[0], /\x1b\[4m/);
	assert.match(hovered[1], /\x1b\[4m/);
	assert.doesNotMatch(hovered[2], /\x1b\[4m/);
	assert.deepEqual(hovered.map(stripTerminalSequences), plain);
	const before = writes;
	terminal.sendInput("\x1b[<35;2;1M");
	terminal.sendInput("\x1b[<35;1;2M");
	await terminal.waitForRender();
	assert.equal(writes, before);
	terminal.sendInput("x");
	await terminal.waitForRender();
	assert.doesNotMatch(tui.getScreenLines().join(""), /\x1b\[4m/);
	terminal.sendInput("\x1b[<35;1;1M");
	await terminal.waitForRender();
	terminal.sendInput("\x1b[O");
	await terminal.waitForRender();
	assert.doesNotMatch(tui.getScreenLines().join(""), /\x1b\[4m/);
	tui.stop();
});

for (const id of [undefined, "occurrence"]) {
	test(`stationary link hover survives ticking rows and unrelated edits on its row, id=${id}`, () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TuiAltScreen(terminal);
		const link = id ? linkTo("link", "https://ok.test/", { id }) : "\x1b]8;;https://ok.test/\x07link\x1b]8;;\x07";
		const text = new Text(`${link} tail\ntick 0`, 0, 0);
		tui.addChild(text);
		tui.start();
		try {
			tui.renderNow();
			terminal.sendInput("\x1b[<35;2;1M");
			tui.renderNow();
			assert.match(tui.getScreenLines()[0], /\x1b\[4m/);
			for (let tick = 1; tick <= 3; tick++) {
				text.setText(`${link} tail\ntick ${tick}`);
				tui.renderNow();
				assert.match(tui.getScreenLines()[0], /\x1b\[4m/);
				text.setText(`${link} tail ${tick}\ntick ${tick}`);
				tui.renderNow();
				assert.match(tui.getScreenLines()[0], /\x1b\[4m/);
			}
		} finally {
			tui.stop();
		}
	});
}

for (const change of ["move", "remove", "url", "id", "width", "height", "overlay"]) {
	test(`stationary link hover drops on ${change}`, () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TuiAltScreen(terminal);
		const link = "\x1b]8;;https://ok.test/\x07link\x1b]8;;\x07";
		const text = new Text(`${link}\ntick`, 0, 0);
		tui.addChild(text);
		tui.start();
		try {
			tui.renderNow();
			terminal.sendInput("\x1b[<35;2;1M");
			tui.renderNow();
			assert.match(tui.getScreenLines()[0], /\x1b\[4m/);
			if (change === "move") text.setText(` ${link}\ntick`);
			else if (change === "remove") text.setText("gone\ntick");
			else if (change === "url") text.setText(linkTo("link", "https://other.test/"));
			else if (change === "id") text.setText(linkTo("link", "https://ok.test/", { id: "new" }));
			else if (change === "width") terminal.resize(41, 6);
			else if (change === "height") terminal.resize(40, 7);
			else tui.showOverlay(new Text("overlay", 0, 0), { anchor: "bottom-right", width: 10 });
			tui.renderNow();
			assert.doesNotMatch(tui.getScreenLines().join(""), /\x1b\[4m/);
		} finally {
			tui.stop();
		}
	});
}

test("id-link hover spans rows through ticks and drops when the occurrence disappears", () => {
	const terminal = new VirtualTerminal(40, 6);
	const tui = new TuiAltScreen(terminal);
	const first = linkTo("first", "https://ok.test/", { id: "wrapped" });
	const second = linkTo("second", "https://ok.test/", { id: "wrapped" });
	const text = new Text(`${first}\n${second}\ntick 0`, 0, 0);
	tui.addChild(text);
	tui.start();
	try {
		tui.renderNow();
		terminal.sendInput("\x1b[<35;2;1M");
		tui.renderNow();
		for (let tick = 1; tick <= 3; tick++) {
			text.setText(`${first}\n${second}\ntick ${tick}`);
			tui.renderNow();
			assert.match(tui.getScreenLines()[0], /\x1b\[4m/);
			assert.match(tui.getScreenLines()[1], /\x1b\[4m/);
		}
		text.setText("gone\ngone\ntick 4");
		tui.renderNow();
		text.setText(`${first}\n${second}\ntick 5`);
		tui.renderNow();
		assert.doesNotMatch(tui.getScreenLines().join(""), /\x1b\[4m/);
	} finally {
		tui.stop();
	}
});

test("hover leaves explicit underline styles intact and restores the original background", () => {
	const explicit = `\x1b[44;4:3m${linkTo("abc", "https://ok.test/", { id: "a" })}\x1b[0m`;
	assert.equal(underlineOsc8Link(explicit, { url: "https://ok.test/", id: "a" }), explicit);
	const background = `\x1b[48;2;12;34;56m${linkTo("abc", "https://ok.test/", { id: "a" })} plain`;
	const painted = underlineOsc8Link(background, { url: "https://ok.test/", id: "a" });
	assert.match(painted, /\x1b\[24m\x1b\[48;2;12;34;56m/);
	assert.equal(stripTerminalSequences(painted), stripTerminalSequences(background));
});

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

test("streaming only defers discoveries and bare autolinks at the source end", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const linkify = (text: string) =>
		[...text.matchAll(/a\.ts/g)].map((match) => ({
			start: match.index,
			end: match.index + match[0].length,
			target: "https://files.test/a.ts",
		}));
	for (const prefix of ["", "- ", "> ", "# "]) {
		for (const tail of ["https://pi/", "a.ts"]) {
			const source = `${prefix}${tail} and ${tail}`;
			const markdown = new Markdown(source, 0, 0, theme, undefined, { streaming: true, linkify });
			assert.equal(
				(
					markdown
						.render(120)
						.join("")
						.match(/\x1b\]8;id=/g) ?? []
				).length,
				1,
			);
			markdown.setText(`${source} `);
			assert.equal(
				(
					markdown
						.render(120)
						.join("")
						.match(/\x1b\]8;id=/g) ?? []
				).length,
				2,
			);
			assert.match(
				new Markdown(`${prefix}${tail}`, 0, 0, theme, undefined, { linkify }).render(120).join(""),
				/\x1b\]8;/,
			);
		}
	}
	for (const source of [
		"[label](https://pi/)",
		"<https://pi/>",
		"`a.ts` ",
		"**a.ts** ",
		"https://pi/\n\n```\nhttps://pi/",
		"a.ts\n\n```\na.ts",
	]) {
		assert.match(
			new Markdown(source, 0, 0, theme, undefined, { streaming: true, linkify }).render(120).join(""),
			/\x1b\]8;/,
		);
	}
});

test("streaming discoveries wait for whitespace after the entire punctuation-bearing token", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const linkify = (text: string) =>
		[...text.matchAll(/foo\.ts(?::\d+)?/g)].map((match) => ({
			start: match.index,
			end: match.index + match[0].length,
			target: "https://files.test/foo.ts",
		}));
	for (const tail of ["foo.ts.", "foo.ts:", "foo.ts:1", "foo.ts:1?", "foo.ts#", "`foo.ts`", "**foo.ts**"]) {
		const source = `foo.ts ${tail}`;
		const markdown = new Markdown(source, 0, 0, theme, undefined, { streaming: true, linkify });
		assert.equal(
			(
				markdown
					.render(120)
					.join("")
					.match(/\x1b\]8;id=/g) ?? []
			).length,
			1,
			source,
		);
		for (const delimiter of [" ", "\n", "\t"]) {
			markdown.setText(`${source}${delimiter}`);
			assert.equal(
				(
					markdown
						.render(120)
						.join("")
						.match(/\x1b\]8;id=/g) ?? []
				).length,
				2,
				source,
			);
		}
	}
	for (const source of [
		"- https://example.com/a\n- https://example.com/a.",
		"https://example.com/a\n\nhttps://example.com/a.",
		"| A | B |\n|---|---|\n| https://example.com/a | https://example.com/a.",
	]) {
		const markdown = new Markdown(source, 0, 0, theme, undefined, { streaming: true });
		assert.equal(
			(
				markdown
					.render(120)
					.join("")
					.match(/\x1b\]8;id=/g) ?? []
			).length,
			1,
			source,
		);
	}
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

test("ctrl links precede a tool row's click handler while plain clicks still expand it", async () => {
	const terminal = new VirtualTerminal(40, 5);
	const opened: string[] = [];
	let expanded = 0;
	const tui = new TuiAltScreen(terminal, false, process.env.PI_SCRATCH_DIR, { openUrl: (url) => opened.push(url) });
	tui.addChild(
		new MouseRegion(new Text(linkTo("path.ts", "https://ok.test/", { id: "tool" }), 0, 0), (event) => {
			if (event.type !== "click") return undefined;
			expanded++;
			return { handled: true };
		}),
	);
	tui.start();
	tui.renderNow();
	terminal.sendInput("\x1b[<0;2;1M");
	terminal.sendInput("\x1b[<0;2;1m");
	assert.equal(expanded, 1);
	assert.deepEqual(opened, []);
	terminal.sendInput("\x1b[<16;2;1M");
	terminal.sendInput("\x1b[<16;2;1m");
	assert.equal(expanded, 1);
	assert.deepEqual(opened, ["https://ok.test/"]);
	tui.stop();
	await terminal.flush();
});

test("the no-modifier fallback still permits ordinary double-click word selection", async () => {
	const terminal = new VirtualTerminal(40, 5);
	const tui = new TuiAltScreen(terminal, false, process.env.PI_SCRATCH_DIR, {
		linkOpenModifier: "none",
		copyOnSelect: false,
	});
	tui.addChild(new Text("selectable text", 0, 0));
	tui.start();
	tui.renderNow();
	for (let i = 0; i < 2; i++) {
		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
	}
	assert.equal(tui.hasActiveSelection(), true);
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
