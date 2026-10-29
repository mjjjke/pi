import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";
import { Text } from "../src/components/text.ts";
import { encodeITerm2, encodeKitty, isImageLine } from "../src/terminal-image.ts";
import {
	neutralizeTerminalLinks,
	sanitizeTerminalText,
	TerminalLinkFilter,
	webLinkPolicy,
} from "../src/terminal-links.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const E = "\x1b";
const ST = `${E}\\`;
const link = (url: string, end = ST, params = "") => `${E}]8;${params};${url}${end}`;
const bad = "smb://host/share";
const good = "https://ok.test/";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=";
const kitty = encodeKitty(png);
const image = encodeITerm2(png, { width: 40, height: "auto" });
const close = link("");
// Design v3.4 §5: original C1/nested fixtures 1–23, interrupted forms 24–33, width regressions 34–41.
const fixtures = [
	`\x9d8;;${bad}\x9cclick\x9d8;;\x9c`,
	`${link(bad, "\x9c")}click${close}`,
	`${link(bad, "\x07")}click${close}`,
	`${link(good, "\x9c", "id=a")}ok${close}`,
	"\x9b31mred",
	`\x9b\x9d8;;${bad}\x9c`,
	`${E}[31${link(bad)}x${close}`,
	`${E}[\x9d8;;${bad}`,
	`${E}]8;;${bad}`,
	"left\x85right",
	`${E}]0;title\x9d8;;${bad}\x9cclick${close}`,
	`${E}]0;title${link(bad)}click${close}`,
	`${E}]1337;File=inline=1:\x9d8;;${bad}\x9cclick`,
	`${E}_Ga=T,f=100;AAAA\x9d8;;${bad}\x9c`,
	`${E}_Ga=T;AA${link(bad)}x`,
	`${E}_pi:c\x9d8;;${bad}\x9c\x07`,
	`${E}Pqdata${ST}after`,
	`${E}_Ga=T;AA!!${ST}`,
	link(good, ST, "foo=bar:id=a"),
	`${E}_Ga=T;AAAA`,
	kitty,
	`${E}]0;a\x18b`,
	"🙂 界 é € ñ 𐀀",
	`${E}\x00]8;;${bad}\x07click`,
	`${E}\x08]8;;${bad}\x07`,
	`${E}\x9c]8;;${bad}\x07`,
	`${E}${E}]8;;${bad}\x07x`,
	`${E}\x7f]8;;${bad}\x07`,
	`${E}]0;t\x07]8;;${bad}\x07`,
	`${E}]8;;https://ok.test/`,
	`${E}]133;A\x07${E}]133;B\x07${E}]133;C\x07`,
	`${E}]133;A;x\x07${E}]133;D\x07`,
	`${link(good, ST, "id=a")}${E}[31mtext${close}`,
	`${E}[2A${image}\x9c`,
	`${image + link(bad)}click`,
	`${E}]0;t\x07${image}`,
	`${E}[29A${image}\x9c`,
	`${kitty}\x9c${E}]0;t\x07junk`,
	`${E}_pi:c\x07${kitty}${E}[2A${image}text${link(good, ST, "id=a")}${E}_Ga=d,d=A,q=2${ST}\x07`,
	`${link(good, ST, "id=a")}${E}[31m界界界界界${E}[39m${close}${E}]0;title\x07abc`,
	`${E}]0;${"t".repeat(30)}\x07${"x".repeat(80)}`,
];

// Independent grammar oracle: assert the partition, not only the absence of one known exploit.
const b64 = "(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?";
const kittyGrammar = `\\x1b_G[A-Za-z]=[A-Za-z0-9]{1,16}(?:,[A-Za-z]=[A-Za-z0-9]{1,16})*(?:;${b64})?\\x1b\\\\`;
const itermGrammar = `\\x1b\\]1337;File=(?:inline|size|width|height|name|preserveAspectRatio)=[A-Za-z0-9+/=%.]{1,256}(?:;(?:inline|size|width|height|name|preserveAspectRatio)=[A-Za-z0-9+/=%.]{1,256})*:${b64}\\x07`;
const tokenGrammar = new RegExp(
	`(?:\\x1b\\[[0-9;:]{0,128}m|\\x1b\\]8;(?:id=[A-Za-z0-9_-]{1,64})?;[\\x21-\\x7e]{0,4096}(?:\\x07|\\x1b\\\\)|\\x1b\\]133;[ABC]\\x07|${kittyGrammar}|${itermGrammar}|\\x1b_pi:(?:c|fc|/fc)\\x07|\\x1b\\[[1-9][0-9]{0,3}A(?=${kittyGrammar}|${itermGrammar}))`,
	"y",
);
function tokens(input: string, strict: boolean): string[] {
	const result: string[] = [];
	for (let i = 0; i < input.length; ) {
		if (input[i] !== E) {
			i++;
			continue;
		}
		tokenGrammar.lastIndex = i;
		const match = tokenGrammar.exec(input);
		const target = match && /^\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)$/.exec(match[0])?.[1];
		if (!match || (target && !webLinkPolicy(target))) {
			assert.ok(!strict, `unrecognized ESC at ${i}: ${JSON.stringify(input)}`);
			i++;
			continue;
		}
		result.push(match[0]);
		i = tokenGrammar.lastIndex;
	}
	return result;
}

