import assert from "node:assert/strict";
import { afterEach, describe, it, type TestContext } from "node:test";
import { Editor, type EditorTheme } from "../src/components/editor.ts";
import { setPointerHoverBackground } from "../src/components/list-mouse.ts";
import { SelectList } from "../src/components/select-list.ts";
import { Spacer } from "../src/components/spacer.ts";
import { recordMouseLayout } from "../src/mouse-layout.ts";
import { type Component, Container, type TuiMouseEvent, type TuiMouseEventResult } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const bg = "\x1b[48;5;235m";
const theme: EditorTheme = {
	borderColor: (text) => text,
	selectList: {
		selectedPrefix: (text) => text,
		selectedText: (text) => text,
		description: (text) => text,
		scrollInfo: (text) => text,
		noMatch: (text) => text,
	},
};
function event(type: TuiMouseEvent["type"], y = 4): TuiMouseEvent {
	return {
		type,
		button: "none",
		x: 3,
		y,
		screenX: 3,
		screenY: y,
		width: 40,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
	};
}
async function fixture(t: TestContext, withCounter = false) {
	const terminal = new VirtualTerminal(40, 10);
	const tui = new TuiAltScreen(terminal);
	const editor = new Editor(tui, theme);
	let activations = 0;
	editor.setAutocompleteProvider({
		getSuggestions: async () => ({
			prefix: "/",
			items: [
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
				{ value: "c", label: "C" },
				...(withCounter ? [{ value: "d", label: "D" }] : []),
			],
		}),
		applyCompletion: (lines, cursorLine, cursorCol) => {
			activations++;
			return { lines, cursorLine, cursorCol };
		},
	});
	if (withCounter) editor.setAutocompleteMaxVisible(3);
	editor.handleInput("/");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(editor.isShowingAutocomplete(), true);
	editor.render(40);
	t.after(() => tui.stop());
	return { editor, terminal, tui, activations: () => activations };
}
afterEach(() => setPointerHoverBackground(undefined));

