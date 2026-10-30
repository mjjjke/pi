import assert from "node:assert/strict";
import { describe, it } from "node:test";
import xterm from "@xterm/headless";
import { CURSOR_MARKER, renderFakeCursor } from "../src/tui.ts";
import { applyBackgroundSpan, stripTerminalSequences, truncateToWidth, visibleWidth } from "../src/utils.ts";

const hover = "\x1b[48;5;235m";
async function cells(line: string) {
	const terminal = new xterm.Terminal({ cols: 80, rows: 2, allowProposedApi: true });
	await new Promise<void>((resolve) => terminal.write(line, resolve));
	const row = terminal.buffer.active.getLine(0)!;
	const result = Array.from({ length: 20 }, (_, x) => {
		const cell = row.getCell(x)!;
		return {
			text: cell.getChars(),
			bg: cell.isBgDefault() ? undefined : cell.getBgColor(),
			fg: cell.isFgDefault() ? undefined : cell.getFgColor(),
			bold: cell.isBold(),
		};
	});
	terminal.dispose();
	return result;
}

describe("applyBackgroundSpan", () => {
	it("survives resets and truncation while preserving foreground and explicit inner backgrounds", async () => {
		const line = "\x1b[31;1ma\x1b[0mb\x1b[44mc\x1b[49md";
		const out = applyBackgroundSpan(line, 0, 6, hover);
		const row = await cells(`${out}z`);
		assert.deepEqual(
			row.slice(0, 7).map((cell) => cell.bg),
			[235, 235, 4, 235, 235, 235, undefined],
		);
		assert.ok(row[0].bold);
		assert.equal(row[0].fg, 1);
		assert.equal(row[1].fg, undefined);
		assert.equal(visibleWidth(out), 6);
		const clipped = applyBackgroundSpan(truncateToWidth("\x1b[1mabcdef", 5), 0, 5, hover);
		assert.deepEqual(
			(await cells(clipped)).slice(0, 5).map((cell) => cell.bg),
			[235, 235, 235, 235, 235],
		);
	});
	it("keeps inner truecolor through unrelated SGR and resumes hover after background resets", async () => {
		const line = "\x1b[48;5;23ma\x1b[48;2;10;20;30mb\x1b[31mc\x1b[49md\x1b[0mef";
		const row = await cells(applyBackgroundSpan(line, 0, 5, hover));
		assert.deepEqual(
			row.slice(0, 6).map((cell) => cell.bg),
			[235, 0x0a141e, 0x0a141e, 235, 235, undefined],
		);
		assert.equal(row[2].fg, 1);
		assert.equal(row[4].fg, undefined);
	});
	it("overrides the outer selected surface only inside the glyph span, then restores it", async () => {
		for (const [line, start] of [
			["\x1b[48;5;23m⊟ root\x1b[49m", 0],
			["\x1b[48:2::10:20:30m x⊞ branch\x1b[49m", 2],
		] as const) {
			const row = await cells(applyBackgroundSpan(line, start, start + 1, hover));
			assert.equal(row[start].bg, 235);
			assert.equal(row[start + 1].bg, start === 0 ? 23 : 0x0a141e);
			if (start) assert.equal(row[start - 1].bg, 0x0a141e);
		}
	});
	it("keeps wide boundary graphemes unchanged and unpainted", async () => {
		for (const [start, end, expected] of [
			[0, 2, [235, undefined, undefined, undefined]],
			[2, 3, [undefined, undefined, undefined, undefined]],
			[1, 3, [undefined, 235, 235, undefined]],
		] as const) {
			const out = applyBackgroundSpan("a界b", start, end, hover);
			assert.equal(stripTerminalSequences(out), "a界b");
			assert.equal(visibleWidth(out), 4);
			assert.deepEqual(
				(await cells(out)).slice(0, 4).map((cell) => cell.bg),
				expected,
			);
		}
	});
	it("preserves combining and emoji clusters and the fixed three-column tab convention", async () => {
		const out = applyBackgroundSpan("é🙂z", 0, 3, hover);
		assert.equal(stripTerminalSequences(out), "é🙂z");
		const row = await cells(out);
		// Headless xterm's default Unicode table treats this emoji as one cell.
		assert.equal(row.find((cell) => cell.text === "🙂")?.bg, 235);
		assert.equal(row.find((cell) => cell.text === "z")?.bg, undefined);
		const tab = applyBackgroundSpan("a\tb", 1, 4, hover);
		assert.equal(stripTerminalSequences(tab), "a\tb");
		assert.equal(visibleWidth(tab), 5);
		assert.deepEqual(
			(await cells(tab.replaceAll("\t", "   "))).slice(0, 5).map((cell) => cell.bg),
			[undefined, 235, 235, 235, undefined],
		);
	});
	it("preserves OSC 8 and APC/cursor marker bytes, without adding a hyperlink reset", () => {
		const open = "\x1b]8;id=one;https://example.com\x07";
		const close = "\x1b]8;;\x07";
		const line = `${open}a${CURSOR_MARKER}${renderFakeCursor("b")}cd${close}`;
		const out = applyBackgroundSpan(line, 1, 3, hover);
		assert.equal(out.replaceAll(hover, "").replaceAll("\x1b[49m", ""), line);
	});
	it("pads only through end and restores background at exact boundaries", async () => {
		for (const [line, start, end] of [
			["a", 3, 5],
			["", 0, 2],
			["abcdef", 1, 3],
		] as const) {
			const out = applyBackgroundSpan(line, start, end, hover);
			assert.equal(visibleWidth(out), Math.max(visibleWidth(line), end));
			const row = await cells(`${out}z`);
			for (let x = 0; x < visibleWidth(out) + 1; x++)
				assert.equal(row[x].bg, x >= start && x < end ? 235 : undefined);
		}
	});
	it("is byte-identical for empty/invalid spans and image lines", () => {
		for (const [start, end] of [
			[0, 0],
			[3, 2],
			[-1, 2],
			[0, Infinity],
			[0.5, 2],
			[NaN, 2],
		])
			assert.equal(applyBackgroundSpan("abc", start, end, hover), "abc");
		const image = "\x1b_Ga=T;AAAA\x1b\\";
		assert.equal(applyBackgroundSpan(image, 0, 5, hover), image);
	});
});
