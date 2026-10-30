import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { AutocompleteSuggestions } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
import { ListMouse } from "../src/components/list-mouse.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { SelectList } from "../src/components/select-list.ts";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { Text } from "../src/components/text.ts";
import { type Component, Container, type TuiMouseEvent, type TuiMouseEventResult } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { defaultEditorTheme, defaultSelectListTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class GestureTarget implements Component {
	events: TuiMouseEvent[] = [];
	keys: string[] = [];
	wantsKeyRelease = false;
	onRelease?: () => void;
	render(): string[] {
		return ["target"];
	}
	invalidate(): void {}
	handleInput(data: string): void {
		this.keys.push(data);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		this.events.push(event);
		if (event.type === "release") this.onRelease?.();
		if (event.type === "press") return { handled: true, focus: true };
		if (event.type === "click") return { handled: true };
		return undefined;
	}
}

function setup(t: TestContext, component: Component = new GestureTarget()) {
	const terminal = new VirtualTerminal(30, 8);
	const tui = new TuiAltScreen(terminal);
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	tui.renderNow();
	t.after(() => tui.stop());
	return { tui, terminal, send: (data: string) => terminal.sendInput(data) };
}
const press = "\x1b[<0;2;1M";
const release = "\x1b[<0;2;1m";

const settingsTheme: SettingsListTheme = {
	label: (s) => s,
	value: (s) => s,
	description: (s) => s,
	hint: (s) => s,
	cursor: "> ",
};

describe("captured component gesture lifetime", () => {
	it("stamps captured press/release/click with one gesture id and increments on the next press", (t) => {
		const target = new GestureTarget();
		const { send } = setup(t, target);
		for (let i = 0; i < 2; i++) {
			send(press);
			send(release);
		}
		const firstId = target.events[0].gestureId;
		assert.equal(typeof firstId, "number");
		assert.deepEqual(
			target.events.map((event) => event.gestureId),
			[firstId, firstId, firstId, firstId! + 1, firstId! + 1, firstId! + 1],
		);
	});
	it("stamps fallback clicks with their unhandled press's id", (t) => {
		const target = new GestureTarget();
		target.handleMouse = (event) => {
			target.events.push(event);
			return undefined;
		};
		const { send } = setup(t, target);
		send(press);
		send(release);
		const click = target.events.find((event) => event.type === "click");
		assert.equal(click?.clickSource, "fallback");
		assert.equal(typeof target.events[0].gestureId, "number");
		assert.equal(click?.gestureId, target.events[0].gestureId);
	});
	it("does not reuse gesture ids after a lost release, focus loss or renderer restart", (t) => {
		const target = new GestureTarget();
		const { tui, send } = setup(t, target);
		send(press);
		send("x");
		send(press);
		send("\x1b[O");
		send(press);
		tui.stop();
		tui.start();
		tui.renderNow();
		send(press);
		send(release);
		const ids = target.events.filter((event) => event.type === "press").map((event) => event.gestureId);
		assert.equal(ids.length, 4);
		assert.equal(typeof ids[0], "number");
		assert.deepEqual(ids, [ids[0], ids[0]! + 1, ids[0]! + 2, ids[0]! + 3]);
	});
	for (const key of ["x", "\r", "\x1b"]) {
		it(`swallows release and click after delivered key ${JSON.stringify(key)}`, (t) => {
			const target = new GestureTarget();
			const { send } = setup(t, target);
			send(press);
			send(key);
			send(release);
			assert.deepEqual(target.keys, [key]);
			assert.deepEqual(
				target.events.map((e) => e.type),
				["press"],
			);
		});
	}
	for (const back of [false, true]) {
		it(`voids displaced focus${back ? " even after A→B→A" : ""}`, (t) => {
			const target = new GestureTarget();
			const { tui, send } = setup(t, target);
			send(press);
			tui.setFocus(new Text("replacement"));
			if (back) tui.setFocus(target);
			send(release);
			assert.deepEqual(
				target.events.map((e) => e.type),
				["press"],
			);
		});
	}
	for (const during of ["same focus", "key release", "delivered key release", "wheel", "PageUp"]) {
		it(`preserves a held click across ${during}`, (t) => {
			const target = new GestureTarget();
			const { tui, send } = setup(t, target);
			target.wantsKeyRelease = during === "delivered key release";
			send(press);
			if (during === "same focus") tui.setFocus(target);
			else send(during.includes("key release") ? "\x1b[97;1:3u" : during === "wheel" ? "\x1b[<65;2;1M" : "\x1b[5~");
			send(release);
			assert.equal(target.events.filter((e) => e.type === "click").length, 1);
			assert.equal(target.events.find((e) => e.type === "click")?.clickSource, "captured");
		});
	}
	it("re-baselines the press's own focus request to a delegating parent", (t) => {
		const target = new GestureTarget();
		class Parent extends Container {
			handleInput(): void {}
		}
		const parent = new Parent();
		parent.addChild(target);
		const { tui, send } = setup(t, parent);
		tui.setFocus(new Text("other"));
		send(press);
		send(release);
		assert.equal(tui.getFocusedComponent(), parent);
		assert.equal(target.events.filter((e) => e.type === "click").length, 1);
	});
	it("still synthesizes the same release's click when its handler changes focus", (t) => {
		const target = new GestureTarget();
		const { tui, send } = setup(t, target);
		target.onRelease = () => tui.setFocus(new Text("next"));
		send(press);
		send(release);
		assert.deepEqual(
			target.events.map((e) => e.type),
			["press", "release", "click"],
		);
	});
	it("swallows every remaining drag/release, then allows a fresh gesture", (t) => {
		const target = new GestureTarget();
		const { send } = setup(t, target);
		send(press);
		send("x");
		send("\x1b[<32;3;1M");
		send("\x1b[<32;2;1M");
		send(release);
		assert.deepEqual(
			target.events.map((e) => e.type),
			["press"],
		);
		send(press);
		send(release);
		assert.deepEqual(
			target.events.map((e) => e.type),
			["press", "press", "release", "click"],
		);
	});
	it("starts fresh after a voided gesture whose release was swallowed by the terminal", (t) => {
		const target = new GestureTarget();
		const { send } = setup(t, target);
		send(press);
		send("x");
		send("\x1b[<32;3;1M");
		send(press);
		send(release);
		assert.deepEqual(
			target.events.map((e) => e.type),
			["press", "press", "release", "click"],
		);
	});
	for (const nonCapturing of [false, true]) {
		it(
			nonCapturing
				? "residual: non-capturing overlay cover leaves the capture live"
				: "capturing overlay show voids the held gesture",
			(t) => {
				const target = new GestureTarget();
				const { tui, send } = setup(t, target);
				send(press);
				tui.showOverlay(new Text("cover"), { row: 0, col: 0, width: 20, nonCapturing });
				tui.renderNow();
				send(release);
				assert.equal(target.events.filter((e) => e.type === "click").length, nonCapturing ? 1 : 0);
			},
		);
	}
	it("residual: responsive hiding of a capturing overlay still delivers its held click", (t) => {
		const { tui, terminal, send } = setup(t, new Text("base"));
		const overlay = new GestureTarget();
		const handle = tui.showOverlay(overlay, { row: 0, col: 0, width: 20, visible: (width) => width >= 30 });
		tui.renderNow();
		send(press);
		terminal.resize(25, 8);
		tui.renderNow();
		assert.equal(handle.getBounds(), undefined);
		assert.equal(tui.getFocusedComponent(), overlay);
		send(release);
		assert.equal(overlay.events.filter((e) => e.type === "click").length, 1);
	});
	for (const kind of ["SelectList", "SettingsList"]) {
		it(`${kind} captured press→Esc→release only cancels`, (t) => {
			const log: string[] = [];
			const list =
				kind === "SelectList"
					? new SelectList([{ value: "a", label: "A" }], 5, defaultSelectListTheme)
					: new SettingsList(
							[{ id: "a", label: "A", currentValue: "off", values: ["off", "on"] }],
							5,
							settingsTheme,
							() => log.push("change"),
							() => log.push("cancel"),
						);
			if (list instanceof SelectList) {
				list.onSelect = () => log.push("activate");
				list.onCancel = () => log.push("cancel");
			}
			const { send } = setup(t, list);
			send(press);
			send("\x1b");
			send(release);
			assert.deepEqual(log, ["cancel"]);
		});
		it(`residual: fallback clicks can still activate ${kind} after replacement`, (t) => {
			const log: string[] = [];
			const { tui, send } = setup(t, new Text("inert", 0, 0));
			send(press);
			const list =
				kind === "SelectList"
					? new SelectList([{ value: "a", label: "A" }], 5, defaultSelectListTheme)
					: new SettingsList(
							[{ id: "a", label: "A", currentValue: "off", values: ["off", "on"] }],
							5,
							settingsTheme,
							() => log.push("change"),
							() => {},
						);
			if (list instanceof SelectList) list.onSelect = () => log.push("activate");
			tui.clear();
			tui.addChild(list);
			tui.setFocus(list);
			tui.renderNow();
			send(release);
			assert.deepEqual(log, [kind === "SelectList" ? "activate" : "change"]);
		});
	}
	it("residual: timer-driven same-focus replacement keeps a captured target live", async (t) => {
		const target = new GestureTarget();
		const { tui, send } = setup(t, target);
		send(press);
		await new Promise<void>((resolve) =>
			setTimeout(() => {
				tui.clear();
				tui.addChild(new Text("replacement"));
				tui.renderNow();
				resolve();
			}, 0),
		);
		send(release);
		assert.equal(target.events.filter((e) => e.type === "click").length, 1);
	});
	it("residual: an async autocomplete swap during a hold completes the NEW item", async (t) => {
		const { tui, terminal, send } = setup(t, new Text("base"));
		const editor = new Editor(tui, defaultEditorTheme);
		let resolveSuggestions: ((suggestions: AutocompleteSuggestions) => void) | undefined;
		let requests = 0;
		editor.setAutocompleteProvider({
			getSuggestions: async () => {
				requests++;
				if (requests === 1) return { items: [{ value: "old", label: "old" }], prefix: "/" };
				return new Promise<AutocompleteSuggestions>((resolve) => {
					resolveSuggestions = resolve;
				});
			},
			applyCompletion: (_lines, _line, _col, item) => ({
				lines: [item.value],
				cursorLine: 0,
				cursorCol: item.value.length,
			}),
		});
		tui.clear();
		tui.addChild(editor);
		tui.setFocus(editor);
		send("/");
		await terminal.waitForRender();
		assert.equal(editor.isShowingAutocomplete(), true);
		send("x");
		await terminal.waitForRender();
		assert.ok(resolveSuggestions);
		send("\x1b[<0;2;4M");
		resolveSuggestions({ items: [{ value: "new", label: "new" }], prefix: "/x" });
		await terminal.waitForRender();
		assert.ok((await terminal.flushAndGetViewport())[3].includes("new"));
		send("\x1b[<0;2;4m");
		assert.equal(editor.getText(), "new");
	});
	it("preserves editor fallback click-to-position and drag-select/copy", async (t) => {
		const terminal = new VirtualTerminal(20, 6);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello world");
		tui.addChild(editor);
		tui.start();
		tui.renderNow();
		t.after(() => tui.stop());
		terminal.sendInput("\x1b[<0;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		terminal.sendInput("X");
		assert.equal(editor.getText(), "heXllo world");
		tui.renderNow();
		const cursor = editor.getCursor();
		terminal.sendInput("\x1b[<0;1;2M");
		terminal.sendInput("\x1b[<32;5;2M");
		terminal.sendInput("\x1b[<0;5;2m");
		await terminal.flush();
		assert.deepEqual(copied, ["heXll"]);
		assert.deepEqual(editor.getCursor(), cursor);
	});
});

class MatrixTarget implements Component {
	events: string[] = [];
	keys: string[] = [];
	render() {
		return ["target"];
	}
	invalidate() {}
	handleInput(data: string) {
		this.keys.push(data);
	}
	handleMouse(event: TuiMouseEvent) {
		this.events.push(event.type);
		return event.type === "press" ? { handled: true, focus: true, capture: true } : undefined;
	}
}
for (const [name, input, clicks, delivered] of [
	["modified key", "\x1b[97;5u", 0, true],
	["repeat key", "\x1b[97;1:2u", 0, true],
	["synthetic modifier-only press (not requested by flags=7)", "\x1b[57442;1u", 0, true],
	["modifier release", "\x1b[57442;1:3u", 1, false],
	["bracketed paste containing release-like text", "\x1b[200~90:62:3F\x1b[201~", 0, true],
	["focus-in", "\x1b[I", 1, false],
	["focus-out", "\x1b[O", 0, false],
	["cell-size report", "\x1b[6;20;10t", 1, false],
	["color-scheme report", "\x1b[?997;1n", 1, false],
] as const) {
	it(`held captured gesture across ${name}`, (t) => {
		const terminal = new VirtualTerminal(30, 8),
			target = new MatrixTarget();
		const tui = new TuiAltScreen(terminal);
		tui.addChild(target);
		tui.setFocus(target);
		tui.start();
		tui.renderNow();
		t.after(() => tui.stop());
		terminal.sendInput(press);
		terminal.sendInput(input);
		terminal.sendInput(release);
		assert.equal(target.events.filter((x) => x === "click").length, clicks);
		assert.deepEqual(target.keys, delivered ? [input] : []);
	});
}
for (const action of [
	"hide",
	"setHidden",
	"unfocus",
	"same focus",
	"null",
	"consumed key",
	"debug",
	"pending color reply",
]) {
	it(`held overlay gesture across ${action}`, (t) => {
		const terminal = new VirtualTerminal(30, 8),
			target = new MatrixTarget();
		const tui = new TuiAltScreen(terminal);
		const base = new Text("base");
		tui.addChild(base);
		tui.setFocus(base);
		const overlay = tui.showOverlay(target, { row: 0, col: 0, width: 20 });
		tui.start();
		tui.renderNow();
		t.after(() => tui.stop());
		terminal.sendInput(press);
		if (action === "hide") overlay.hide();
		else if (action === "setHidden") overlay.setHidden(true);
		else if (action === "unfocus") overlay.unfocus();
		else if (action === "same focus") tui.setFocus(target);
		else if (action === "null") tui.setFocus(null);
		else if (action === "consumed key") {
			tui.addInputListener(() => ({ consume: true }));
			terminal.sendInput("x");
		} else if (action === "debug") {
			tui.onDebug = () => {};
			terminal.sendInput("\x1b[100;6u");
		} else {
			void tui.queryTerminalColors({ timeoutMs: 100 });
			terminal.sendInput("\x1b]10;rgb:ffff/ffff/ffff\x07");
			terminal.sendInput("\x1b[?1;2c");
		}
		// The viewport dispatches mouse releases before component input listeners.
		terminal.sendInput(release);
		assert.equal(
			target.events.filter((x) => x === "click").length,
			["same focus", "consumed key", "debug", "pending color reply"].includes(action) ? 1 : 0,
		);
		assert.deepEqual(target.keys, []);
	});
}
it("renderer selection survives delivered key and component focus change", async (t) => {
	const terminal = new VirtualTerminal(30, 8),
		copied: string[] = [],
		target = new MatrixTarget();
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (s) => {
			copied.push(s);
			return true;
		},
	});
	tui.addChild(new Text("abcdefgh", 0, 0));
	tui.setFocus(target);
	tui.start();
	tui.renderNow();
	t.after(() => tui.stop());
	terminal.sendInput(press);
	terminal.sendInput("x");
	tui.setFocus(new MatrixTarget());
	terminal.sendInput("\x1b[<32;6;1M");
	terminal.sendInput("\x1b[<0;6;1m");
	await terminal.flush();
	assert.deepEqual(copied, ["bcdef"]);
	assert.deepEqual(target.keys, ["x"]);
});
it("modified links survive delivered key and focus change without dispatching component clicks", (t) => {
	const terminal = new VirtualTerminal(30, 8),
		opened: string[] = [],
		target = new MatrixTarget();
	target.render = () => ["\x1b]8;;https://example.com\x07link\x1b]8;;\x07"];
	const tui = new TuiAltScreen(terminal, undefined, undefined, { openUrl: (s) => opened.push(s) });
	tui.addChild(target);
	tui.setFocus(target);
	tui.start();
	tui.renderNow();
	t.after(() => tui.stop());
	terminal.sendInput("\x1b[<16;2;1M");
	terminal.sendInput("x");
	tui.setFocus(new MatrixTarget());
	terminal.sendInput("\x1b[<16;2;1m");
	assert.deepEqual(opened, ["https://example.com"]);
	assert.equal(target.events.includes("click"), false);
});
it("scrollbar drag survives delivered key and focus change", (t) => {
	const terminal = new VirtualTerminal(30, 8),
		target = new MatrixTarget();
	const scroll = new ScrollView(new Text(Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n"), 0, 0), {
		scrollbar: "always",
		primary: true,
	});
	const tui = new TuiAltScreen(terminal);
	tui.setLayoutRoot(scroll);
	tui.setFocus(target);
	tui.start();
	tui.renderNow();
	t.after(() => tui.stop());
	const before = scroll.scrollTop;
	terminal.sendInput("\x1b[<0;30;1M");
	terminal.sendInput("x");
	tui.setFocus(new MatrixTarget());
	terminal.sendInput("\x1b[<32;30;6M");
	terminal.sendInput("\x1b[<0;30;6m");
	assert.ok(scroll.scrollTop > before);
	assert.deepEqual(target.keys, ["x"]);
});

