import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { Text } from "../src/components/text.ts";
import { linkTo, setCapabilities } from "../src/terminal-image.ts";
import { CURSOR_MARKER, renderFakeCursor } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import {
	extractSegments,
	getActiveBackgroundAnsi,
	getOsc8LinkAtColumn,
	underlineOsc8Link,
	wrapTextWithAnsi,
} from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Ported from the independent review of 887121c08. Never launch an external URL handler.
const url = "https://ok.test/";
const link = (text: string) => linkTo(text, url, { id: "review" });

async function cells(lines: string[], cols = 40) {
	const emulator = new xterm.Terminal({ cols, rows: 10, allowProposedApi: true });
	emulator.parser.registerOscHandler(8, () => true);
	try {
		await new Promise<void>((resolve) =>
			emulator.write(`\x1b[0m${lines.map((line, row) => `\x1b[${row + 1};1H${line}`).join("")}`, resolve),
		);
		return lines.map((_, row) =>
			Array.from({ length: cols }, (_, column) => {
				const cell = emulator.buffer.active.getLine(row)!.getCell(column)!;
				return {
					text: cell.getChars(),
					width: cell.getWidth(),
					inverse: cell.isInverse(),
					underline: cell.isUnderline(),
					bold: cell.isBold(),
					italic: cell.isItalic(),
					fg: cell.getFgColor(),
					bg: cell.getBgColor(),
				};
			}),
		);
	} finally {
		emulator.dispose();
	}
}

function setup(text: string, cols = 40, hardwareCursor = false) {
	setCapabilities({ images: null, hyperlinks: true, trueColor: true });
	const terminal = new VirtualTerminal(cols, 10);
	const opened: string[] = [];
	const tui = new TuiAltScreen(terminal, hardwareCursor, process.env.PI_SCRATCH_DIR, {
		copyOnSelect: false,
		openUrl: (target) => opened.push(target),
	});
	const component = new Text(text, 0, 0);
	tui.addChild(component);
	tui.start();
	tui.renderNow();
	return { terminal, tui, opened, component };
}
function hover(state: ReturnType<typeof setup>, x = 1, y = 1) {
	state.terminal.sendInput(`\x1b[<35;${x};${y}M`);
	state.tui.renderNow();
}
function click(state: ReturnType<typeof setup>, x = 1, y = 1) {
	state.terminal.sendInput(`\x1b[<16;${x};${y}M`);
	state.terminal.sendInput(`\x1b[<16;${x};${y}m`);
	assert.equal(state.opened.pop(), url);
}
async function assertHover(state: ReturnType<typeof setup>, x = 1, y = 1) {
	state.tui.renderNow();
	const original = state.tui.getScreenLines();
	const before = await cells(original, state.terminal.columns);
	const target = getOsc8LinkAtColumn(original[y - 1], x - 1);
	assert.equal(target?.url, url);
	hover(state, x, y);
	const after = await cells(state.tui.getScreenLines(), state.terminal.columns);
	hover(state, state.terminal.columns, 9);
	assert.deepEqual(
		state.tui.getScreenLines(),
		original,
		"pointer leave restores exact sequences, including selection",
	);
	click(state, x, y);
	for (let row = 0; row < original.length; row++) {
		for (let col = 0; col < state.terminal.columns; col++) {
			const candidate = getOsc8LinkAtColumn(original[row], col);
			const selected = candidate?.url === target?.url && candidate?.id === target?.id;
			const baseline = before[row][col];
			const painted = after[row][col];
			if (!selected) assert.deepEqual(painted, baseline, `unlinked cell ${col},${row}`);
			else {
				assert.equal(Boolean(painted.inverse), !baseline.inverse, `inverse must toggle at ${col},${row}`);
				assert.ok(painted.underline);
				assert.deepEqual({ ...painted, inverse: baseline.inverse, underline: baseline.underline }, baseline);
			}
		}
	}
	return original;
}

for (const selection of [false, true]) {
	test(`hover toggles every inverse cell, including partial selection=${selection}`, async () => {
		const state = setup(`\x1b[4;1;3;44m${link(selection ? "abcde" : "a\x1b[7mbc\x1b[27mde")}\x1b[0m tail`);
		try {
			if (selection) {
				state.terminal.sendInput("\x1b[<0;2;1M");
				state.terminal.sendInput("\x1b[<32;3;1M");
				state.terminal.sendInput("\x1b[<0;3;1m");
				state.tui.renderNow();
				assert.ok(state.tui.hasActiveSelection());
			}
			const original = state.tui.getScreenLines();
			await assertHover(state);
			// A click intentionally clears selection; pointer leave must not.
			if (!selection) {
				hover(state);
				hover(state, 40, 10);
				assert.deepEqual(state.tui.getScreenLines(), original);
			}
		} finally {
			state.tui.stop();
		}
	});
}

test("fake cursor keeps its inverse contrast while the entire link is hovered", async () => {
	const state = setup(`\x1b[4m${link(`${CURSOR_MARKER}${renderFakeCursor("a")}bc`)}\x1b[24m`);
	try {
		const original = await assertHover(state, 2);
		hover(state, 2);
		const painted = await cells(state.tui.getScreenLines());
		assert.notEqual(painted[0][0].inverse, painted[0][1].inverse);
		hover(state, 40, 10);
		assert.deepEqual(state.tui.getScreenLines(), original);
	} finally {
		state.tui.stop();
	}
});

for (const kind of ["elsewhere", "inside", "search", "handled move"] as const) {
	test(`composited link hover agrees with activation: ${kind}`, async () => {
		const state = setup(`\x1b[4m${link("abc")}\x1b[24m tail`);
		let x = 1,
			y = 1,
			moves = 0;
		try {
			if (kind === "elsewhere")
				state.tui.showOverlay(new Text("panel", 0, 0), { anchor: "bottom-right", width: 8, nonCapturing: true });
			if (kind === "inside") {
				state.tui.showOverlay(new Text(`\x1b[4m${linkTo("abc", url, { id: "overlay" })}\x1b[24m`, 0, 0), {
					anchor: "bottom-right",
					width: 8,
				});
				x = 33;
				y = 10;
			}
			if (kind === "search") {
				state.terminal.sendInput("\x1b[102;6u");
				state.terminal.sendInput("abc");
			}
			if (kind === "handled move") {
				state.tui.children.length = 0;
				state.tui.addChild(
					new MouseRegion(state.component, (event) => {
						if (event.type !== "move") return undefined;
						moves++;
						return { handled: true };
					}),
				);
			}
			state.tui.renderNow();
			await assertHover(state, x, y);
			if (kind === "handled move") assert.equal(moves, 1);
		} finally {
			state.tui.stop();
		}
	});
}

test("overlay clipping paints only visible segments and invalidates covered anchors", async () => {
	const state = setup(`\x1b[4m${link("abcdefghi")}\x1b[24m tail`);
	try {
		const elsewhere = state.tui.showOverlay(new Text("panel", 0, 0), { anchor: "bottom-right", width: 8 });
		await assertHover(state);
		hover(state);
		elsewhere.hide();
		state.tui.renderNow();
		assert.match(state.tui.getScreenLines()[0], /\x1b\[7m/, "uncovered stationary hover survives overlay removal");
		const cover = state.tui.showOverlay(new Text("XX", 0, 0), { row: 0, col: 3, width: 2 });
		state.tui.renderNow();
		assert.doesNotMatch(state.tui.getScreenLines()[0], /\x1b\[7m/, "changed anchor region invalidates old hover");
		await assertHover(state);
		const original = state.tui.getScreenLines();
		hover(state, 4);
		assert.deepEqual(state.tui.getScreenLines(), original, "covered cells are not link hover targets");
		state.terminal.sendInput("\x1b[<16;4;1M");
		state.terminal.sendInput("\x1b[<16;4;1m");
		assert.deepEqual(state.opened, []);
		cover.hide();
	} finally {
		state.tui.stop();
	}
});

test("wrapping assigns one identity across literal newlines and wide-cell wraps", () => {
	const raw = `\x1b]8;;${url}\x07界界\n界界\x1b]8;;\x07`;
	const wrapped = wrapTextWithAnsi(raw, 2, "source");
	const occurrence = getOsc8LinkAtColumn(wrapped[0], 0);
	assert.ok(occurrence?.id);
	assert.equal(wrapped.length, 4);
	for (const line of wrapped) {
		assert.deepEqual(getOsc8LinkAtColumn(line, 0), occurrence);
		assert.deepEqual(getOsc8LinkAtColumn(line, 1), occurrence);
	}
	for (const line of wrapTextWithAnsi(raw, 4, "source")) {
		assert.deepEqual(getOsc8LinkAtColumn(line, 3), occurrence);
	}
	assert.equal(getOsc8LinkAtColumn(wrapTextWithAnsi(link("abc"), 2)[1], 0)?.id, "review");
});

for (const terminator of ["\x07", "\x1b\\"]) {
	test(`id-less occurrences retain distinct identities through wrapping, terminator=${JSON.stringify(terminator)}`, async () => {
		const raw = `\x1b]8;;${url}${terminator}abcdefgh\x1b]8;;${terminator}`;
		const state = setup(`${raw}\n${raw}`, 4);
		state.tui.addChild(new Text(raw, 0, 0));
		try {
			state.tui.renderNow();
			const original = state.tui.getScreenLines();
			const ids = [0, 2, 4].map((row) => getOsc8LinkAtColumn(original[row], 0)?.id);
			assert.ok(ids.every(Boolean), "assign identity before wrapping");
			assert.equal(new Set(ids).size, 3, "equal URLs must not merge separate source occurrences");
			for (const row of [1, 2, 3, 4, 5, 6]) {
				await assertHover(state, 1, row);
			}
			hover(state, 1, 1);
			state.component.setText(`${raw}\n${raw}\ntick`);
			state.tui.renderNow();
			assert.match(state.tui.getScreenLines()[1], /\x1b\[7m/);
		} finally {
			state.tui.stop();
		}
	});
}

for (const sgr of ["58;5;7", "58;2;0;7;0"]) {
	test(`underline color must not corrupt hover or unlinked cells: ${sgr}`, async () => {
		const state = setup(`\x1b[4;${sgr}m${link("abc")} tail\x1b[0m`);
		try {
			const original = await assertHover(state);
			hover(state, 40, 10);
			assert.deepEqual(state.tui.getScreenLines(), original);
		} finally {
			state.tui.stop();
		}
	});
}

test("all tracker consumers preserve underline colors atomically, including colon colors and SGR 59", async () => {
	for (const color of [
		"58;5;7",
		"58;2;0;7;0",
		"58:5:7",
		"58:2::0:7:0",
		"38:5:7",
		"38:2::0:7:0",
		"48:5:7",
		"48:2::0:7:0",
	]) {
		const prefix = `\x1b[1;3;4;44;${color}m`;
		const source = `${prefix}ab`;
		const continuation = wrapTextWithAnsi(source, 1)[1];
		assert.ok(continuation.includes(color), "wrap must reopen the complete color");
		const expected = await cells([`${prefix}b`]);
		assert.deepEqual((await cells([continuation]))[0][0], expected[0][0]);
		const after = extractSegments(source, 0, 1, 1).after;
		assert.match(after, new RegExp(color));
		assert.deepEqual((await cells([after]))[0][0], expected[0][0]);
		assert.equal(
			getActiveBackgroundAnsi(`${prefix}\x1b[59m`),
			color.startsWith("48") ? `\x1b[${color}m` : "\x1b[44m",
		);
		for (const reset of ["59", "0"]) {
			const resetLine = wrapTextWithAnsi(`${prefix}\x1b[${reset}mab`, 1)[1];
			if (color.startsWith("58")) assert.ok(!resetLine.includes(color), `${reset} must clear underline color`);
		}
		const original = `${prefix}${link("abc")} tail\x1b[0m`;
		const painted = underlineOsc8Link(original, { url, id: "review" });
		assert.deepEqual((await cells([painted]))[0][4], (await cells([original]))[0][4]);
	}
});
