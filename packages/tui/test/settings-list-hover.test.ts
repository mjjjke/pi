import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import xterm from "@xterm/headless";
import { setPointerHoverBackground } from "../src/components/list-mouse.ts";
import { SelectList, type SelectListTheme } from "../src/components/select-list.ts";
import { type SettingItem, SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";

const bg = "\x1b[48;5;235m";
const theme: SettingsListTheme = {
	label: (text, selected) => (selected ? `\x1b[1m${text}\x1b[0m` : text),
	value: (text) => text,
	description: (text) => text,
	cursor: "→ ",
	hint: (text) => text,
};
const selectTheme: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => text,
	description: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};
function event(type: TuiMouseEvent["type"], y = 3, extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: "none",
		x: 1,
		y,
		screenX: 1,
		screenY: y,
		width: 80,
		height: 12,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}
function fixture(count = 4, maxVisible = 5, search = true) {
	const items: SettingItem[] = Array.from({ length: count }, (_, i) => ({
		id: `item-${i}`,
		label: `Item ${i}`,
		description: "Description",
		currentValue: "off",
		values: ["off", "on"],
	}));
	const changes: string[] = [];
	const list = new SettingsList(
		items,
		maxVisible,
		theme,
		(id) => changes.push(id),
		() => {},
		{ enableSearch: search },
	);
	list.render(80);
	return { list, items, changes };
}
afterEach(() => setPointerHoverBackground(undefined));

