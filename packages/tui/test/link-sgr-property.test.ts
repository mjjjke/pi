import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import xterm from "@xterm/headless";
import { Text } from "../src/components/text.ts";
import { linkTo, setCapabilities } from "../src/terminal-image.ts";
import { neutralizeTerminalLinks } from "../src/terminal-links.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { extractSegments, underlineOsc8Link, wrapTextWithAnsi } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// The runtime exposes underline details not yet declared by xterm/headless's public typings.
interface UnderlineCell extends xterm.IBufferCell {
	getUnderlineStyle(): number;
	getUnderlineColor(): number;
	getUnderlineColorMode(): number;
}
const url = "https://oracle.test/";
const target = { url, id: "oracle" };

test("seeded SGR parser property: reconstruction, wrapping, hover and exact pointer leave match xterm", async () => {
	const seed = 0x5a178bad;
	let state = seed;
	const random = (max: number) => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state % max;
	};
	const parameters = [
		...Array.from({ length: 108 }, (_, i) => String(i)),
		"",
		";",
		"7;",
		"4;",
		"21",
		"4:0",
		"4:1",
		"4:2",
		"4:3",
		"4:4",
		"4:5",
		"4:9",
		"4:",
		"4:00",
		"22;23;24;25;27;28;29",
		"53",
		"55",
		"59",
		"999",
		"1234:5",
	];
	// Generate lists around and beyond the terminal parameter capacity. Minimized
	// reset-state cases also live in link-hover-regressions.test.ts.
	for (let count = 30; count <= 70; count++) {
		parameters.push([...Array(count - 1).fill("1"), "7"].join(";"));
	}
	for (const code of [38, 48, 58]) {
		// The sink admits omitted operands and mixed parameter/subparameter forms too.
		parameters.push(
			`${code};5`,
			`${code};2;`,
			`${code}:5:`,
			`${code}:2::`,
			`${code};5:7`,
			`${code};2::0:7:0`,
			`${code};2;0:7:0`,
			`${code};0;1;2;3;4;7`,
			`${code};5;2147483648`,
			`${code};2;2147483648;4294967296;9999999999999999999999999999999999`,
			`${code}:5:2147483648`,
			`${code}:2::2147483648:4294967296:9999999999999999999999999999999999`,
		);
		for (let i = 0; i < 8; i++) {
			const channels = [random(256), random(256), random(256)];
			parameters.push(
				`${code};5;${random(256)}`,
				`${code}:5:${random(256)}`,
				`${code};2;${channels.join(";")}`,
				`${code}:2::${channels.join(":")}`,
				`${code}:2:${channels.join(":")}`,
			);
		}
	}
	const emulator = new xterm.Terminal({ cols: 80, rows: 20, allowProposedApi: true });
	emulator.parser.registerOscHandler(8, () => true);
	const read = async (lines: string[]) => {
		await new Promise<void>((resolve) =>
			emulator.write(lines.map((line, row) => `\x1b[0m\x1b[${row + 1};1H\x1b[2K${line}`).join(""), resolve),
		);
		return lines.map((_, row) =>
			Array.from({ length: 16 }, (_, col) => {
				const c = emulator.buffer.active.getLine(row)!.getCell(col)! as UnderlineCell;
				return {
					text: c.getChars(),
					bold: c.isBold(),
					dim: c.isDim(),
					italic: c.isItalic(),
					underline: c.getUnderlineStyle(),
					underlineColor: c.getUnderlineColor(),
					underlineMode: c.getUnderlineColorMode(),
					blink: c.isBlink(),
					inverse: Boolean(c.isInverse()),
					hidden: c.isInvisible(),
					strike: c.isStrikethrough(),
					overline: c.isOverline(),
					fg: c.getFgColor(),
					fgMode: c.getFgColorMode(),
					bg: c.getBgColor(),
					bgMode: c.getBgColorMode(),
				};
			}),
		);
	};
	setCapabilities({ images: null, hyperlinks: true, trueColor: true });
	const terminal = new VirtualTerminal(80, 20);
	const tui = new TuiAltScreen(terminal, false, process.env.PI_SCRATCH_DIR, {
		copyOnSelect: false,
		openUrl: () => {},
	});
	const component = new Text("", 0, 0);
	tui.addChild(component);
	tui.start();
	const failures: string[] = [];
	try {
		for (let iteration = 0; iteration < 384; iteration++) {
			let source = "";
			let styleSource = "";
			const styles: string[] = [];
			for (let step = 0; step < 4; step++) {
				// Enumerate the grammar's base codes as well as random combinations and color operands.
				const p =
					step === 3 && iteration < parameters.length
						? parameters[iteration]
						: Array.from({ length: 1 + random(4) }, () => parameters[random(parameters.length)]).join(";");
				styleSource += neutralizeTerminalLinks(`\x1b[${p}m`);
				styles.push(styleSource);
				source += `\x1b[${p}m${step % 2 ? linkTo("b", url, { id: "oracle" }) : "a"}`;
			}
			source += "tail";
			styles.push(styleSource, styleSource, styleSource, styleSource);
			const filtered = neutralizeTerminalLinks(source);
			const painted = neutralizeTerminalLinks(underlineOsc8Link(filtered, target));
			// Layout consumes raw component output before the final sink, so its
			// reconstructed state must agree with the sink's supported grammar too.
			const reconstructed = Array.from({ length: 8 }, (_, col) =>
				neutralizeTerminalLinks(extractSegments(source, 0, col, 1).after),
			);
			const wrapped = wrapTextWithAnsi(source, 1).map((line) => neutralizeTerminalLinks(line));
			const baseline = (await read([filtered]))[0];
			const expectedHover = await read(
				styles.map((style, col) => {
					const selected = col === 1 || col === 3;
					return (
						style +
						(selected
							? `\x1b[${baseline[col].inverse ? 27 : 7}m${baseline[col].underline ? "" : "\x1b[4m"}`
							: "") +
						"ababtail"[col]
					);
				}),
			);
			const hover = (await read([painted]))[0];
			const restored = await read(reconstructed);
			const continuation = await read(wrapped);
			try {
				for (let col = 0; col < 8; col++) {
					assert.deepEqual(restored[col][0], baseline[col], `reconstructed cell ${col}`);
					assert.deepEqual(continuation[col][0], baseline[col], `wrapped cell ${col}`);
					assert.deepEqual(hover[col], expectedHover[col][0], `hover cell ${col} (tail must remain unlinked)`);
				}
				component.setText(source);
				tui.renderNow();
				const original = tui.getScreenLines();
				terminal.sendInput("\x1b[<35;2;1M");
				tui.renderNow();
				const actualHover = (await read(tui.getScreenLines()))[0];
				for (let col = 0; col < 8; col++)
					assert.deepEqual(actualHover[col], expectedHover[col][0], `composited hover cell ${col}`);
				terminal.sendInput("\x1b[<35;80;20M");
				tui.renderNow();
				assert.deepEqual(tui.getScreenLines(), original, "pointer leave must restore exact bytes");
			} catch (error) {
				failures.push(`seed=${seed} iteration=${iteration} source=${JSON.stringify(source)}\n${inspect(error)}`);
			}
		}
		assert.equal(failures.length, 0, failures.join("\n\n"));
	} finally {
		tui.stop({ preserveScreen: true });
		emulator.dispose();
	}
});
