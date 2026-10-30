import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { type Component, Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const press = "\x1b[<0;2;1M";
const release = "\x1b[<0;2;1m";
const move = "\x1b[<35;2;1M";
const wheel = "\x1b[<65;2;1M";
const pointer = "\x1b]22;pointer\x1b\\";
const arrow = "\x1b]22;default\x1b\\";
let saved: Record<string, string | undefined>;
const envKeys = ["TMUX", "STY", "ZELLIJ", "TERM", "PI_POINTER_SHAPE"];
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

describe("mouse dispatch lifecycle isolation", () => {
	for (const overlay of [false, true]) {
		for (const phase of ["move", "press", "drag", "release", "click", "wheel", "fallback"] as const) {
			it(`drops ${phase} handler results after replacing the ${overlay ? "overlay" : "layout"} screen`, (t) => {
				const terminal = new RecordingTerminal(20, 6);
				const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
				const keys: string[] = [];
				const ids: number[] = [];
				const fresh: Component = {
					render: () => ["fresh"],
					invalidate() {},
					handleInput: (key) => keys.push(`fresh:${key}`),
					handleMouse(event) {
						if (event.type === "press") ids.push(event.gestureId!);
						return { handled: true };
					},
				};
				const old: Component = {
					render: () => ["old"],
					invalidate() {},
					handleInput: (key) => keys.push(`old:${key}`),
					handleMouse(event) {
						if (event.type === "press") ids.push(event.gestureId!);
						if (event.type === (phase === "fallback" ? "click" : phase)) {
							if (phase === "fallback") assert.equal(event.clickSource, "fallback");
							tui.stop({ preserveScreen: true });
							handle?.hide();
							tui.clear();
							tui.addChild(fresh);
							tui.setFocus(fresh);
							tui.start();
							tui.renderNow();
						}
						return phase === "fallback" && event.type !== "click"
							? undefined
							: { handled: true, focus: true, capture: true, pointerShape: "pointer" };
					},
				};
				tui.addChild(old);
				tui.setFocus(old);
				tui.start();
				tui.renderNow();
				const handle = overlay ? tui.showOverlay(old, { row: 0, col: 0, width: 20 }) : undefined;
				tui.renderNow();
				t.after(() => tui.stop({ preserveScreen: true }));
				if (["drag", "release", "click", "fallback"].includes(phase)) terminal.sendInput(press);
				terminal.sendInput(
					phase === "move"
						? move
						: phase === "wheel"
							? wheel
							: phase === "press"
								? press
								: phase === "drag"
									? "\x1b[<32;3;1M"
									: release,
				);
				terminal.sendInput("x");
				assert.deepEqual(keys, ["fresh:x"]);
				assert.equal(tui.getFocusedComponent(), fresh);
				assert.deepEqual(terminal.shapes(), []);
				terminal.sendInput(press);
				if (ids.length > 1) assert.ok(ids.at(-1)! > ids[0]);
			});
		}
	}
	for (const gaining of [false, true]) {
		for (const phase of ["press", "wheel", "drag", "release", "click", "fallback"] as const) {
			it(`abandons ${phase} recording after a ${gaining ? "gaining" : "losing"} focus setter replaces the screen`, (t) => {
				const terminal = new RecordingTerminal(20, 6);
				const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
				const keys: string[] = [];
				const seen: string[] = [];
				const freshEvents: string[] = [];
				let armed = false;
				const fresh: Component = {
					render: () => ["fresh"],
					invalidate() {},
					handleInput: (key) => keys.push(`fresh:${key}`),
					handleMouse(event) {
						freshEvents.push(event.type);
						return undefined;
					},
				};
				const restart = () => {
					if (!armed) return;
					armed = false;
					tui.stop({ preserveScreen: true });
					tui.clear();
					tui.addChild(fresh);
					tui.setFocus(fresh);
					tui.start();
					tui.renderNow();
				};
				const focus: Component & { focused: boolean } = {
					render: () => [],
					invalidate() {},
					get focused() {
						return false;
					},
					set focused(value) {
						if (!value && !gaining) restart();
					},
				};
				const old: Component & { focused: boolean } = {
					render: () => ["old"],
					invalidate() {},
					handleInput: (key) => keys.push(`old:${key}`),
					get focused() {
						return false;
					},
					set focused(value) {
						if (value && gaining) restart();
					},
					handleMouse(event) {
						seen.push(event.type);
						if (event.type === (phase === "fallback" ? "click" : phase)) armed = true;
						if (phase === "fallback" && event.type !== "click") return undefined;
						return { handled: true, capture: true, focus: armed };
					},
				};
				tui.addChild(old);
				tui.setFocus(focus);
				tui.start();
				tui.renderNow();
				t.after(() => tui.stop({ preserveScreen: true }));
				if (["drag", "release", "click", "fallback"].includes(phase)) terminal.sendInput(press);
				terminal.sendInput(
					phase === "wheel" ? wheel : phase === "press" ? press : phase === "drag" ? "\x1b[<32;3;1M" : release,
				);
				// Exercise stale capture/press ownership before the replacement's key.
				terminal.sendInput(release);
				terminal.sendInput("x");
				assert.deepEqual(keys, ["fresh:x"]);
				assert.equal(tui.getFocusedComponent(), fresh);
				assert.equal(seen.at(-1), phase === "fallback" ? "click" : phase);
				assert.deepEqual(freshEvents, ["release"], "old capture cannot route or swallow replacement input");
			});
		}
	}
	for (const phase of [
		"move-finally",
		"press-finally",
		"wheel-before",
		"wheel-after",
		"ownership-before",
		"render",
		"teardown",
	] as const) {
		it(`abandons the old continuation after leave in ${phase}`, (t) => {
			const terminal = new RecordingTerminal(20, 6);
			const tui = new TuiAltScreen(terminal);
			const keys: string[] = [];
			const seen: string[] = [];
			const fresh: Component = {
				render: () => ["fresh"],
				invalidate() {},
				handleInput: (key) => keys.push(`fresh:${key}`),
				handleMouse(event) {
					seen.push(`fresh:${event.type}`);
					return undefined;
				},
			};
			let valid = true;
			const a: Component = {
				render: () => ["A"],
				invalidate() {},
				handleMouse(event) {
					if (event.type === "leave") {
						tui.stop({ preserveScreen: true });
						tui.clear();
						tui.addChild(fresh);
						tui.setFocus(fresh);
						tui.start();
						tui.renderNow();
						return { handled: true, render: false };
					}
					if (event.type === "wheel") valid = false;
					return { handled: true, pointerShape: "pointer", hoverValid: () => valid };
				},
			};
			const b: Component = {
				render: () => ["B"],
				invalidate() {},
				handleInput: (key) => keys.push(`old:${key}`),
				handleMouse(event) {
					seen.push(event.type);
					return { handled: true, focus: true, capture: true, pointerShape: "pointer" };
				},
			};
			const host = new Container();
			host.addChild(a);
			host.addChild(b);
			tui.addChild(host);
			tui.setFocus(b);
			tui.start();
			tui.renderNow();
			t.after(() => tui.stop({ preserveScreen: true }));
			terminal.sendInput(move);
			if (phase === "render" || phase === "ownership-before") tui.setFocus(null);
			if (phase === "render") tui.renderNow();
			else if (phase === "teardown") tui.stop({ preserveScreen: true });
			else
				terminal.sendInput(
					phase === "ownership-before"
						? "\x1b[<0;2;2M"
						: phase === "move-finally"
							? "\x1b[<35;2;2M"
							: phase === "press-finally"
								? "\x1b[<0;2;2M"
								: phase === "wheel-before"
									? "\x1b[<65;2;2M"
									: wheel,
				);
			assert.deepEqual(terminal.shapes(), [pointer, arrow]);
			assert.ok(tui.getScreenLines()[0].startsWith("fresh"));
			terminal.sendInput("x");
			assert.deepEqual(keys, ["fresh:x"]);
			assert.equal(tui.getFocusedComponent(), fresh);
			if (phase === "wheel-before" || phase === "ownership-before")
				assert.deepEqual(seen, [], "old event cannot dispatch on the replacement screen");
		});
	}
});
