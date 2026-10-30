import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, type TestContext } from "node:test";
import { ListMouse, setPointerHoverBackground } from "../src/components/list-mouse.ts";
import {
	getCapabilities,
	linkTo,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
} from "../src/terminal-image.ts";
import {
	type Component,
	Container,
	dispatchMouseEvent,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../src/tui.ts";
import { TuiAltScreen, type TuiAltScreenOptions } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const pointer = "\x1b]22;pointer\x1b\\";
const arrow = "\x1b]22;default\x1b\\";
const envKeys = ["TMUX", "STY", "ZELLIJ", "TERM", "PI_POINTER_SHAPE"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
	saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
	for (const key of envKeys) delete process.env[key];
	setCapabilities({ images: null, trueColor: true, hyperlinks: true, pointerShapes: true });
});
afterEach(() => {
	for (const key of envKeys) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	setPointerHoverBackground(undefined);
	setCapabilityOverrides({});
	resetCapabilitiesCache();
});

class RecordingTerminal extends VirtualTerminal {
	writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
	shapes(): string[] {
		return this.writes.join("").match(/\x1b\]22;(?:pointer|default)\x1b\\/g) ?? [];
	}
}
class HoverList implements Component {
	keys = ["A", "B"];
	onClick?: () => void;
	mouse = new ListMouse<string>({
		select() {},
		activate: () => {
			this.onClick?.();
			return true;
		},
		step: () => false,
	});
	render(width: number): string[] {
		this.mouse.beginRows();
		for (const [y, key] of this.keys.entries()) this.mouse.addRow(key, y);
		return this.mouse.paintHover(this.keys, width);
	}
	invalidate(): void {}
	handleInput(): void {}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.mouse.handle(event);
	}
}
function setup(t: TestContext, component: Component = new HoverList(), options: TuiAltScreenOptions = {}) {
	const terminal = new RecordingTerminal(80, 10);
	const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false, ...options });
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	tui.renderNow();
	t.after(() => tui.stop());
	return { tui, terminal, send: (data: string) => terminal.sendInput(data) };
}
const move = (x = 2, y = 1, ctrl = false) => `\x1b[<${ctrl ? 51 : 35};${x};${y}M`;
const press = "\x1b[<0;2;1M";
const release = "\x1b[<0;2;1m";
const inert: Component = { render: () => ["cover"], invalidate() {} };

