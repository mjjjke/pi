import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";
import { encodeITerm2, encodeKitty, isImageLine } from "../src/terminal-image.ts";
import { neutralizeTerminalLinks, sanitizeTerminalText, webLinkPolicy } from "../src/terminal-links.ts";
import { visibleWidth } from "../src/utils.ts";

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
			assert.doesNotMatch(output, /[\u0080-\u009f]/);
			for (const other of [1, 4, 40, 80])
				assert.equal(neutralizeTerminalLinks(output, webLinkPolicy, other), output);
			await assertParserSafe(output);
			if (output !== input && !isImageLine(output)) assert.ok(visibleWidth(output) <= width);
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

test("fragment generator remains safe and idempotent after repair", async () => {
	const fragments = [...fixtures, "text", "\t", "\x00", E, "\x9c", "]8;;smb://h/", "]0;", "_G", "133;A", "\\"];
	let seed = 42;
	for (let n = 0; n < 1000; n++) {
		let input = "";
		for (let i = 0; i < 6; i++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			input += fragments[seed % fragments.length];
		}
		const width = [1, 4, 40, 80][n % 4];
		const output = neutralizeTerminalLinks(input, webLinkPolicy, width);
		assert.doesNotMatch(output, /[\u0080-\u009f]/);
		assert.equal(neutralizeTerminalLinks(output, webLinkPolicy, 1), output);
		await assertParserSafe(output);
	}
});
