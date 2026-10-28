import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { type Component, Container, type TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function control(events: TuiMouseEvent[]): Component {
	return {
		render: () => ["control"],
		invalidate() {},
		handleMouse(event) {
			events.push(event);
			return { handled: true, render: event.type === "leave" };
		},
	};
}

describe("fullscreen mouse leave", () => {
	it("notifies the exact nested target once when moving to another component or outside", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const first: TuiMouseEvent[] = [];
		const second: TuiMouseEvent[] = [];
		const nested = new Container();
		nested.addChild(control(first));
		nested.addChild(control(second));
		tui.addChild(nested);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<35;2;1M");
			terminal.sendInput("\x1b[<35;3;1M");
			assert.deepEqual(
				first.map((e) => e.type),
				["move", "move"],
			);
			terminal.sendInput("\x1b[<35;3;2M");
			assert.deepEqual(
				first.map((e) => e.type),
				["move", "move", "leave"],
			);
			assert.equal(first.at(-1)?.x, 2);
			assert.equal(first.at(-1)?.y, 1);
			assert.equal(first.at(-1)?.height, 1);
			assert.deepEqual(
				second.map((e) => e.type),
				["move"],
			);
			terminal.sendInput("\x1b[<35;3;4M");
			terminal.sendInput("\x1b[<35;4;4M");
			assert.deepEqual(
				second.map((e) => e.type),
				["move", "leave"],
			);
		} finally {
			tui.stop();
		}
	});

	it("clears hover when an overlay takes the pointer, including unhandled overlay moves", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const events: TuiMouseEvent[] = [];
		tui.addChild(control(events));
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<35;2;1M");
			tui.showOverlay(new Text("overlay", 0, 0), { anchor: "top-left", width: 10 });
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<35;2;1M");
			assert.deepEqual(
				events.map((e) => e.type),
				["move", "leave"],
			);
		} finally {
			tui.stop();
		}
	});

	it("ends passive hover on keyboard input, including viewport-owned shortcuts", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const events: TuiMouseEvent[] = [];
		tui.addChild(control(events));
		tui.start();
		try {
			await terminal.waitForRender();
			for (const key of ["x", "\x1b[5~"]) {
				terminal.sendInput("\x1b[<35;2;1M");
				terminal.sendInput(key);
			}
			assert.deepEqual(
				events.map((event) => event.type),
				["move", "leave", "move", "leave"],
			);
		} finally {
			tui.stop();
		}
	});

	it("notifies once on focus loss and mouse-reporting shutdown, without carrying hover across restart", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const events: TuiMouseEvent[] = [];
		tui.addChild(control(events));
		tui.start();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<35;2;1M");
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[O");
		assert.deepEqual(
			events.map((e) => e.type),
			["move", "leave"],
		);
		terminal.sendInput("\x1b[<35;2;1M");
		tui.stop();
		assert.deepEqual(
			events.map((e) => e.type),
			["move", "leave", "move", "leave"],
		);
		tui.start();
		await terminal.waitForRender();
		tui.stop();
		assert.equal(events.filter((e) => e.type === "leave").length, 2);
	});
});
