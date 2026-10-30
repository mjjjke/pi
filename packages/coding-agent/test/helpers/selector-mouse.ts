import type { Model } from "@earendil-works/pi-ai";
import { type Container, Input, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { TuiAltScreen } from "../../../tui/src/tui-alt-screen.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

export function models(count = 15): Model<"openai-completions">[] {
	return Array.from({ length: count }, (_, i) => ({
		id: `model-${String(i).padStart(2, "0")}`,
		name: `Name ${i}`,
		provider: "fake",
		api: "openai-completions",
		baseUrl: "https://invalid.example",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	}));
}

export function mouse(selector: Container, label: string, event: Partial<TuiMouseEvent> = {}, width = 80) {
	const lines = selector.render(width).map(stripAnsi);
	const y = lines.findIndex((line) => line.includes(label));
	expect(y, label).toBeGreaterThanOrEqual(0);
	return selector.handleMouse({
		type: "click",
		button: "left",
		x: 4,
		y,
		screenX: 4,
		screenY: y,
		width,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
		...event,
	});
}

export function mouseContract(
	create: (count: number) => {
		selector: Container;
		selected: () => number;
		cancelled: () => number;
		dispose?: () => void;
	},
	row = "model-01",
	inert = "Model Name",
	clipped = true,
) {
	it("press highlights with parent focus; captured click acts once", () => {
		const f = create(3);
		try {
			expect(mouse(f.selector, row, { type: "press" })?.focusTarget).toBe(f.selector);
			expect(f.selected()).toBe(0);
			expect(
				f.selector
					.render(80)
					.map(stripAnsi)
					.find((line) => line.includes("→")),
			).toContain(row);
			mouse(f.selector, row, { clickSource: "captured" });
			expect(f.selected()).toBe(1);
			mouse(f.selector, row, { clickSource: "captured" });
			expect(f.selected()).toBe(1);
		} finally {
			f.dispose?.();
		}
	});
	it("keeps focus for typing and Esc after a press, and voids the held click", () => {
		const f = create(3);
		const terminal = new VirtualTerminal(80, 40);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(f.selector);
		tui.setFocus(f.selector);
		tui.start();
		tui.renderNow();
		try {
			const y =
				tui
					.getScreenLines()
					.map(stripAnsi)
					.findIndex((line) => line.includes(row)) + 1;
			expect(y).toBeGreaterThan(0);
			terminal.sendInput(`\x1b[<0;4;${y}M`);
			const input = f.selector.children.find((child) => child instanceof Input);
			if (input instanceof Input) {
				terminal.sendInput("z");
				expect(input.getValue()).toBe("z");
			}
			terminal.sendInput("\x1b");
			terminal.sendInput(`\x1b[<0;4;${y}m`);
			expect(f.cancelled()).toBe(1);
			expect(f.selected()).toBe(0);
		} finally {
			f.dispose?.();
			tui.stop();
		}
	});
	it("ignores fallback clicks, other buttons, drag/release and inert lines", () => {
		const f = create(3);
		try {
			for (const type of ["release", "drag"] as const) expect(mouse(f.selector, row, { type })).toBeUndefined();
			const beforeHover = f.selector.render(80);
			for (const type of ["move", "leave"] as const) {
				const result = mouse(f.selector, row, { type });
				expect(result?.handled).toBe(true);
				expect(result?.focus).not.toBe(true);
				expect(result?.focusTarget).toBeUndefined();
				expect(result?.capture).not.toBe(true);
				expect(f.selector.render(80)).toEqual(beforeHover);
				expect(f.selected()).toBe(0);
				expect(f.cancelled()).toBe(0);
			}
			for (const button of ["right", "middle"] as const) expect(mouse(f.selector, row, { button })).toBeUndefined();
			expect(mouse(f.selector, row, { clickSource: "fallback" })).toBeUndefined();
			expect(mouse(f.selector, inert)).toBeUndefined();
			expect(mouse(f.selector, inert, { type: "wheel", wheelDelta: 1 })).toBeUndefined();
			expect(f.selected()).toBe(0);
		} finally {
			f.dispose?.();
		}
	});
	it("wheel falls through on short lists and non-item lines", () => {
		const f = create(3);
		try {
			expect(mouse(f.selector, row, { type: "wheel", wheelDelta: 1 })).toBeUndefined();
		} finally {
			f.dispose?.();
		}
	});
	if (clipped)
		it("clipped wheel steps one item, clamps, and excludes counters", () => {
			const f = create(15);
			try {
				for (let i = 0; i < 16; i++) {
					const label = f.selector
						.render(80)
						.map(stripAnsi)
						.find((line) => line.includes("→") && line.includes("model-"))!
						.trim();
					expect(mouse(f.selector, label, { type: "wheel", wheelDelta: 9 })?.handled).toBe(true);
					expect(
						f.selector
							.render(80)
							.map(stripAnsi)
							.find((line) => line.includes("→")),
					).toContain(`model-${String(Math.min(i + 1, 14)).padStart(2, "0")}`);
				}
				expect(mouse(f.selector, "model-14", { type: "wheel", wheelDelta: 1 })?.render).toBe(false);
				expect(mouse(f.selector, "(15/15)", { type: "wheel", wheelDelta: -1 })).toBeUndefined();
				expect(f.selected()).toBe(0);
			} finally {
				f.dispose?.();
			}
		});
}