describe("renderer-owned pointer shape", () => {
	it("emits only transitions and preserves pointer metadata through forwarders", (t) => {
		const list = new HoverList();
		const forwarder = new Container();
		forwarder.addChild(list);
		const { terminal, send, tui } = setup(t, forwarder);
		assert.deepEqual(terminal.shapes(), []);
		send(move());
		send(move());
		tui.renderNow();
		assert.deepEqual(terminal.shapes(), [pointer]);
		send(move(60, 9));
		send(move(60, 9));
		assert.deepEqual(terminal.shapes(), [pointer, arrow]);
	});
	for (const clear of ["key", "focus-out", "refresh", "wheel", "click", "overlay", "focus-round-trip"] as const) {
		it(`drops an ended episode after ${clear}, without restoring on render`, (t) => {
			const list = new HoverList();
			const { terminal, send, tui } = setup(t, list);
			send(move());
			assert.deepEqual(terminal.shapes(), [pointer]);
			if (clear === "key") send("x");
			else if (clear === "focus-out") send("\x1b[O");
			else if (clear === "refresh") list.keys = ["B", "A"];
			else if (clear === "wheel") send("\x1b[<65;2;1M");
			else if (clear === "click") {
				send(press);
				send(release);
			} else if (clear === "overlay") tui.showOverlay(inert, { row: 0, col: 0, width: 20, nonCapturing: true });
			else {
				tui.setFocus(inert);
				tui.setFocus(list);
				send("\x1b[<65;2;1M");
			}
			if (
				clear === "wheel" ||
				clear === "click" ||
				clear === "key" ||
				clear === "focus-out" ||
				clear === "focus-round-trip"
			)
				assert.deepEqual(terminal.shapes(), [pointer, arrow], "sync before dispatch returns");
			tui.renderNow();
			list.keys = ["A", "B"];
			tui.renderNow();
			assert.deepEqual(terminal.shapes(), [pointer, arrow]);
		});
	}
	it("syncs the unhandled wheel exit after its dispatch invalidates hover", (t) => {
		let valid = true;
		const component: Component = {
			render: () => ["row"],
			invalidate() {},
			handleMouse: (event) => {
				if (event.type === "move") return { handled: true, pointerShape: "pointer", hoverValid: () => valid };
				if (event.type === "wheel") valid = false;
				return undefined;
			},
		};
		const { terminal, send } = setup(t, component);
		send(move());
		send("\x1b[<65;2;1M");
		assert.deepEqual(terminal.shapes(), [pointer, arrow]);
	});
	it("preserves its own press focus, but not a release opening a dialog", (t) => {
		const list = new HoverList();
		const { terminal, send, tui } = setup(t, list);
		tui.setFocus(inert);
		send(move());
		send(press);
		tui.renderNow();
		assert.deepEqual(terminal.shapes(), [pointer]);
		list.onClick = () => tui.showOverlay(inert, { row: 5, col: 0, width: 20 });
		send(release);
		assert.deepEqual(terminal.shapes(), [pointer, arrow]);
	});
	for (const preserveScreen of [false, true]) {
		it(`resets before disabling mouse, then forgets state on restart (preserveScreen=${preserveScreen})`, (t) => {
			const { terminal, send, tui } = setup(t);
			send(move());
			tui.stop({ preserveScreen });
			const bytes = terminal.writes.join("");
			assert.ok(bytes.indexOf(arrow) < bytes.indexOf("\x1b[?1003l"));
			assert.deepEqual(terminal.shapes(), [pointer, arrow]);
			tui.start();
			tui.renderNow();
			assert.deepEqual(terminal.shapes(), [pointer, arrow]);
			send(move());
			assert.deepEqual(terminal.shapes(), [pointer, arrow, pointer]);
		});
	}
	it("ends manual row hover on drag into an inert line without activating", async (t) => {
		const bg = "\x1b[48;5;235m";
		setPointerHoverBackground(() => bg);
		let clicks = 0;
		const mouse = new ListMouse<string>({
			select() {},
			activate: () => {
				clicks++;
				return true;
			},
		});
		const component: Component = {
			render(width) {
				mouse.beginRows();
				mouse.addRow("row", 0);
				return mouse.paintHover(["row", "inert"], width);
			},
			invalidate() {},
			handleMouse: (event) => mouse.handle(event),
		};
		const { terminal, send, tui } = setup(t, component);
		send(move());
		tui.renderNow();
		assert.ok(tui.getScreenLines()[0].includes(bg));
		send(press);
		send("\x1b[<32;2;2M");
		assert.deepEqual(terminal.shapes(), [pointer, arrow]);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(!tui.getScreenLines()[0].includes(bg), "unhandled drag still schedules hover repaint");
		send("\x1b[<0;2;2m");
		tui.renderNow();
		assert.ok(!tui.getScreenLines()[0].includes(bg));
		assert.equal(clicks, 0);
	});
	it("samples pointer capability overrides only at start", (t) => {
		const { terminal, send, tui } = setup(t);
		setCapabilityOverrides({ pointerShapes: false });
		assert.equal(getCapabilities().pointerShapes, false);
		send(move());
		assert.deepEqual(terminal.shapes(), [pointer]);
		tui.stop();
		tui.start();
		tui.renderNow();
		send(move());
		assert.deepEqual(terminal.shapes(), [pointer, arrow]);
		setCapabilityOverrides({ pointerShapes: true });
		send(move());
		assert.deepEqual(terminal.shapes(), [pointer, arrow]);
		tui.stop();
		tui.start();
		tui.renderNow();
		send(move());
		assert.deepEqual(terminal.shapes(), [pointer, arrow, pointer]);
	});
	for (const type of ["move", "wheel"] as const) {
		it(`discards ${type} results from a synchronous stop/start without reusing gesture IDs`, (t) => {
			let restart = true;
			const ids: number[] = [];
			const component: Component = {
				render: () => ["row"],
				invalidate() {},
				handleMouse(event) {
					if (event.type === "press") ids.push(event.gestureId!);
					if (event.type === type && restart) {
						restart = false;
						tui.stop();
						tui.start();
					}
					return { handled: true, pointerShape: "pointer" };
				},
			};
			const { terminal, send, tui } = setup(t, component);
			send(press);
			send(release);
			send(type === "move" ? move() : "\x1b[<65;2;1M");
			assert.deepEqual(terminal.shapes(), [], "old dispatch cannot record a hand in the new lifecycle");
			tui.renderNow();
			assert.deepEqual(terminal.shapes(), []);
			send(press);
			send(release);
			assert.ok(ids[1] > ids[0]);
			send(move());
			assert.deepEqual(terminal.shapes(), [pointer]);
		});
	}
	it("never emits a default when no hand was sent", (t) => {
		const { terminal, send, tui } = setup(t, inert);
		send(move());
		send("x");
		send("\x1b[O");
		tui.stop();
		assert.deepEqual(terminal.shapes(), []);
	});
	for (const gate of [
		"absent",
		"off",
		"mouse-disabled",
		"TMUX",
		"STY",
		"ZELLIJ",
		"tmux-256color",
		"screen-256color",
	]) {
		it(`emits nothing with ${gate}, even with an explicit capability override`, (t) => {
			if (gate === "absent") setCapabilities({ images: null, trueColor: true, hyperlinks: true });
			else if (gate === "off") process.env.PI_POINTER_SHAPE = "0";
			else if (gate !== "mouse-disabled") {
				process.env.PI_POINTER_SHAPE = "1";
				if (gate.includes("color")) process.env.TERM = gate;
				else process.env[gate] = "";
			}
			const { terminal, send, tui } = setup(t, new HoverList(), { mouse: gate !== "mouse-disabled" });
			send(move());
			send("x");
			tui.stop();
			assert.deepEqual(terminal.shapes(), []);
		});
	}
});