it("review: modified link after lost release cannot leave an unstamped captured click", () => {
	const actions: string[] = [],
		opened: string[] = [],
		events: TuiMouseEvent[] = [];
	const mouse = new ListMouse<string>({
		select() {},
		activate(key) {
			actions.push(key);
			return true;
		},
	});
	const component: Component = {
		render() {
			mouse.beginRows();
			mouse.addRow("A", 0);
			return ["\x1b]8;;https://example.com\x07row A\x1b]8;;\x07"];
		},
		invalidate() {},
		handleInput() {},
		handleMouse(event) {
			events.push(event);
			return mouse.handle(event);
		},
	};
	const terminal = new VirtualTerminal(30, 8),
		tui = new TuiAltScreen(terminal, undefined, undefined, { openUrl: (url) => opened.push(url) });
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	tui.renderNow();
	try {
		terminal.sendInput("\x1b[<0;2;1M"); // row press; terminal loses its release
		terminal.sendInput("\x1b[<16;2;1M"); // fresh ctrl-link press bypasses the helper
		terminal.sendInput("\x1b[<16;2;1m"); // opens link, clears current gesture id
		assert.deepEqual(opened, ["https://example.com"]);
		assert.deepEqual(actions, []);
		terminal.sendInput("\x1b[<0;2;1m"); // orphan/duplicate release, no new press
		assert.deepEqual(actions, []);
		assert.equal(
			events.some((event) => event.type === "click"),
			false,
		);
		terminal.sendInput(press);
		terminal.sendInput(release);
		assert.deepEqual(actions, ["A"]);
	} finally {
		tui.stop();
	}
});

