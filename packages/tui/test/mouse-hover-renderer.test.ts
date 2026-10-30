import assert from "node:assert/strict";
import { afterEach, describe, it, type TestContext } from "node:test";
import { ListMouse, setPointerHoverBackground } from "../src/index.ts";
import { type Component, Container, type TuiMouseEvent, type TuiMouseEventResult } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class HoverList implements Component {
	keys = ["A", "B"];
	events: string[] = [];
	selected = "";
	onPress?: () => void;
	onRelease?: () => void;
	lastMove?: TuiMouseEventResult;
	mouse = new ListMouse<string>({
		select: (key) => {
			this.selected = key;
			this.onPress?.();
		},
		activate: () => true,
		closeOnActivate: false,
	});
	render(width: number): string[] {
		this.mouse.beginRows();
		for (const [y, key] of this.keys.entries()) this.mouse.addRow(key, y);
		return this.mouse.paintHover(this.keys, width);
	}
	invalidate(): void {}
	handleInput(): void {}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		this.events.push(event.type);
		if (event.type === "release") this.onRelease?.();
		const result = this.mouse.handle(event);
		if (event.type === "move") this.lastMove = result;
		return result;
	}
}
function renderer(t: TestContext, list: Component) {
	const terminal = new VirtualTerminal(20, 6);
	const tui = new TuiAltScreen(terminal);
	tui.addChild(list);
	tui.setFocus(list);
	tui.start();
	tui.renderNow();
	t.after(() => tui.stop());
	return { tui, terminal, send: (data: string) => terminal.sendInput(data) };
}
const move = "\x1b[<35;2;1M";
const press = "\x1b[<0;2;1M";
const release = "\x1b[<0;2;1m";
afterEach(() => setPointerHoverBackground(undefined));