for (const modifier of ["ctrl", "none"] as const) {
	it(`links use last-reported modifiers and win authorized clicks: ${modifier}`, (t) => {
		let clicked = 0;
		const opened: string[] = [];
		const child: Component = {
			render: () => [linkTo("link", "https://example.com", { id: "target" })],
			invalidate() {},
			handleMouse: (event) => {
				if (event.type === "press" || event.type === "click") {
					clicked++;
					return { handled: true };
				}
				return undefined;
			},
		};
		const { terminal, send, tui } = setup(t, child, {
			linkOpenModifier: modifier,
			openUrl: (url) => opened.push(url),
		});
		send(move());
		assert.deepEqual(terminal.shapes(), modifier === "none" ? [pointer] : []);
		send(move(2, 1, true));
		tui.renderNow();
		assert.equal(terminal.shapes().at(-1), pointer);
		send("\x1b[<16;2;1M");
		send("\x1b[<16;2;1m");
		assert.deepEqual(opened, ["https://example.com"]);
		assert.equal(clicked, 0);
	});
}
for (const change of ["disappear", "cover", "recursive-repaint"] as const) {
	it(`validates the final link frame before pointer sync: ${change}`, (t) => {
		let text = linkTo("link", "https://example.com", { id: "target" });
		const component: Component = {
			render: () => [text],
			invalidate() {},
			handleMouse: (event) => {
				if (event.type === "move" && change === "recursive-repaint") return { handled: true };
				if (event.type === "leave") {
					text = "gone";
					return { handled: true, render: true };
				}
				return undefined;
			},
		};
		const { terminal, send, tui } = setup(t, component);
		send(move(2, 1, true));
		if (change === "disappear") text = "gone";
		else if (change === "cover") tui.showOverlay(inert, { row: 0, col: 0, width: 20, nonCapturing: true });
		else tui.setFocus(inert);
		tui.renderNow();
		assert.deepEqual(terminal.shapes(), [pointer, arrow]);
		tui.renderNow();
		assert.deepEqual(terminal.shapes(), [pointer, arrow]);
	});
}

function findControl(tui: TuiAltScreen, label: string): [number, number] {
	const lines = tui.getScreenLines().map(stripTerminalSequences);
	const row = lines.findIndex((line) => line.includes(label));
	assert.ok(row >= 0, `missing ${label}`);
	return [lines[row].indexOf(label) + 1, row + 1];
}
for (const kind of ["search", "jump"] as const) {
	for (const change of [
		"key",
		"focus-out",
		"cover",
		"disappear",
		"resize",
		"press-elsewhere",
		"wheel-elsewhere",
		"teardown",
	] as const) {
		it(`validates move-only ${kind} hover after ${change}`, (t) => {
			let label = "jump";
			const content: Component = {
				render: () => Array.from({ length: 30 }, (_, i) => `line ${i}`),
				invalidate() {},
			};
			const { terminal, send, tui } = setup(t, content, { scrollToEndIndicator: () => label });
			if (kind === "search") send("\x1b[102;6u");
			else tui.scrollToTop();
			tui.renderNow();
			const [x, y] = findControl(tui, kind === "search" ? "↑" : "jump");
			send(move(x, y));
			tui.renderNow();
			assert.deepEqual(terminal.shapes(), [pointer]);
			if (change === "key") send(kind === "search" ? "x" : "\x1b[5~");
			else if (change === "focus-out") send("\x1b[O");
			else if (change === "cover") tui.showOverlay(inert, { row: y - 1, col: x - 1, width: 10, nonCapturing: true });
			else if (change === "resize") terminal.resize(60, 8);
			else if (change === "press-elsewhere") send("\x1b[<0;1;5M");
			else if (change === "wheel-elsewhere") send("\x1b[<65;1;5M");
			else if (change === "teardown") {
				tui.stop({ preserveScreen: true });
				tui.start();
			} else if (kind === "search") send("\x1b[102;6u");
			else label = "";
			tui.renderNow();
			assert.deepEqual(terminal.shapes(), [pointer, arrow]);
			if (kind === "jump") label = "jump";
			tui.renderNow();
			assert.deepEqual(terminal.shapes(), [pointer, arrow], "geometry cannot recreate hover");
		});
	}
}