for (const [path, x, y] of [
	["selection/fallback", 2, 2],
	["scrollbar", 30, 7],
] as const) {
	it(`fresh ${path} press ends old component capture after a lost release`, (t) => {
		const target = new GestureTarget();
		target.render = () => ["target", ...Array.from({ length: 49 }, () => "inert")];
		target.handleMouse = (event) => {
			target.events.push(event);
			if (event.y !== 0) return undefined;
			return event.type === "press" ? { handled: true, capture: true } : undefined;
		};
		const { tui, send } = setup(t, target);
		const scroll = new ScrollView(target, { scrollbar: "always", primary: true });
		tui.setLayoutRoot(scroll);
		tui.renderNow();
		send(press); // lost release
		send(`\x1b[<0;${x};${y}M`);
		send(`\x1b[<0;${x};${y}m`);
		send(release); // duplicate release at the old captured point
		assert.equal(
			target.events.some((event) => event.clickSource === "captured"),
			false,
		);
		if (path === "scrollbar") assert.ok(scroll.scrollTop > 0);
		else
			assert.equal(
				target.events.some((event) => event.clickSource === "fallback"),
				true,
			);
		target.events = [];
		scroll.scrollToStart();
		tui.renderNow();
		send(press);
		send(release);
		assert.deepEqual(
			target.events.map((event) => event.type),
			["press", "release", "click"],
		);
	});
}
