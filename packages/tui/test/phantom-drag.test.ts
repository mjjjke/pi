import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("fullscreen observed mouse buttons", () => {
	it("underlines links on orphan right-button motion without selecting text", () => {
		const terminal = new VirtualTerminal(30, 4);
		const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
		tui.addChild(new Text("\x1b]8;id=link;https://example.com\x07example\x1b]8;;\x07 plain", 0, 0));
		tui.start();
		try {
			tui.renderNow();
			terminal.sendInput("\x1b[<34;2;1M");
			tui.renderNow();
			assert.match(tui.getScreenLines()[0], /\x1b\[4m/);
			terminal.sendInput("\x1b[<34;6;1M");
			assert.equal(tui.hasActiveSelection(), false);
			terminal.sendInput("\x1b[<34;12;1M");
			tui.renderNow();
			assert.doesNotMatch(tui.getScreenLines()[0], /\x1b\[4m/);
		} finally {
			tui.stop();
		}
	});

	for (const button of [0, 1, 2]) {
		for (const reset of ["release", "focus-out", "restart"]) {
			it(`requires an observed press for button ${button}, cleared by ${reset}`, () => {
				const terminal = new VirtualTerminal(30, 4);
				const tui = new TuiAltScreen(terminal);
				const events: TuiMouseEvent[] = [];
				tui.addChild({
					render: () => ["control"],
					invalidate() {},
					handleMouse(event) {
						events.push(event);
						return { handled: true, capture: event.type === "press", render: false };
					},
				});
				tui.start();
				try {
					tui.renderNow();
					terminal.sendInput(`\x1b[<${button + 32};2;1M`);
					assert.equal(events.at(-1)?.type, "move");
					assert.equal(events.at(-1)?.button, "none");
					terminal.sendInput(`\x1b[<${button};2;1M`);
					terminal.sendInput(`\x1b[<${button + 32};2;5M`);
					terminal.sendInput(`\x1b[<${button + 32};3;1M`);
					assert.equal(events.at(-1)?.type, "drag");
					assert.equal(events.at(-1)?.button, ["left", "middle", "right"][button]);
					// Another button's orphan motion must not be dispatched as a captured drag.
					terminal.sendInput(`\x1b[<${32 + ((button + 1) % 3)};4;1M`);
					assert.equal(events.at(-1)?.type, "move");
					assert.equal(events.at(-1)?.button, "none");
					terminal.sendInput(`\x1b[<${button + 32};3;1M`);
					assert.equal(events.at(-1)?.type, "drag");
					if (reset === "release") terminal.sendInput(`\x1b[<${button};3;1m`);
					else if (reset === "focus-out") terminal.sendInput("\x1b[O");
					else {
						tui.stop();
						tui.start();
						tui.renderNow();
					}
					terminal.sendInput(`\x1b[<${button + 32};4;1M`);
					assert.equal(events.at(-1)?.type, "move");
					assert.equal(events.at(-1)?.button, "none");
				} finally {
					tui.stop();
				}
			});
		}
	}

	it("does not move an active scrollbar drag on orphan motion", () => {
		const terminal = new VirtualTerminal(10, 10);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "always" },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		try {
			tui.renderNow();
			terminal.sendInput("\x1b[<0;10;6M");
			assert.equal(scrollView.scrollTop, 20);
			terminal.sendInput("\x1b[<34;10;10M");
			assert.equal(scrollView.scrollTop, 20);
			terminal.sendInput("\x1b[<32;10;10M");
			assert.equal(scrollView.scrollTop, 40);
			terminal.sendInput("\x1b[<0;10;10m");
			terminal.sendInput("\x1b[<32;10;1M");
			assert.equal(scrollView.scrollTop, 40);
		} finally {
			tui.stop();
		}
	});

	it("does not extend a left selection with orphan right-button motion", () => {
		const terminal = new VirtualTerminal(30, 4);
		const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
		tui.addChild(new Text("selectable text", 0, 0));
		tui.start();
		try {
			tui.renderNow();
			terminal.sendInput("\x1b[<32;8;1M");
			assert.equal(tui.hasActiveSelection(), false);
			terminal.sendInput("\x1b[<0;2;1M");
			terminal.sendInput("\x1b[<34;8;1M");
			assert.equal(tui.hasActiveSelection(), false);
			terminal.sendInput("\x1b[<32;5;1M");
			assert.equal(tui.hasActiveSelection(), true);
			terminal.sendInput("\x1b[<0;5;1m");
			tui.renderNow();
			const selected = tui.getScreenLines();
			terminal.sendInput("\x1b[<32;12;1M");
			tui.renderNow();
			assert.deepEqual(tui.getScreenLines(), selected);
		} finally {
			tui.stop();
		}
	});
});
