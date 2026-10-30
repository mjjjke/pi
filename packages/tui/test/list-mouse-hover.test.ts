import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import {
	getPointerHoverBackground,
	ListMouse,
	type ListMouseOptions,
	setPointerHoverBackground,
} from "../src/index.ts";
import type { TuiMouseEvent } from "../src/tui.ts";

const bg = "\x1b[48;5;235m";
function event(type: TuiMouseEvent["type"], extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: "none",
		x: 1,
		y: 0,
		screenX: 1,
		screenY: 0,
		width: 10,
		height: 3,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}
function fixture(options: Partial<ListMouseOptions<string>> = {}) {
	const selected: string[] = [];
	const activated: string[] = [];
	const mouse = new ListMouse<string>({
		select: (key) => selected.push(key),
		activate: (key) => {
			activated.push(key);
			return true;
		},
		closeOnActivate: false,
		...options,
	});
	mouse.beginRows();
	mouse.addRow("A", 0, 2, [{ name: "fold", x: 3, width: 1 }]);
	mouse.addRow("B", 2);
	return { mouse, selected, activated };
}
afterEach(() => setPointerHoverBackground(undefined));

describe("ListMouse hover", () => {
	it("tracks without a provider, never selects or activates, and renders only target changes", () => {
		const { mouse, selected, activated } = fixture();
		assert.equal(getPointerHoverBackground(), undefined);
		const first = mouse.handle(event("move"))!;
		assert.equal(first.handled, true);
		assert.equal(first.render, true);
		assert.equal(first.hoverValid?.(), true);
		assert.equal(first.focus, undefined);
		assert.equal(mouse.handle(event("move", { x: 2, y: 1 }))?.render, false);
		assert.equal(mouse.handle(event("move", { x: 3 }))?.render, true);
		assert.equal(first.hoverValid?.(), false);
		assert.deepEqual([selected, activated], [[], []]);
		assert.deepEqual(mouse.handle(event("move", { y: 3 })), { handled: true, render: true });
		assert.equal(mouse.handle(event("move", { y: 3 })), undefined);
		assert.deepEqual(mouse.handle(event("leave")), { handled: true, render: false });
	});
	it("ends episodes irreversibly on leave, explicit clear, owned wheel, disable and close", () => {
		let enabled = true;
		let owned = true;
		const { mouse } = fixture({ enabled: () => enabled, ownsWheel: () => owned, step: () => false });
		const first = mouse.handle(event("move"))!;
		owned = false;
		assert.equal(mouse.handle(event("wheel", { wheelDelta: 1 })), undefined);
		assert.equal(first.hoverValid?.(), true);
		owned = true;
		assert.deepEqual(mouse.handle(event("wheel", { wheelDelta: 1 })), { handled: true, render: true });
		assert.equal(first.hoverValid?.(), false);
		for (const clear of [
			() => mouse.clearHover(),
			() => mouse.handle(event("leave")),
			() => {
				enabled = false;
				mouse.handle(event("move"));
				enabled = true;
			},
			() => {
				enabled = false;
				mouse.paintHover(["a"], 10);
				enabled = true;
			},
			() => mouse.close(),
		]) {
			const move = mouse.handle(event("move"))!;
			assert.equal(move.hoverValid?.(), true);
			clear();
			assert.equal(move.hoverValid?.(), false);
			assert.equal(first.hoverValid?.(), false);
		}
		assert.equal(mouse.handle(event("move")), undefined);
		assert.equal(mouse.clearHover(), false);
	});
	it("press and nonterminal click keep hover, selected rows suppress paint but zones still paint", () => {
		setPointerHoverBackground(() => bg);
		let selected = false;
		const { mouse } = fixture({ isSelected: () => selected });
		const move = mouse.handle(event("move"))!;
		assert.ok(mouse.paintHover(["a", "b", "c"], 10)[1].includes(bg));
		mouse.handle(event("press", { button: "left" }));
		mouse.handle(event("click", { button: "left", clickSource: "captured" }));
		assert.equal(move.hoverValid?.(), true);
		selected = true;
		assert.deepEqual(mouse.paintHover(["a", "b", "c"], 10), ["a", "b", "c"]);
		assert.equal(move.hoverValid?.(), true);
		mouse.handle(event("move", { x: 3 }));
		const painted = mouse.paintHover(["abcd", "efgh", "ijk"], 10);
		assert.ok(painted[0].includes(bg));
		assert.equal(painted[2], "ijk");
	});
	for (const mode of ["manual", "region"] as const) {
		for (const type of ["press", "drag", "release"] as const) {
			it(`${mode} ${type} ends hover only on a different row/zone or inert cell`, () => {
				setPointerHoverBackground(() => bg);
				for (const target of [{ x: 2 }, { x: 3 }, { y: 2 }, { y: 3 }, { x: -1 }]) {
					const { mouse } = fixture();
					const row = mouse.row("A", new Text("row", 0, 0), [{ name: "fold", x: 3, width: 1 }]);
					const other = mouse.row("B", new Text("other", 0, 0));
					mouse.commitRows();
					const dispatch = (input: TuiMouseEvent) =>
						mode === "manual"
							? mouse.handle(input)
							: input.y === 2
								? other.handleMouse({ ...input, y: 0, height: 1 })
								: row.handleMouse({ ...input, height: 1 });
					const move = dispatch(event("move"))!;
					const result = dispatch(event(type, { button: "left", ...target }));
					if (type !== "press" || target.y === 3 || target.x === -1) assert.equal(result, undefined);
					else assert.deepEqual(result, { handled: true, focus: true });
					const same = target.x === 2;
					assert.equal(move.hoverValid?.(), same);
					const painted = mode === "manual" ? mouse.paintHover(["row", "row", "other"], 10) : row.render(10);
					assert.equal(painted[0].includes(bg), same);
					dispatch(event(type, { button: "left" }));
					assert.equal(move.hoverValid?.(), same, "non-moves cannot recreate an episode");
				}
			});
		}
	}
	it("ends zone hover without changing press-time key, zone or gesture routing", () => {
		const zones: string[] = [];
		const { mouse, activated } = fixture({ zoneClick: (key, zone) => zones.push(`${key}:${zone}`) });
		const move = mouse.handle(event("move", { x: 3 }))!;
		mouse.handle(event("press", { button: "left", x: 3, gestureId: 7 }));
		assert.equal(move.hoverValid?.(), true);
		mouse.handle(event("release", { button: "left", x: 1, gestureId: 7 }));
		assert.equal(move.hoverValid?.(), false);
		mouse.handle(event("click", { button: "left", x: 1, gestureId: 7, clickSource: "captured" }));
		assert.deepEqual(zones, ["A:fold"]);
		assert.deepEqual(activated, []);
	});
	it("validates every render before provider/selection suppression, including empty and zero-width renders", () => {
		for (const suppressed of [false, true]) {
			const { mouse } = fixture({ isSelected: () => suppressed });
			for (const invalidate of [
				() => {
					mouse.beginRows();
					mouse.addRow("B", 0);
				},
				() => {
					mouse.beginRows();
				},
				() => {
					mouse.beginRows();
					mouse.addRow("A", 1);
				},
				() => {
					mouse.beginRows();
					mouse.addRow("A", 0, 2, [{ name: "fold", x: 1, width: 1 }]);
				},
			]) {
				mouse.beginRows();
				mouse.addRow("A", 0, 2);
				const move = mouse.handle(event("move"))!;
				invalidate();
				assert.deepEqual(mouse.paintHover(["a", "b"], 10), ["a", "b"]);
				assert.equal(move.hoverValid?.(), false);
			}
			for (const [lines, width] of [
				[[], 10],
				[["a"], 0],
			] as const) {
				mouse.beginRows();
				mouse.addRow("A", 0);
				const move = mouse.handle(event("move"))!;
				mouse.paintHover([...lines], width);
				assert.equal(move.hoverValid?.(), false);
				mouse.paintHover(["a"], 10);
				assert.equal(move.hoverValid?.(), false);
			}
		}
	});
	it("paints only supplied visible lines, without extending clipped rows", () => {
		setPointerHoverBackground(() => bg);
		const { mouse } = fixture();
		mouse.handle(event("move"));
		assert.equal(mouse.paintHover(["a"], 10).length, 1);
		assert.ok(mouse.paintHover(["a"], 10)[0].includes(bg));
	});
	it("caches regions by key, updates children and zones, and guards stale leaves", () => {
		setPointerHoverBackground(() => bg);
		const { mouse } = fixture();
		const row = mouse.row("A", new Text("old", 0, 0));
		const other = mouse.row("B", new Text("B", 0, 0));
		mouse.commitRows();
		row.render(10);
		const first = row.handleMouse(event("move", { height: 1 }))!;
		assert.equal(mouse.row("A", new Text("new", 0, 0)), row);
		assert.ok(row.render(10)[0].includes("new"));
		assert.equal(first.hoverValid?.(), true);
		other.render(10);
		const next = other.handleMouse(event("move", { height: 1 }))!;
		row.handleMouse(event("leave"));
		assert.equal(next.hoverValid?.(), true);
		assert.ok(other.render(10)[0].includes(bg));
		mouse.row("B", new Text("B", 0, 0), [{ name: "new-zone", x: 1, width: 1 }]);
		other.render(10);
		assert.equal(next.hoverValid?.(), false);
	});
	it("invalidates region episodes on empty/zero-width output before selected/provider checks", () => {
		for (const selected of [false, true]) {
			const { mouse } = fixture({ isSelected: () => selected });
			for (const empty of [false, true]) {
				const row = mouse.row("A", new Text("A", 0, 0));
				mouse.commitRows();
				row.render(10);
				const move = row.handleMouse(event("move", { height: 1 }))!;
				if (empty) mouse.row("A", { render: () => [], invalidate() {} });
				row.render(empty ? 10 : 0);
				assert.equal(move.hoverValid?.(), false);
				mouse.row("A", new Text("A", 0, 0));
				row.render(10);
				assert.equal(move.hoverValid?.(), false);
			}
		}
	});
	it("revalidates moved named zones even when the row rectangle stays unchanged", () => {
		setPointerHoverBackground(() => bg);
		const { mouse } = fixture();
		const row = mouse.row("A", new Text("A", 0, 0), [{ name: "fold", x: 1, width: 1 }]);
		mouse.commitRows();
		row.render(10);
		const move = row.handleMouse(event("move", { height: 1 }))!;
		mouse.row("A", new Text("A", 0, 0), [{ name: "fold", x: 3, width: 1 }]);
		mouse.commitRows();
		assert.ok(!row.render(10)[0].includes(bg));
		assert.equal(move.hoverValid?.(), false);
	});
	it("prunes completed builds, not repeated measurements or stale pressed keys", () => {
		const { mouse, activated } = fixture();
		const held = mouse.row("A", new Text("A", 0, 0));
		mouse.commitRows();
		held.render(10);
		held.handleMouse(event("press", { button: "left", height: 1, gestureId: 1 }));
		for (let i = 0; i < 50; i++) {
			const row = mouse.row(`key${i}`, new Text("x", 0, 0));
			mouse.commitRows();
			row.render(10);
			row.render(20);
		}
		assert.notEqual(mouse.row("A", new Text("A", 0, 0)), held);
		mouse.commitRows();
		// Renderer capture retains the removed object independently of cache membership.
		held.handleMouse(event("click", { button: "left", height: 1, gestureId: 1, clickSource: "captured" }));
		assert.deepEqual(activated, ["A"]);
		const old = mouse.row("Z", new Text("z", 0, 0));
		mouse.commitRows();
		const move = old.handleMouse(event("move", { height: 1 }))!;
		mouse.commitRows();
		assert.equal(move.hoverValid?.(), false);
		assert.notEqual(mouse.row("Z", new Text("z", 0, 0)), old);
	});
});
