import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
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
	for (const capture of [false, true]) {
		for (const motion of ["\x1b[<32;2;4M", ""]) {
			it(`ends hover outside on ${motion ? "drag" : "release"}, capture=${capture}`, async () => {
				const terminal = new VirtualTerminal(20, 6);
				const tui = new TuiAltScreen(terminal);
				const events: TuiMouseEvent[] = [];
				const target = control(events);
				target.handleMouse = (event) => {
					events.push(event);
					if (event.type === "drag") return undefined;
					return { handled: true, capture: capture && event.type === "press", render: false };
				};
				tui.addChild(target);
				tui.start();
				try {
					await terminal.waitForRender();
					terminal.sendInput("\x1b[<35;2;1M");
					terminal.sendInput("\x1b[<0;2;1M");
					if (motion) terminal.sendInput(motion);
					terminal.sendInput("\x1b[<0;2;4m");
					assert.equal(events.filter((event) => event.type === "leave").length, 1);
					assert.equal(events.find((event) => event.type === "leave")?.y, 3);
					assert.equal(events.at(-1)?.type, motion ? "release" : "leave");
					assert.ok(!events.some((event) => event.type === "click"));
					terminal.sendInput("\x1b[<35;2;5M");
					assert.equal(events.filter((event) => event.type === "leave").length, 1);
				} finally {
					tui.stop();
				}
			});
		}
	}

	for (const input of ["\x1b[<0;2;4M", "\x1b[<65;2;4M"]) {
		it(`uses the latest pointer position on ${input.includes("65;") ? "wheel" : "press"}`, async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui = new TuiAltScreen(terminal);
			const events: TuiMouseEvent[] = [];
			tui.addChild(control(events));
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput("\x1b[<35;2;1M");
				terminal.sendInput(input);
				assert.deepEqual(
					events.map((event) => event.type),
					["move", "leave"],
				);
				assert.equal(events.at(-1)?.y, 3);
				await terminal.waitForRender();
				assert.equal(events.filter((event) => event.type === "leave").length, 1);
			} finally {
				tui.stop();
			}
		});
	}

	for (const scenario of [
		"nested layout",
		"box layout",
		"overlay resize",
		"overlay hide",
		"overlay hidden",
		"scroll clipping",
		"root replacement",
	]) {
		it(`clears stationary hover after ${scenario} and repaints the actual screen`, async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui = new TuiAltScreen(terminal);
			const events: TuiMouseEvent[] = [];
			let hovered = false;
			const target: Component = {
				render: () => [hovered ? "HOVERED" : "control"],
				invalidate() {},
				handleMouse(event) {
					events.push(event);
					if (event.type === "move") hovered = true;
					if (event.type === "leave") hovered = false;
					return { handled: true, render: event.type === "move" || event.type === "leave" };
				},
			};
			const parent = scenario === "box layout" ? new Box(1, 1) : new Container();
			parent.addChild(target);
			const scroll = new ScrollView(parent, { follow: "none", scrollbar: "hidden" });
			const overlay = scenario.startsWith("overlay")
				? tui.showOverlay(target, { anchor: "bottom-left", width: 10 })
				: undefined;
			if (scenario === "scroll clipping") {
				parent.addChild(new Text("tail\n".repeat(8), 0, 0));
				tui.setLayoutRoot(scroll);
			} else if (!overlay) tui.addChild(parent);
			tui.start();
			try {
				await terminal.waitForRender();
				terminal.sendInput(`\x1b[<35;2;${overlay ? 6 : scenario === "box layout" ? 2 : 1}M`);
				await terminal.waitForRender();
				assert.ok((await terminal.flushAndGetViewport()).some((line) => line.includes("HOVERED")));
				if (scenario === "nested layout" || scenario === "box layout") {
					parent.children.unshift(new Text("inserted", 0, 0));
					tui.requestRender();
				} else if (scenario === "overlay resize") terminal.resize(20, 8);
				else if (scenario === "overlay hide") overlay?.hide();
				else if (scenario === "overlay hidden") overlay?.setHidden(true);
				else if (scenario === "scroll clipping") tui.scrollBy(1);
				else tui.setLayoutRoot(new Text("replacement", 0, 0));
				await terminal.waitForRender();
				assert.equal(events.filter((event) => event.type === "leave").length, 1);
				assert.ok(!(await terminal.flushAndGetViewport()).some((line) => line.includes("HOVERED")));
				tui.requestRender();
				await terminal.waitForRender();
				assert.deepEqual(
					events.map((event) => event.type),
					["move", "leave"],
				);
			} finally {
				tui.stop();
			}
		});
	}

	it("reconciles overlay stacking without sending moves to the newly exposed target", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const events: TuiMouseEvent[] = [];
		const covered = tui.showOverlay(control(events), { anchor: "top-left", width: 10, nonCapturing: true });
		const front = tui.showOverlay(new Text("cover", 0, 0), { anchor: "top-left", width: 10, nonCapturing: true });
		covered.focus();
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<35;2;1M");
			front.focus();
			await terminal.waitForRender();
			assert.deepEqual(
				events.map((event) => event.type),
				["move", "leave"],
			);
			front.hide();
			await terminal.waitForRender();
			assert.deepEqual(
				events.map((event) => event.type),
				["move", "leave"],
			);
			terminal.sendInput("\x1b[<35;2;1M");
			covered.setHidden(true);
			await terminal.waitForRender();
			covered.setHidden(false);
			await terminal.waitForRender();
			assert.deepEqual(
				events.map((event) => event.type),
				["move", "leave", "move", "leave"],
			);
		} finally {
			tui.stop();
		}
	});

	it("preserves the same owner through unrelated layout and content changes", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const events: string[] = [];
		const content = new Container();
		content.addChild(new Text("control", 0, 0));
		const owner = new MouseRegion(content, (event) => {
			events.push(event.type);
			return { handled: true, render: false };
		});
		const sibling = new Text("tail", 0, 0);
		const parent = new Box(1, 1);
		parent.addChild(owner);
		parent.addChild(sibling);
		tui.addChild(parent);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<35;2;2M");
			content.clear();
			content.addChild(new Text("new content", 0, 0));
			sibling.setText("tail\nmore");
			tui.requestRender();
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<0;2;2M");
			terminal.sendInput("\x1b[<32;3;2M");
			terminal.sendInput("\x1b[<0;3;2m");
			assert.deepEqual(events, ["move", "press", "drag", "release"]);
			tui.stop();
			assert.deepEqual(events, ["move", "press", "drag", "release", "leave"]);
		} finally {
			tui.stop();
		}
	});

	it("repaints only when leave explicitly requests it, ignoring focus and capture", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		let hovered = false;
		let renders = 0;
		const events: TuiMouseEvent[] = [];
		const target: Component = {
			render() {
				renders++;
				return [hovered ? "HOVERED" : "control"];
			},
			invalidate() {},
			handleMouse(event) {
				events.push(event);
				if (event.type === "move") hovered = true;
				if (event.type === "leave") hovered = false;
				return { handled: true, render: true, focus: event.type === "leave", capture: event.type === "leave" };
			},
		};
		tui.addChild(target);
		tui.start();
		try {
			await terminal.waitForRender();
			terminal.sendInput("\x1b[<35;2;1M");
			await terminal.waitForRender();
			assert.match((await terminal.flushAndGetViewport())[0], /HOVERED/);
			terminal.sendInput("\x1b[<35;2;4M");
			await terminal.waitForRender();
			assert.match((await terminal.flushAndGetViewport())[0], /control/);
			assert.equal(tui.getFocusedComponent(), null);
			const before = renders;
			terminal.sendInput("\x1b[<35;2;5M");
			await terminal.waitForRender();
			assert.equal(renders, before);
			assert.deepEqual(
				events.map((event) => event.type),
				["move", "leave"],
			);
		} finally {
			tui.stop();
		}
	});

	for (const handled of [false, true]) {
		it(`does not add renders for non-hover handlers, handled=${handled}`, async () => {
			const terminal = new VirtualTerminal(20, 6);
			const tui = new TuiAltScreen(terminal);
			let renders = 0;
			const events: string[] = [];
			tui.addChild({
				render() {
					renders++;
					return ["control"];
				},
				invalidate() {},
				handleMouse(event) {
					events.push(event.type);
					return handled ? { handled: true } : undefined;
				},
			});
			tui.start();
			try {
				await terminal.waitForRender();
				const before = renders;
				for (const input of ["\x1b[<35;2;1M", "\x1b[<35;3;1M", "\x1b[<35;2;4M", "x", "\x1b[O"])
					terminal.sendInput(input);
				await terminal.waitForRender();
				assert.equal(renders, before);
				assert.deepEqual(events, handled ? ["move", "move", "leave"] : ["move", "move"]);
			} finally {
				tui.stop();
			}
		});
	}

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
			assert.deepEqual(
				events.map((e) => e.type),
				["move", "leave"],
			);
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
