import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { Text } from "../src/components/text.ts";
import { ListMouse, type ListMouseOptions } from "../src/index.ts";
import { type Component, Container, type TuiMouseEvent, type TuiMouseEventResult } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function mouse(type: TuiMouseEvent["type"], extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 1,
		y: 1,
		screenX: 1,
		screenY: 1,
		width: 30,
		height: 8,
		shift: false,
		alt: false,
		ctrl: false,
		...extra,
	};
}
function fixture(options: Partial<ListMouseOptions<string>> = {}) {
	const selected: string[] = [];
	const activated: string[] = [];
	const list = new ListMouse<string>({
		select: (key) => selected.push(key),
		activate: (key) => {
			activated.push(key);
			return true;
		},
		...options,
	});
	list.beginRows();
	list.addRow("A", 1, 2);
	list.addRow("B", 4);
	return { list, selected, activated };
}

class ManualList implements Component {
	keys = ["A", "B"];
	enabled = true;
	selected: string[] = [];
	activated: string[] = [];
	events: TuiMouseEvent[] = [];
	mouse = new ListMouse<string>({
		select: (key) => this.selected.push(key),
		activate: (key) => {
			if (!this.keys.includes(key)) return false;
			this.activated.push(key);
			return true;
		},
		enabled: () => this.enabled,
	});
	render(): string[] {
		this.mouse.beginRows();
		for (const [y, key] of this.keys.entries()) this.mouse.addRow(key, y);
		return this.keys;
	}
	invalidate(): void {}
	handleInput(): void {
		this.enabled = true;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		this.events.push(event);
		return this.mouse.handle(event);
	}
}
function renderer(t: TestContext, component: Component) {
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

describe("ListMouse", () => {
	it("selects on press without activating, then activates once and closes", () => {
		const { list, selected, activated } = fixture();
		assert.deepEqual(list.handle(mouse("press")), { handled: true, focus: true });
		assert.deepEqual(selected, ["A"]);
		assert.deepEqual(activated, []);
		assert.deepEqual(list.handle(mouse("click", { clickSource: "captured" })), { handled: true });
		assert.equal(list.closed, true);
		assert.deepEqual(activated, ["A"]);
		for (const type of ["press", "click", "wheel"] as const)
			assert.equal(list.handle(mouse(type, { wheelDelta: 1 })), undefined);
		list.close();
		assert.equal(list.closed, true);
	});
	it("can remain open for repeated activations", () => {
		const { list, activated } = fixture({ closeOnActivate: false });
		for (let i = 0; i < 2; i++) {
			list.handle(mouse("press"));
			list.handle(mouse("click", { clickSource: "captured" }));
		}
		assert.deepEqual(activated, ["A", "A"]);
		assert.equal(list.closed, false);
	});
	it("renderer gesture ids cannot use the trusted direct-event idle-click exception", () => {
		const { list, selected, activated } = fixture();
		assert.equal(list.handle(mouse("click", { gestureId: 1 })), undefined);
		list.handle(mouse("press"));
		assert.equal(list.handle(mouse("click", { gestureId: 2, clickSource: "captured" })), undefined);
		assert.deepEqual(selected, ["A"]);
		assert.deepEqual(activated, []);
		// Omitting gestureId preserves trusted direct-event behavior.
		list.handle(mouse("click"));
		assert.deepEqual(activated, ["A"]);
	});
	for (const enabled of [true, false]) {
		it(`mismatched gesture ids clear stale keys/zones even when enabled=${enabled}`, () => {
			let ready = true;
			const zones: string[] = [];
			const { list, selected, activated } = fixture({
				enabled: () => ready,
				zoneClick: (key) => zones.push(key),
			});
			list.beginRows();
			list.addRow("A", 1, 1, [{ name: "fold", x: 0, width: 3 }]);
			list.handle(mouse("press", { gestureId: 1 }));
			ready = enabled;
			assert.equal(list.handle(mouse("click", { gestureId: 2, clickSource: "captured" })), undefined);
			ready = true;
			assert.equal(list.handle(mouse("click", { gestureId: 1, clickSource: "captured" })), undefined);
			assert.deepEqual(selected, ["A"]);
			assert.deepEqual([activated, zones], [[], []]);
			list.handle(mouse("press", { gestureId: 3 }));
			list.handle(mouse("click", { gestureId: 3, clickSource: "captured" }));
			assert.deepEqual(zones, ["A"]);
		});
	}
	it("keeps press-time zones and never closes for zone clicks", () => {
		const zones: string[] = [];
		const { list, activated } = fixture({ zoneClick: (key, zone) => zones.push(`${key}:${zone}`) });
		list.beginRows();
		list.addRow("A", 1, 1, [{ name: "fold", x: 1, width: 1 }]);
		assert.deepEqual(list.hitTest(1, 1), { key: "A", zone: "fold" });
		assert.deepEqual(list.hitTest(2, 1), { key: "A" });
		list.handle(mouse("press"));
		list.beginRows();
		list.addRow("B", 1);
		list.handle(mouse("click", { clickSource: "captured" }));
		assert.deepEqual(zones, ["A:fold"]);
		assert.deepEqual(activated, []);
		assert.equal(list.closed, false);
	});
	it("an invalidated key does not close a still-visible list; the following B click works", () => {
		const acted: string[] = [];
		let keys = ["A", "B"];
		const { list } = fixture({
			activate: (key) => {
				if (!keys.includes(key)) return false;
				acted.push(key);
				return true;
			},
		});
		list.handle(mouse("press"));
		keys = ["B"];
		list.beginRows();
		list.addRow("B", 1);
		list.handle(mouse("click", { clickSource: "captured" }));
		assert.equal(list.closed, false);
		assert.deepEqual(acted, []);
		list.handle(mouse("press"));
		list.handle(mouse("click", { clickSource: "captured" }));
		assert.deepEqual(acted, ["B"]);
		assert.equal(list.closed, true);
	});
	it("ignores disabled events without recording a press", () => {
		let enabled = false;
		const { list, selected, activated } = fixture({ enabled: () => enabled, step: () => true });
		for (const type of ["press", "click", "wheel"] as const)
			assert.equal(list.handle(mouse(type, { wheelDelta: 1 })), undefined);
		enabled = true;
		assert.equal(list.handle(mouse("click", { clickSource: "captured" })), undefined);
		assert.deepEqual(selected, []);
		assert.deepEqual(activated, []);
		list.handle(mouse("press"));
		list.handle(mouse("click", { clickSource: "captured" }));
		assert.deepEqual(activated, ["A"]);
	});
	it("allows only undefined-source idle clicks to select then activate", () => {
		const log: string[] = [];
		const { list } = fixture({
			select: (key) => log.push(`select:${key}`),
			activate: (key) => {
				log.push(`activate:${key}`);
				return true;
			},
		});
		assert.equal(list.handle(mouse("click", { clickSource: "captured" })), undefined);
		list.handle(mouse("click"));
		assert.deepEqual(log, ["select:A", "activate:A"]);
	});
	for (const enabled of [true, false]) {
		it(`fallback click clears stale pressed state even when enabled=${enabled}`, () => {
			let ready = true;
			const { list, activated } = fixture({ enabled: () => ready });
			list.handle(mouse("press"));
			ready = enabled;
			assert.equal(list.handle(mouse("click", { clickSource: "fallback" })), undefined);
			ready = true;
			assert.equal(list.handle(mouse("click", { clickSource: "captured" })), undefined);
			assert.deepEqual(activated, []);
		});
	}
	it("fallback zone clicks never select, toggle or close, regardless of click count", () => {
		const zones: string[] = [];
		const { list, selected, activated } = fixture({ zoneClick: (key) => zones.push(key) });
		list.beginRows();
		list.addRow("A", 1, 1, [{ name: "fold", x: 0, width: 3 }]);
		for (const clickCount of [1, 2, 3])
			assert.equal(list.handle(mouse("click", { clickSource: "fallback", clickCount })), undefined);
		assert.deepEqual([selected, activated, zones], [[], [], []]);
		assert.equal(list.closed, false);
	});
	it("ignores non-left buttons, release, drag, move, leave and missing rows", () => {
		const { list, activated } = fixture();
		for (const button of ["right", "middle", "none"] as const)
			for (const type of ["press", "click"] as const) assert.equal(list.handle(mouse(type, { button })), undefined);
		for (const type of ["release", "drag", "move", "leave"] as const)
			assert.equal(list.handle(mouse(type)), undefined);
		assert.equal(list.handle(mouse("press", { y: 0 })), undefined);
		assert.equal(list.handle(mouse("click", { y: 0 })), undefined);
		assert.equal(list.hitTest(1, 3), undefined);
		assert.deepEqual(list.hitTest(1, 2), { key: "A" });
		assert.deepEqual(activated, []);
	});
	it("steps by wheel sign only inside the clipped item-area, including separators", () => {
		const steps: number[] = [];
		let clipped = true;
		let changed = true;
		const { list } = fixture({
			step: (direction) => {
				steps.push(direction);
				return changed;
			},
			ownsWheel: () => clipped,
		});
		for (const y of [0, 5]) assert.equal(list.handle(mouse("wheel", { y, wheelDelta: 5 })), undefined);
		assert.deepEqual(list.handle(mouse("wheel", { y: 3, wheelDelta: -5 })), { handled: true, render: true });
		changed = false;
		assert.deepEqual(list.handle(mouse("wheel", { wheelDelta: 5 })), { handled: true, render: false });
		clipped = false;
		assert.equal(list.handle(mouse("wheel", { wheelDelta: 1 })), undefined);
		clipped = true;
		assert.equal(list.handle(mouse("wheel", { wheelDelta: 0 })), undefined);
		assert.equal(list.handle(mouse("wheel")), undefined);
		assert.deepEqual(steps, [-1, 1]);
		list.beginRows();
		assert.equal(list.handle(mouse("wheel", { wheelDelta: 1 })), undefined);
	});
	it("does not own the wheel without step, and defaults ownsWheel to true with step", () => {
		assert.equal(fixture().list.handle(mouse("wheel", { wheelDelta: 1 })), undefined);
		assert.deepEqual(fixture({ step: () => true }).list.handle(mouse("wheel", { wheelDelta: 1 })), {
			handled: true,
			render: true,
		});
	});
});

describe("ListMouse through real fullscreen dispatch", () => {
	it("captured press→release activates once with captured provenance", (t) => {
		const list = new ManualList();
		const { send } = renderer(t, list);
		send(press);
		send(release);
		assert.deepEqual(list.activated, ["A"]);
		assert.equal(list.events.find((e) => e.type === "click")?.clickSource, "captured");
	});
	for (const key of ["\x1b", "\r"]) {
		it(`press→${key === "\r" ? "Enter" : "Esc"}→release cannot activate`, (t) => {
			const list = new ManualList();
			const { send } = renderer(t, list);
			send(press);
			send(key);
			send(release);
			assert.deepEqual(list.activated, []);
		});
	}
	it("press→keyboard Enter activation→release acts only once", (t) => {
		class KeyboardList extends ManualList {
			override handleInput(): void {
				this.activated.push(this.keys[0]);
			}
		}
		const list = new KeyboardList();
		const { send } = renderer(t, list);
		send(press);
		send("\r");
		send(release);
		assert.deepEqual(list.activated, ["A"]);
	});
	it("a captured click cannot idle-activate a replacement helper behind the same target", (t) => {
		const list = new ManualList();
		const { send } = renderer(t, list);
		send(press);
		list.mouse = new ListMouse<string>({
			select: () => {},
			activate: (key) => {
				list.activated.push(key);
				return true;
			},
		});
		list.render();
		send(release);
		assert.deepEqual(list.activated, []);
	});
	it("disabled press→Esc→release ignores the fallback click", (t) => {
		const list = new ManualList();
		list.enabled = false;
		const { send } = renderer(t, list);
		send(press);
		send("\x1b");
		send(release);
		assert.equal(list.enabled, true);
		assert.deepEqual(list.activated, []);
		assert.deepEqual(list.selected, []);
		assert.equal(list.events.find((e) => e.type === "click")?.clickSource, "fallback");
	});
	it("disabled press→enabled before release cannot activate", (t) => {
		const list = new ManualList();
		list.enabled = false;
		const { send } = renderer(t, list);
		send(press);
		list.enabled = true;
		send(release);
		assert.deepEqual(list.activated, []);
		send(press);
		send(release);
		assert.deepEqual(list.activated, ["A"]);
	});
	it("unhandled press→focused replacement ListMouse→release ignores fallback", (t) => {
		const { tui, send } = renderer(t, new Text("inert", 0, 0));
		send(press);
		const list = new ManualList();
		tui.clear();
		tui.addChild(list);
		tui.setFocus(list);
		tui.renderNow();
		send(release);
		assert.deepEqual(list.activated, []);
		assert.deepEqual(list.selected, []);
		assert.equal(list.events.find((e) => e.type === "click")?.clickSource, "fallback");
	});
	it("stale pressed state + real fallback click is cleared rather than activated", (t) => {
		const list = new ManualList();
		const { send } = renderer(t, list);
		send(press);
		send("x");
		send(release); // Renderer voids the gesture; helper still has A.
		list.enabled = false;
		send(press);
		list.enabled = true;
		send(release);
		assert.deepEqual(list.activated, []);
		assert.equal(list.mouse.handle(mouse("click", { clickSource: "captured", y: 0 })), undefined);
		send(press);
		send(release);
		assert.deepEqual(list.activated, ["A"]);
	});
	for (const cancel of ["key", "drag"] as const) {
		it(`a ${cancel}-cancelled press cannot activate on a later captured click whose press bypassed ListMouse`, (t) => {
			class SplitList extends ManualList {
				override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					// An input/zone inside this same dispatch target accepts its own presses.
					if (event.type === "press" && event.x >= 10) {
						this.events.push(event);
						return { handled: true, focus: true };
					}
					return super.handleMouse(event);
				}
			}
			const list = new SplitList();
			const { send } = renderer(t, list);
			send(press);
			if (cancel === "key") send("x");
			else send("\x1b[<32;3;1M");
			send(release);
			assert.deepEqual(list.activated, []);
			send("\x1b[<0;12;1M");
			send("\x1b[<0;12;1m");
			assert.equal(list.events.find((e) => e.type === "click")?.clickSource, "captured");
			assert.deepEqual(list.activated, []);
			assert.equal(list.mouse.closed, false);
			// Mismatch must discard the stale key even for trusted direct-event callers.
			assert.equal(list.mouse.handle(mouse("click", { clickSource: "captured", y: 0 })), undefined);
			send(press);
			send(release);
			send(release);
			assert.deepEqual(list.activated, ["A"]);
		});
	}
	it("reordering during a held press activates the original key", (t) => {
		const list = new ManualList();
		const { tui, send } = renderer(t, list);
		send(press);
		list.keys = ["B", "A"];
		tui.renderNow();
		send(release);
		assert.deepEqual(list.activated, ["A"]);
	});
	it("dragging away and back cancels activation; the next press overwrites stale state", (t) => {
		const list = new ManualList();
		const { send } = renderer(t, list);
		send(press);
		send("\x1b[<32;3;1M");
		send("\x1b[<32;2;1M");
		send(release);
		assert.deepEqual(list.activated, []);
		send(press);
		send(release);
		assert.deepEqual(list.activated, ["A"]);
	});
	it("region rows retain their key/zone across reconstruction and keep wrapped rendering", (t) => {
		const selected: string[] = [];
		const zones: string[] = [];
		const activated: string[] = [];
		const mouse = new ListMouse<string>({
			select: (key) => {
				selected.push(key);
				rebuild();
			},
			activate: (key) => {
				activated.push(key);
				return true;
			},
			zoneClick: (key, zone) => zones.push(`${key}:${zone}`),
		});
		class Host extends Container {
			handleInput(): void {}
		}
		const host = new Host();
		function rebuild() {
			host.clear();
			host.addChild(mouse.row("A", new Text("line one\nline two", 0, 0), [{ name: "fold", x: 1, width: 1 }]));
		}
		rebuild();
		const { tui, send } = renderer(t, host);
		assert.deepEqual(host.render(30), new Text("line one\nline two", 0, 0).render(30));
		send("\x1b[<0;2;2M");
		tui.renderNow();
		send("\x1b[<0;2;2m");
		assert.deepEqual(selected, ["A"]);
		assert.deepEqual(zones, ["A:fold"]);
		assert.deepEqual(activated, []);
		assert.equal(mouse.closed, false);
		assert.equal(tui.getFocusedComponent(), host);
	});
	it("region wheel stays within row bounds and requires a clipped list", () => {
		let clipped = true;
		const helper = new ListMouse<string>({
			select: () => {},
			activate: () => true,
			step: () => false,
			ownsWheel: () => clipped,
		});
		const row = helper.row("A", new Text("A", 0, 0));
		row.render(30);
		assert.deepEqual(row.handleMouse(mouseEvent(0)), { handled: true, render: false });
		for (const y of [-1, 1]) assert.equal(row.handleMouse(mouseEvent(y)), undefined);
		clipped = false;
		assert.equal(row.handleMouse(mouseEvent(0)), undefined);
		function mouseEvent(y: number) {
			return mouse("wheel", { y, height: 1, wheelDelta: 1 });
		}
	});
});