async function assertParserSafe(output: string): Promise<void> {
	const terminal = new xterm.Terminal({ allowProposedApi: true, logLevel: "off" });
	const targets: string[] = [];
	terminal.parser.registerOscHandler(8, (value) => {
		targets.push(value.slice(value.indexOf(";") + 1));
		return true;
	});
	await new Promise<void>((resolve) => terminal.write(output, resolve));
	terminal.dispose();
	for (const target of targets) assert.ok(!target || webLinkPolicy(target), target);
}

test("source sanitizer removes whole strings, CSI and controls, preserving tabs and newlines", () => {
	assert.equal(
		sanitizeTerminalText(
			`a${link(bad)}b${close}${E}[31mc${E}Pqabc${ST}${E}_junk${ST}\x7f\x9b31m\x9d8;;x\x9c\t\n${E}`,
		),
		"abc\t\n",
	);
});

test("all 41 security fixtures are parser-safe, C1-free and cross-width fixpoints", async () => {
	for (const input of fixtures)
		for (const width of [1, 4, 40, 80]) {
			const output = neutralizeTerminalLinks(input, webLinkPolicy, width);
			assert.deepEqual(tokens(output, true), tokens(input, false));
			assert.doesNotMatch(output, /[\u0080-\u009f]/);
			for (const other of [1, 4, 40, 80])
				assert.equal(neutralizeTerminalLinks(output, webLinkPolicy, other), output);
			await assertParserSafe(output);
			if (output !== input && !isImageLine(output)) assert.ok(visibleWidth(output) <= width);
		}
});

test("all fixtures remain safe through Text, regular/fullscreen frames, and the fullscreen exit dump", async () => {
	for (const input of fixtures)
		for (const fullscreen of [false, true]) {
			const terminal = new VirtualTerminal(80, 24);
			const writes: string[] = [];
			terminal.write = (data) => {
				writes.push(data);
			};
			const tui = fullscreen
				? new TuiAltScreen(terminal, false, process.env.PI_SCRATCH_DIR)
				: new TuiMainScreen(terminal, false, process.env.PI_SCRATCH_DIR);
			tui.addChild(new Text(input, 0, 0));
			tui.start();
			tui.renderNow();
			if (tui instanceof TuiAltScreen) for (const line of tui.getScreenLines()) tokens(line, true);
			tui.stop();
			await assertParserSafe(writes.join(""));
		}
});

test("width repair keeps all commands including the complete iTerm image and trailing closes", () => {
	for (const width of [1, 4, 40, 80]) {
		assert.equal(neutralizeTerminalLinks(`${E}[2A${image}\x9c`, webLinkPolicy, width), `${E}[2A${image}`);
		assert.equal(neutralizeTerminalLinks(`${image + link(bad)}junk`, webLinkPolicy, width), image);
	}
	assert.equal(
		neutralizeTerminalLinks(fixtures[39], webLinkPolicy, 4),
		`${link(good, ST, "id=a")}${E}[31m界界${E}[39m${close}`,
	);
	assert.equal(visibleWidth(neutralizeTerminalLinks(fixtures[40], webLinkPolicy, 80)), 80);
	for (const input of [kitty, image, `${E}_pi:c\x07`, `${E}[31m🙂${E}[0m`, close])
		assert.equal(neutralizeTerminalLinks(input, webLinkPolicy, 1), input);
});

test("frame cache invalidates on width and policy changes, including mutable frame arrays", () => {
	const filter = new TerminalLinkFilter();
	const lines = [`${link(good)}hello${close}`];
	assert.equal(filter.filter(lines, webLinkPolicy, 80)[0], lines[0]);
	const refused = () => undefined;
	assert.ok(!filter.filter(lines, refused, 4)[0].includes(`${E}]8;;${good}`));
	assert.ok(visibleWidth(filter.filter(lines, refused, 1)[0]) <= 1);
	lines[0] = "plain";
	assert.deepEqual(filter.filter(lines, refused, 1), ["plain"]);
});

test("fragment generator remains safe and idempotent after repair", async () => {
	const fragments = [...fixtures, "text", "\t", "\x00", E, "\x9c", "]8;;smb://h/", "]0;", "_G", "133;A", "\\"];
	let seed = 42;
	for (let n = 0; n < 5000; n++) {
		let input = "";
		for (let i = 0; i < 6; i++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			input += fragments[seed % fragments.length];
		}
		const width = [1, 4, 40, 80][n % 4];
		const output = neutralizeTerminalLinks(input, webLinkPolicy, width);
		assert.doesNotMatch(output, /[\u0080-\u009f]/);
		assert.deepEqual(tokens(output, true), tokens(input, false));
		for (const other of [1, 4, 40, 80, Infinity])
			assert.equal(neutralizeTerminalLinks(output, webLinkPolicy, other), output);
		const commands = tokens(output, true);
		assert.equal(
			isImageLine(output),
			commands.some((token) => token.startsWith(`${E}_G`) || token.startsWith(`${E}]1337;File=`)),
		);
		if (output !== input) {
			if (isImageLine(output)) {
				let text = output;
				for (const token of commands) text = text.replace(token, "");
				assert.equal(text, "");
			} else assert.ok(visibleWidth(output) <= width);
		}
		await assertParserSafe(output);
	}
});
