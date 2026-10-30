import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { AutocompleteSuggestions } from "../src/autocomplete.ts";
import { Editor } from "../src/components/editor.ts";
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