describe("Editor autocomplete hover forwarding", () => {
	for (const exitRow of [0, 1, 2, 6, 8]) {
		for (const returnRow of [4, 5]) {
			it(`hovers on the first renderer re-entry from row ${exitRow} to ${returnRow}`, async (t) => {
				setPointerHoverBackground(() => bg);
				const { editor, terminal, tui } = await fixture(t, true);
				const writes: string[] = [];
				const write = terminal.write.bind(terminal);
				terminal.write = (data) => {
					writes.push(data);
					write(data);
				};
				tui.addChild(editor);
				tui.start();
				tui.renderNow();
				for (const renderBetween of [false, true]) {
					terminal.sendInput("\x1b[<35;4;5M");
					tui.renderNow();
					assert.ok(tui.getScreenLines()[4].includes(bg));
					terminal.sendInput(`\x1b[<35;4;${exitRow + 1}M`);
					if (renderBetween) tui.renderNow();
					writes.length = 0;
					terminal.sendInput(`\x1b[<35;4;${returnRow + 1}M`);
					tui.renderNow();
					await terminal.flush();
					assert.ok(tui.getScreenLines()[returnRow].includes(bg));
					assert.ok(writes.join("").includes("\x1b]22;pointer\x1b\\"));
					assert.equal(terminal.getViewport()[returnRow].trim(), returnRow === 4 ? "B" : "C");
				}
			});
		}
	}
	for (const change of ["move", "content", "replace"] as const) {
		it(`clears a nested autocomplete owner on ${change} without pointer motion`, async (t) => {
			setPointerHoverBackground(() => bg);
			const { editor, tui, terminal } = await fixture(t);
			const child = new SelectList(
				[
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
				],
				5,
				theme.selectList,
			);
			const top = new Spacer(1);
			const bottom = new Spacer(2);
			const menu = new Container();
			menu.addChild(top);
			menu.addChild(child);
			menu.addChild(bottom);
			// Exercise the forwarding contract with a composite suggestion list.
			class CompositeList extends SelectList {
				override render(width: number) {
					const lines = menu.render(width);
					recordMouseLayout(this, [{ component: menu, originX: 0, originY: 0, width, height: lines.length }]);
					return lines;
				}
				override handleMouse(input: TuiMouseEvent) {
					return menu.handleMouse(input);
				}
			}
			const list = new CompositeList([], 5, theme.selectList);
			(editor as unknown as { autocompleteList: SelectList }).autocompleteList = list;
			terminal.resize(40, 20);
			tui.addChild(editor);
			tui.start();
			tui.renderNow();
			terminal.sendInput("\x1b[<35;4;6M");
			tui.renderNow();
			assert.ok(tui.getScreenLines()[5].includes(bg));
			const move = editor.handleMouse(event("move", 5))!;
			assert.equal(move.hoverValid?.(), true);
			if (change === "move") {
				top.setLines(2);
				bottom.setLines(1);
			} else if (change === "content") {
				menu.children[1] = new SelectList(
					[
						{ value: "a", label: "A" },
						{ value: "b", label: "B" },
					],
					5,
					theme.selectList,
				);
			} else menu.clear();
			if (change !== "replace") {
				tui.renderNow();
				assert.equal(move.hoverValid?.(), false);
				assert.ok(tui.getScreenLines().every((line) => !line.includes(bg)));
			} else {
				editor.handleMouse(event("leave", -100));
				assert.equal(move.hoverValid?.(), false);
			}
		});
	}
	it("forwards suggestion moves, but never hovers the body or changes text/cursor/selection", async (t) => {
		setPointerHoverBackground(() => bg);
		const { editor, activations } = await fixture(t);
		const before = editor.getCursor();
		const move = editor.handleMouse(event("move"))!;
		assert.equal(move.pointerShape, "pointer");
		assert.equal(move.hoverValid?.(), true);
		assert.ok(editor.render(40)[4].includes(bg));
		assert.equal(editor.getText(), "/");
		assert.deepEqual(editor.getCursor(), before);
		assert.equal(activations(), 0);
		const cleared = editor.handleMouse(event("move", 1))!;
		assert.equal(cleared.handled, true);
		assert.equal(cleared.render, true);
		assert.equal((cleared as { target?: { component: Component } }).target?.component instanceof SelectList, true);
		assert.equal(move.hoverValid?.(), false);
		assert.ok(editor.render(40).every((line) => !line.includes(bg)));
		assert.equal(editor.handleMouse(event("move", 1)), undefined);
	});
	it("forwards leave independent of current y and clears on keys and owned wheel", async (t) => {
		const { editor } = await fixture(t);
		for (const clear of [
			() => editor.handleMouse(event("leave", -100)),
			() => editor.handleInput("\x03"),
			() => editor.handleMouse({ ...event("wheel"), wheelDelta: 1 }),
		]) {
			const move = editor.handleMouse(event("move"))!;
			clear();
			assert.equal(move.hoverValid?.(), false);
		}
	});
	it("ends the old episode on async suggestion replacement and cancellation", async (t) => {
		const { editor } = await fixture(t);
		const move = editor.handleMouse(event("move"))!;
		// A cursor click requests a new completion list without a keyboard leave.
		editor.handleMouse({ ...event("click", 1), button: "left" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		editor.render(40);
		assert.equal(move.hoverValid?.(), false);
		const next = editor.handleMouse(event("move"))!;
		editor.setText("");
		assert.equal(next.hoverValid?.(), false);
	});
	it("invalidates child-origin changes inside an unchanged renderer target rectangle", async (t) => {
		setPointerHoverBackground(() => bg);
		const { editor, terminal, tui } = await fixture(t);
		let move: TuiMouseEventResult | undefined;
		const host: Component = {
			render(width) {
				const lines = editor.render(width);
				return [...lines, ...Array<string>(10 - lines.length).fill("")];
			},
			invalidate() {},
			handleMouse(input) {
				const result = editor.handleMouse(input);
				if (input.type === "move") move = result;
				return result;
			},
		};
		tui.addChild(host);
		tui.start();
		tui.renderNow();
		terminal.sendInput("\x1b[<35;4;5M");
		tui.renderNow();
		assert.equal(move?.hoverValid?.(), true);
		assert.ok(tui.getScreenLines()[4].includes(bg));
		editor.setPaddingX(1);
		tui.renderNow();
		assert.equal(move?.hoverValid?.(), false);
		assert.ok(tui.getScreenLines().every((line) => !line.includes(bg)));
	});
	it("invalidates a changed child y origin even when the parent rectangle stays fixed", async (t) => {
		setPointerHoverBackground(() => bg);
		const { editor, terminal, tui } = await fixture(t);
		terminal.resize(40, 20);
		editor.setText(Array<string>(10).fill("body").join("\n"));
		editor.handleInput("\t");
		await new Promise<void>((resolve) => setImmediate(resolve));
		let move: TuiMouseEventResult | undefined;
		const host: Component = {
			render(width) {
				const lines = editor.render(width);
				return [...lines, ...Array<string>(14 - lines.length).fill("")];
			},
			invalidate() {},
			handleMouse(input) {
				const result = editor.handleMouse(input);
				if (input.type === "move") move = result;
				return result;
			},
		};
		tui.addChild(host);
		tui.start();
		tui.renderNow();
		terminal.sendInput("\x1b[<35;4;10M");
		tui.renderNow();
		assert.equal(move?.hoverValid?.(), true);
		assert.ok(tui.getScreenLines()[9].includes(bg));
		terminal.resize(40, 24);
		tui.renderNow();
		assert.equal(move?.hoverValid?.(), false);
		assert.ok(tui.getScreenLines().every((line) => !line.includes(bg)));
	});
	it("clears suggestion hover through real renderer motion into the editor body without moving focus", async (t) => {
		setPointerHoverBackground(() => bg);
		const { editor, terminal, tui } = await fixture(t);
		tui.addChild(editor);
		const other: Component = { render: () => [], invalidate() {}, handleInput() {} };
		tui.setFocus(other);
		tui.start();
		tui.renderNow();
		terminal.sendInput("\x1b[<35;4;5M");
		tui.renderNow();
		assert.ok(tui.getScreenLines()[4].includes(bg));
		assert.equal(tui.getFocusedComponent(), other);
		terminal.sendInput("\x1b[<35;4;2M");
		tui.renderNow();
		assert.ok(tui.getScreenLines().every((line) => !line.includes(bg)));
		await terminal.flush();
	});
});