it("jump-to-end is inactive even when an overlay is elsewhere", (t) => {
	const content: Component = { render: () => Array.from({ length: 30 }, (_, i) => `line ${i}`), invalidate() {} };
	const { terminal, send, tui } = setup(t, content, { scrollToEndIndicator: () => "jump" });
	tui.scrollToTop();
	tui.renderNow();
	const [x, y] = findControl(tui, "jump");
	send(move(x, y));
	const overlay = tui.showOverlay(inert, { row: 0, col: 0, width: 10, nonCapturing: true });
	tui.renderNow();
	assert.deepEqual(terminal.shapes(), [pointer, arrow]);
	const before = tui.viewportTop;
	send(`\x1b[<0;${x};${y}M`);
	send(`\x1b[<0;${x};${y}m`);
	assert.equal(tui.viewportTop, before);
	overlay.hide();
	tui.renderNow();
	assert.deepEqual(terminal.shapes(), [pointer, arrow]);
});

for (const kind of ["search", "jump"] as const) {
	it(`a click on ${kind} cannot recreate hover after a key`, (t) => {
		const content: Component = { render: () => Array.from({ length: 30 }, (_, i) => `line ${i}`), invalidate() {} };
		const { terminal, send, tui } = setup(t, content, { scrollToEndIndicator: () => "jump" });
		if (kind === "search") send("\x1b[102;6u");
		else tui.scrollToTop();
		tui.renderNow();
		const [x, y] = findControl(tui, kind === "search" ? "↑" : "jump");
		send(move(x, y));
		send("x");
		tui.renderNow();
		send(`\x1b[<0;${x};${y}M`);
		send(`\x1b[<0;${x};${y}m`);
		tui.renderNow();
		assert.deepEqual(terminal.shapes(), [pointer, arrow]);
	});
}

for (const modifier of ["ctrl", "none"] as const) {
	it(`clickable rows keep the hand without authorizing a link; authorized links bypass rows: ${modifier}`, (t) => {
		let activated = 0;
		const mouse = new ListMouse<string>({
			select() {},
			activate: () => {
				activated++;
				return true;
			},
			isSelected: () => true,
		});
		const host = new Container();
		host.addChild(mouse.row("row", { render: () => [linkTo("link", "https://example.com")], invalidate() {} }));
		mouse.commitRows();
		const opened: string[] = [];
		const { terminal, send, tui } = setup(t, host, {
			linkOpenModifier: modifier,
			openUrl: (url) => opened.push(url),
		});
		send(move());
		tui.renderNow();
		assert.deepEqual(terminal.shapes(), [pointer], "selected row remains actionable without a paint provider");
		const code = modifier === "ctrl" ? 16 : 0;
		send(`\x1b[<${code};2;1M`);
		send(`\x1b[<${code};2;1m`);
		assert.deepEqual(opened, ["https://example.com"]);
		assert.equal(activated, 0);
	});
}

it("ListMouse forwards the actionable pointer with its episode predicate", () => {
	const list = new HoverList();
	list.render(80);
	const event: TuiMouseEvent = {
		type: "move",
		button: "none",
		x: 1,
		y: 0,
		screenX: 1,
		screenY: 0,
		width: 80,
		height: 2,
		shift: false,
		alt: false,
		ctrl: false,
	};
	const result = dispatchMouseEvent(list, event);
	assert.equal(result?.pointerShape, "pointer");
	assert.equal(result?.hoverValid?.(), true);
	list.mouse.clearHover();
	assert.equal(result?.hoverValid?.(), false);
});