describe("fullscreen hover ownership", () => {
	it("ignores move focus/capture from a forwarder, including capture on an unhandled press", (t) => {
		const child: Component = {
			render: () => ["child"],
			invalidate() {},
			handleMouse: (event) => (event.type === "move" ? { handled: true, focus: true, capture: true } : undefined),
		};
		class Forwarder extends Container {
			handleInput(): void {}
		}
		const host = new Forwarder();
		host.addChild(child);
		const { tui, send } = renderer(t, host);
		const focus: Component = { render: () => [], invalidate() {}, handleInput() {} };
		tui.setFocus(focus);
		send(move);
		assert.equal(tui.getFocusedComponent(), focus);
		const seen: string[] = [];
		child.handleMouse = (event) => {
			seen.push(event.type);
			return undefined;
		};
		send("\x1b[<0;2;4M");
		send("\x1b[<0;2;4m");
		assert.deepEqual(seen, ["leave"]);
	});
	for (const input of ["render", "move", "press", "wheel", "round-trip"] as const) {
		it(`clears async focus displacement before ${input}, without hiding the epoch mismatch`, (t) => {
			const list = new HoverList();
			const { tui, send } = renderer(t, list);
			send(move);
			const old = list.lastMove!;
			tui.setFocus({ render: () => [], invalidate() {} });
			if (input === "round-trip") tui.setFocus(list);
			if (input === "move") send(move);
			else if (input === "press") send(press);
			else if (input === "wheel") send("\x1b[<65;2;1M");
			else tui.renderNow();
			assert.equal(old.hoverValid?.(), false);
			assert.equal(list.events.filter((e) => e === "leave").length, 1);
			if (input === "move") {
				assert.deepEqual(list.events.slice(-2), ["leave", "move"]);
				assert.equal(list.lastMove?.hoverValid?.(), true);
			}
		});
	}
	it("keeps the same live hover through its own press focus request, not release displacement", (t) => {
		const list = new HoverList();
		const { tui, send } = renderer(t, list);
		const other: Component = { render: () => [], invalidate() {} };
		tui.setFocus(other);
		send(move);
		const old = list.lastMove!;
		send(press);
		tui.renderNow();
		assert.equal(tui.getFocusedComponent(), list);
		assert.equal(old.hoverValid?.(), true);
		list.onRelease = () => tui.setFocus(other);
		send(release);
		assert.equal(old.hoverValid?.(), false);
		assert.equal(list.events.filter((e) => e === "leave").length, 1);
	});
	for (const action of ["key", "viewport key", "focus-out", "unmount", "reorder", "empty", "overlay"] as const) {
		it(`clears painted hover on ${action} and never revives it on a later render`, async (t) => {
			setPointerHoverBackground(() => "\x1b[48;5;235m");
			const list = new HoverList();
			const { tui, terminal, send } = renderer(t, list);
			send(move);
			tui.renderNow();
			const old = list.lastMove!;
			assert.ok(tui.getScreenLines()[0].includes("48;5;235"));
			if (action === "key") send("x");
			else if (action === "viewport key") send("\x1b[5~");
			else if (action === "focus-out") send("\x1b[O");
			else if (action === "unmount") tui.clear();
			else if (action === "reorder") list.keys = ["B", "A"];
			else if (action === "empty") list.keys = [];
			else
				tui.showOverlay(
					{ render: () => ["cover"], invalidate() {} },
					{ row: 0, col: 0, width: 10, nonCapturing: true },
				);
			tui.renderNow();
			await terminal.flush();
			assert.equal(old.hoverValid?.(), false);
			assert.ok(tui.getScreenLines().every((line) => !line.includes("48;5;235")));
			list.keys = ["A", "B"];
			tui.renderNow();
			assert.equal(old.hoverValid?.(), false);
		});
	}
	it("replaces an episode inside the same manual target without leaving the new row", (t) => {
		const list = new HoverList();
		const { tui, send } = renderer(t, list);
		send(move);
		const first = list.lastMove!;
		send("\x1b[<35;2;2M");
		const second = list.lastMove!;
		assert.equal(first.hoverValid?.(), false);
		assert.equal(second.hoverValid?.(), true);
		tui.renderNow();
		assert.equal(second.hoverValid?.(), true);
		assert.deepEqual(list.events, ["move", "move"]);
	});
	it("delivers a new region move before the stale region leave without clearing the new episode", (t) => {
		const mouse = new ListMouse<string>({ select() {}, activate: () => true });
		const host = new Container();
		const events: string[] = [];
		for (const key of ["A", "B"]) {
			const row = mouse.row(key, { render: () => [key], invalidate() {} });
			const handle = row.handleMouse.bind(row);
			row.handleMouse = (event) => {
				events.push(`${key}:${event.type}`);
				return handle(event);
			};
			host.addChild(row);
		}
		mouse.commitRows();
		const { tui, send } = renderer(t, host);
		send(move);
		send("\x1b[<35;2;2M");
		tui.renderNow();
		assert.deepEqual(events, ["A:move", "B:move", "A:leave"]);
		assert.equal(mouse.clearHover(), true);
	});
	it("does not retain a cancelled gesture's region in the completed-build cache", (t) => {
		let activated = 0;
		const mouse = new ListMouse<string>({
			select() {},
			activate: () => {
				activated++;
				return true;
			},
		});
		class Host extends Container {
			handleInput(): void {}
		}
		const host = new Host();
		const child: Component = { render: () => ["A"], invalidate() {} };
		const old = mouse.row("A", child);
		mouse.commitRows();
		host.addChild(old);
		const { tui, send } = renderer(t, host);
		send(press);
		send("x");
		host.clear();
		mouse.commitRows();
		const next = mouse.row("A", child);
		mouse.commitRows();
		host.addChild(next);
		tui.renderNow();
		send(release);
		assert.notEqual(next, old);
		assert.equal(activated, 0);
		send(press);
		send(release);
		assert.equal(activated, 1);
	});
	it("keeps stable region hover across rebuilds, but clears reordered regions", (t) => {
		const mouse = new ListMouse<string>({ select() {}, activate: () => true });
		const host = new Container();
		function build(keys: string[]) {
			host.clear();
			for (const key of keys) host.addChild(mouse.row(key, { render: () => [key], invalidate() {} }));
			mouse.commitRows();
		}
		build(["A", "B"]);
		const row = host.children[0];
		const { tui, send } = renderer(t, host);
		send(move);
		build(["A", "B"]);
		tui.renderNow();
		assert.equal(host.children[0], row);
		assert.equal(mouse.clearHover(), true);
		send(move);
		build(["B", "A"]);
		tui.renderNow();
		assert.equal(mouse.clearHover(), false);
	});
});