describe("SettingsList hover-only adoption", () => {
	it("tracks without color and leaves selection, values and focus unchanged", () => {
		const { list, changes } = fixture();
		const before = list.render(80);
		const move = list.handleMouse(event("move"))!;
		assert.equal(move.handled, true);
		assert.equal(move.pointerShape, "pointer");
		assert.equal(move.focus, undefined);
		assert.equal(move.hoverValid?.(), true);
		assert.equal(list.handleMouse(event("move"))?.render, false);
		assert.deepEqual(list.render(80), before);
		assert.deepEqual(changes, []);
	});
	for (const width of [40, 80]) {
		it(`paints only item rows at width ${width}, leaving search, blanks, counter, description and hints inert`, async () => {
			setPointerHoverBackground(() => bg);
			const { list } = fixture(8, 3);
			list.render(width);
			const move = list.handleMouse(event("move", 3, { width }))!;
			const lines = list.render(width);
			assert.ok(lines[3].includes(bg));
			assert.equal(visibleWidth(lines[3]), width);
			assert.ok(lines.every((line, y) => y === 3 || !line.includes(bg)));
			const terminal = new xterm.Terminal({ cols: width, rows: 12, allowProposedApi: true });
			try {
				await new Promise<void>((resolve) =>
					terminal.write(lines.map((line) => `${line}\x1b[0m`).join("\r\n"), resolve),
				);
				for (let y = 0; y < lines.length; y++) {
					for (let x = 0; x < width; x++) {
						const cell = terminal.buffer.active.getLine(y)?.getCell(x);
						if (y === 3) assert.equal(cell?.getBgColor(), 235);
						else assert.ok(cell?.isBgDefault());
					}
				}
			} finally {
				terminal.dispose();
			}
			list.selectItem("item-1");
			assert.ok(list.render(width).every((line) => !line.includes(bg)));
			assert.equal(move.hoverValid?.(), true);
			list.selectItem("item-0");
			assert.ok(list.render(width)[3].includes(bg));
			for (const y of [0, 1, 5, 6, 7, 8, 9]) {
				list.handleMouse(event("move", 3, { width }));
				assert.equal(list.handleMouse(event("move", y, { width }))?.pointerShape, undefined);
				assert.ok(list.render(width).every((line) => !line.includes(bg)));
			}
		});
	}
	for (const y of [0, 1]) {
		it(`clears a row hover before forwarding/returning on search or blank row ${y}`, () => {
			const { list } = fixture();
			const move = list.handleMouse(event("move"))!;
			assert.deepEqual(list.handleMouse(event("move", y)), { handled: true, render: true });
			assert.equal(move.hoverValid?.(), false);
		});
	}
	for (const count of [3, 9]) {
		for (const end of ["top", "bottom"] as const) {
			it(`clears fitting/clipped wheel clamps (${count} items, ${end})`, () => {
				setPointerHoverBackground(() => bg);
				const { list } = fixture(count);
				list.selectItem(end === "top" ? "item-0" : `item-${count - 1}`);
				list.render(80);
				const move = list.handleMouse(event("move", end === "top" ? 3 : 2))!;
				assert.ok(list.render(80).some((line) => line.includes(bg)));
				assert.deepEqual(list.handleMouse(event("wheel", 3, { wheelDelta: end === "top" ? -1 : 1 })), {
					handled: true,
					render: true,
				});
				assert.equal(move.hoverValid?.(), false);
				assert.ok(list.render(80).every((line) => !line.includes(bg)));
			});
		}
	}
	it("retains search/blank wheel rejection, non-item wheel ownership and fallback clicks", () => {
		const { list, changes } = fixture();
		const move = list.handleMouse(event("move"))!;
		for (const y of [0, 1]) {
			assert.equal(list.handleMouse(event("wheel", y, { wheelDelta: 1 })), undefined);
			assert.equal(move.hoverValid?.(), true);
		}
		assert.equal(list.handleMouse(event("wheel", 10, { wheelDelta: 1 }))?.handled, true);
		assert.equal(move.hoverValid?.(), false);
		list.handleMouse(event("click", 4, { button: "left", clickSource: "fallback" }));
		assert.deepEqual(changes, ["item-2"]);
	});
	it("does not revive hover across wheel onto the selected row and away without motion", () => {
		setPointerHoverBackground(() => bg);
		const { list } = fixture();
		const move = list.handleMouse(event("move"))!;
		list.handleMouse(event("wheel", 3, { wheelDelta: 1 }));
		list.render(80);
		list.handleMouse(event("wheel", 3, { wheelDelta: 1 }));
		assert.ok(list.render(80).every((line) => !line.includes(bg)));
		assert.equal(move.hoverValid?.(), false);
	});
	for (const provider of [false, true]) {
		for (const invalidation of ["empty", "zero width", "reorder", "scroll"] as const) {
			it(`validates ${invalidation} before suppression (provider ${provider})`, () => {
				if (provider) setPointerHoverBackground(() => bg);
				const { list, items } = fixture(9, 3);
				const original = [...items];
				const move = list.handleMouse(event("move"))!;
				if (invalidation === "empty") items.splice(0);
				if (invalidation === "reorder") [items[0], items[1]] = [items[1], items[0]];
				if (invalidation === "scroll") list.selectItem("item-7");
				list.render(invalidation === "zero width" ? 0 : 80);
				assert.equal(move.hoverValid?.(), false);
				items.splice(0, items.length, ...original);
				list.selectItem("item-0");
				assert.ok(list.render(80).every((line) => !line.includes(bg)));
			});
		}
	}
	it("filters to empty and restores without reviving the episode", () => {
		setPointerHoverBackground(() => bg);
		const { list } = fixture();
		const move = list.handleMouse(event("move"))!;
		list.handleInput("zzzz");
		assert.ok(list.render(80).some((line) => line.includes("No matching")));
		list.handleInput("\x15");
		assert.ok(list.render(80).every((line) => !line.includes(bg)));
		assert.equal(move.hoverValid?.(), false);
	});
	it("clears main/submenu episodes on replacement and back, and forwards leave independent of y", () => {
		setPointerHoverBackground(() => bg);
		const { list, items } = fixture();
		let done: (() => void) | undefined;
		const child = new SelectList(
			[
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
			5,
			selectTheme,
		);
		items[0].submenu = (_value, close) => {
			done = close;
			return child;
		};
		const main = list.handleMouse(event("move"))!;
		list.handleMouse(event("click", 2, { button: "left" }));
		list.render(80);
		assert.equal(main.hoverValid?.(), false);
		const submenu = list.handleMouse(event("move", 1))!;
		assert.equal(submenu.pointerShape, "pointer");
		assert.ok(list.render(80)[1].includes(bg));
		list.handleMouse(event("leave", -100));
		assert.equal(submenu.hoverValid?.(), false);
		const next = list.handleMouse(event("move", 1))!;
		done!();
		assert.equal(next.hoverValid?.(), false);
		assert.ok(list.render(80).every((line) => !line.includes(bg)));
		list.handleMouse(event("click", 2, { button: "left" }));
		assert.ok(list.render(80).every((line) => !line.includes(bg)));
		assert.equal(next.hoverValid?.(), false);
	});
	it("keys and leave outside the item/search rectangle clear main hover", () => {
		const { list } = fixture();
		for (const clear of [() => list.handleInput("\x1b[B"), () => list.handleMouse(event("leave", -100))]) {
			const move = list.handleMouse(event("move"))!;
			clear();
			assert.equal(move.hoverValid?.(), false);
		}
	});
});
