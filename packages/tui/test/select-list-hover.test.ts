import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import xterm from "@xterm/headless";
import { setPointerHoverBackground } from "../src/components/list-mouse.ts";
import { SelectList, type SelectListTheme } from "../src/components/select-list.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";

const bg = "\x1b[48;5;235m";
const theme: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => `\x1b[1m${text}\x1b[0m`,
	description: (text) => `\x1b[2m${text}\x1b[0m`,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};
function event(type: TuiMouseEvent["type"], y = 1, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: "none",
		x: 1,
		y,
		screenX: 1,
		screenY: y,
		width: 80,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}
function fixture(count = 4, maxVisible = 5) {
	const items = Array.from({ length: count }, (_, i) => ({
		value: `item-${i}`,
		label: `Item ${i}`,
		description: "Description",
	}));
	const list = new SelectList(items, maxVisible, theme);
	const changes: string[] = [];
	const activations: string[] = [];
	list.onSelectionChange = (item) => changes.push(item.value);
	list.onSelect = (item) => activations.push(item.value);
	list.render(80);
	return { list, items, changes, activations };
}
afterEach(() => setPointerHoverBackground(undefined));

describe("SelectList hover-only adoption", () => {
	it("handles row motion without color, selection, activation or focus changes", () => {
		const { list, changes, activations } = fixture();
		const before = list.render(80);
		const move = list.handleMouse(event("move"))!;
		assert.equal(move.handled, true);
		assert.equal(move.pointerShape, "pointer");
		assert.equal(move.hoverValid?.(), true);
		assert.equal(move.focus, undefined);
		assert.equal(list.handleMouse(event("move"))?.render, false);
		assert.deepEqual(list.render(80), before);
		assert.equal(list.getSelectedItem()?.value, "item-0");
		assert.deepEqual([changes, activations], [[], []]);
	});
	for (const width of [40, 80]) {
		it(`paints the whole nonselected row at width ${width}, suppressing selected rows and counters`, async () => {
			setPointerHoverBackground(() => bg);
			const { list } = fixture(8, 3);
			list.render(width);
			const move = list.handleMouse(event("move", 1, { width }))!;
			const lines = list.render(width);
			assert.ok(lines[1].includes(bg));
			assert.equal(visibleWidth(lines[1]), width);
			assert.ok(!lines[0].includes(bg));
			assert.ok(!lines[3].includes(bg));
			const terminal = new xterm.Terminal({ cols: width, rows: 5, allowProposedApi: true });
			try {
				await new Promise<void>((resolve) =>
					terminal.write(lines.map((line) => `${line}\x1b[0m`).join("\r\n"), resolve),
				);
				for (let x = 0; x < width; x++) {
					assert.equal(terminal.buffer.active.getLine(1)?.getCell(x)?.getBgColor(), 235);
					assert.ok(terminal.buffer.active.getLine(0)?.getCell(x)?.isBgDefault());
					assert.ok(terminal.buffer.active.getLine(3)?.getCell(x)?.isBgDefault());
				}
			} finally {
				terminal.dispose();
			}
			list.setSelectedIndex(1);
			assert.ok(list.render(width).every((line) => !line.includes(bg)));
			assert.equal(move.hoverValid?.(), true);
			list.setSelectedIndex(0);
			assert.ok(list.render(width)[1].includes(bg));
			assert.equal(list.handleMouse(event("move", 3, { width }))?.pointerShape, undefined);
			assert.equal(move.hoverValid?.(), false);
			assert.equal(list.handleMouse(event("move", 3, { width })), undefined);
		});
	}
	for (const count of [3, 9]) {
		for (const end of ["top", "bottom"] as const) {
			it(`clears on every handled wheel, including ${count <= 5 ? "fitting" : "clipped"} ${end} clamps`, () => {
				setPointerHoverBackground(() => bg);
				const { list } = fixture(count);
				list.setSelectedIndex(end === "top" ? 0 : count - 1);
				list.render(80);
				const move = list.handleMouse(event("move", end === "top" ? 1 : 0))!;
				assert.ok(list.render(80).some((line) => line.includes(bg)));
				assert.deepEqual(list.handleMouse(event("wheel", 1, { wheelDelta: end === "top" ? -1 : 1 })), {
					handled: true,
					render: true,
				});
				assert.equal(move.hoverValid?.(), false);
				assert.ok(list.render(80).every((line) => !line.includes(bg)));
			});
		}
	}
	it("retains legacy fitting-list and non-item wheel ownership, without routing clicks through ListMouse", () => {
		const { list, activations } = fixture();
		const move = list.handleMouse(event("move"))!;
		assert.equal(list.handleMouse(event("wheel", 8, { wheelDelta: 1 }))?.handled, true);
		assert.equal(list.getSelectedItem()?.value, "item-1");
		assert.equal(move.hoverValid?.(), false);
		list.handleMouse(event("click", 2, { button: "left", clickSource: "fallback" }));
		assert.deepEqual(activations, ["item-2"]);
	});
	it("does not revive hover when wheel selects its row then moves away without motion", () => {
		setPointerHoverBackground(() => bg);
		const { list } = fixture();
		const move = list.handleMouse(event("move"))!;
		list.handleMouse(event("wheel", 1, { wheelDelta: 1 }));
		list.render(80);
		list.handleMouse(event("wheel", 1, { wheelDelta: 1 }));
		assert.ok(list.render(80).every((line) => !line.includes(bg)));
		assert.equal(move.hoverValid?.(), false);
	});
	for (const provider of [false, true]) {
		for (const invalidation of ["empty filter", "zero width", "reorder", "scroll"] as const) {
			it(`validates ${invalidation} and restoration without motion (provider ${provider})`, () => {
				if (provider) setPointerHoverBackground(() => bg);
				const { list, items } = fixture(9, 3);
				const move = list.handleMouse(event("move"))!;
				if (invalidation === "empty filter") list.setFilter("missing");
				if (invalidation === "reorder") [items[0], items[1]] = [items[1], items[0]];
				if (invalidation === "scroll") list.setSelectedIndex(7);
				list.render(invalidation === "zero width" ? 0 : 80);
				assert.equal(move.hoverValid?.(), false);
				list.setFilter("");
				assert.ok(list.render(80).every((line) => !line.includes(bg)));
				assert.equal(move.hoverValid?.(), false);
			});
		}
	}
	it("keys and leave at arbitrary coordinates end the episode", () => {
		const { list } = fixture();
		for (const clear of [() => list.handleInput("x"), () => list.handleMouse(event("leave", -100))]) {
			const move = list.handleMouse(event("move"))!;
			clear();
			assert.equal(move.hoverValid?.(), false);
		}
	});
});
