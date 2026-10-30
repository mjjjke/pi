import { type Container, Input, setKeybindings, setPointerHoverBackground, type TUI } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { models, mouse } from "./helpers/selector-mouse.ts";

vi.mock("../src/modes/interactive/model-catalog-refresh.ts", () => ({
	refreshModelCatalogs: vi.fn(() => new Promise(() => {})),
}));

const hover = "\x1b[48;5;235m";
const surfaces = ["extension", "model", "scoped", "OAuth", "trust"] as const;
function create(surface: (typeof surfaces)[number], count = 15) {
	const activated = vi.fn();
	let selector: Container & { handleInput(data: string): void };
	let dispose = () => {};
	let row = "model-01";
	if (surface === "extension") {
		selector = new ExtensionSelectorComponent(
			"Choose",
			models(count).map((item) => item.id),
			activated,
			vi.fn(),
		);
	} else if (surface === "model") {
		const component = new ModelSelectorComponent(
			{ requestRender() {} } as unknown as TUI,
			undefined,
			{ getAvailableSnapshot: () => models(count) } as unknown as ModelRuntime,
			[],
			activated,
			vi.fn(),
		);
		selector = component;
		dispose = () => component.dispose();
	} else if (surface === "scoped") {
		selector = new ScopedModelsSelectorComponent(
			{ allModels: models(count), enabledModelIds: null },
			{ onChange: activated, onPersist: vi.fn(), onCancel: vi.fn() },
		);
	} else if (surface === "OAuth") {
		selector = new OAuthSelectorComponent(
			"logout",
			models(count).map((item) => ({
				id: item.id,
				name: item.id,
				authType: "oauth",
			})),
			activated,
			vi.fn(),
		);
	} else {
		row = "Trust parent folder";
		selector = new TrustSelectorComponent({
			cwd: "/project",
			savedDecision: null,
			projectTrusted: false,
			onSelect: activated,
			onCancel: vi.fn(),
		});
	}
	return { selector, row, activated, dispose };
}

async function backgrounds(lines: string[], width = 80) {
	const terminal = new xterm.Terminal({ cols: width, rows: lines.length + 1, allowProposedApi: true });
	try {
		await new Promise<void>((resolve) => terminal.write(lines.map((line) => `${line}\x1b[0m`).join("\r\n"), resolve));
		return lines.map((_, y) =>
			Array.from({ length: width }, (_, x) => {
				const cell = terminal.buffer.active.getLine(y)!.getCell(x)!;
				return cell.isBgDefault() ? undefined : cell.getBgColor();
			}),
		);
	} finally {
		terminal.dispose();
	}
}

// Inspect only cache liveness; event admission and paint are exercised through public APIs.
function cache(selector: Container) {
	return (selector as unknown as { mouse: { regions: Map<unknown, unknown> } }).mouse.regions;
}

describe("region selector hover", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	beforeEach(() => setPointerHoverBackground(() => hover));
	afterEach(() => {
		setPointerHoverBackground(undefined);
		vi.useRealTimers();
	});

	for (const surface of surfaces) {
		it(`${surface}: paints only the unselected actionable footprint and leaves keyboard state unchanged`, async () => {
			const f = create(surface);
			try {
				const before = f.selector.render(80);
				const selected = before.map(stripAnsi).find((line) => line.includes("→"))!;
				const move = mouse(f.selector, f.row, { type: "move", button: "none" });
				expect(move).toMatchObject({ handled: true, pointerShape: "pointer" });
				expect(move?.focus).not.toBe(true);
				expect(move?.focusTarget).toBeUndefined();
				expect(move?.hoverValid?.()).toBe(true);
				const lines = f.selector.render(80);
				const y = lines.map(stripAnsi).findIndex((line) => line.includes(f.row));
				const cells = await backgrounds(lines);
				for (let i = 0; i < cells.length; i++) {
					expect(cells[i], `row ${i}`).toEqual(Array(80).fill(i === y ? 235 : undefined));
				}
				expect(lines.map(stripAnsi).find((line) => line.includes("→"))).toBe(selected);
				expect(f.activated).not.toHaveBeenCalled();
				mouse(f.selector, f.row, { type: "leave", button: "none" });
				expect(move?.hoverValid?.()).toBe(false);
				expect(f.selector.render(80)).toEqual(before);
				const selectedMove = mouse(f.selector, selected.trim(), { type: "move", button: "none" });
				expect(selectedMove?.pointerShape).toBe("pointer");
				expect(f.selector.render(80)).toEqual(before);
				mouse(f.selector, selected.trim(), { type: "leave", button: "none" });
				// Titles, counters, hints, previews and the input are never actionable hover targets.
				for (const line of before
					.map(stripAnsi)
					.filter(
						(line) =>
							line.trim() && !line.includes("model-") && !line.includes("Trust") && !line.includes("trust"),
					)) {
					expect(mouse(f.selector, line.trim(), { type: "move", button: "none" })?.pointerShape).toBeUndefined();
				}
			} finally {
				f.dispose();
			}
		});

		it(`${surface}: keys and owned wheels end the episode without reviving it on measurement`, () => {
			const f = create(surface);
			try {
				const move = mouse(f.selector, f.row, { type: "move", button: "none" });
				f.selector.handleInput?.("\x1b[B");
				expect(move?.hoverValid?.()).toBe(false);
				expect(f.selector.render(80).join("")).not.toContain(hover);
				if (surface !== "trust") {
					const next = mouse(f.selector, "model-02", { type: "move", button: "none" });
					expect(mouse(f.selector, "model-02", { type: "wheel", wheelDelta: 1 })?.handled).toBe(true);
					expect(next?.hoverValid?.()).toBe(false);
				}
				const zeroWidth = mouse(f.selector, f.row, { type: "move", button: "none" });
				f.selector.render(0);
				expect(zeroWidth?.hoverValid?.()).toBe(false);
				f.selector.render(80);
				expect(f.selector.render(80).join("")).not.toContain(hover);
				const keys = [...cache(f.selector).values()];
				f.selector.render(40);
				f.selector.render(80);
				const measured = [...cache(f.selector).values()];
				expect(measured).toHaveLength(keys.length);
				for (let i = 0; i < keys.length; i++) expect(measured[i]).toBe(keys[i]);
				expect(f.activated).not.toHaveBeenCalled();
			} finally {
				f.dispose();
			}
		});
	}

	for (const surface of ["model", "scoped", "OAuth"] as const) {
		it(`${surface}: empty filter commits an empty cache; restoration cannot revive hover`, () => {
			const f = create(surface, 3);
			try {
				const move = mouse(f.selector, f.row, { type: "move", button: "none" });
				const input = f.selector.children.find((child) => child instanceof Input) as Input;
				input.setValue("no-match-xyz");
				f.selector.handleInput?.("");
				expect(cache(f.selector).size).toBe(0);
				expect(move?.hoverValid?.()).toBe(false);
				input.setValue("");
				f.selector.handleInput?.("");
				expect(cache(f.selector).size).toBe(3);
				expect(f.selector.render(80).join("")).not.toContain(hover);
				expect(move?.hoverValid?.()).toBe(false);
			} finally {
				f.dispose();
			}
		});
	}

	it("refresh under a stationary pointer clears hover rather than transferring it; disjoint builds prune", () => {
		const f = create("scoped", 3);
		const selector = f.selector as ScopedModelsSelectorComponent;
		const terminal = new VirtualTerminal(80, 40);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(selector);
		tui.setFocus(selector);
		tui.start();
		try {
			tui.renderNow();
			const y = tui
				.getScreenLines()
				.map(stripAnsi)
				.findIndex((line) => line.includes("model-01"));
			terminal.sendInput(`\x1b[<35;5;${y + 1}M`);
			tui.renderNow();
			expect(tui.getScreenLines().join("")).toContain(hover);
			selector.updateModels(models(3).toReversed());
			tui.renderNow();
			// Reversal leaves the middle row in place, so stable region identity retains hover.
			expect(tui.getScreenLines().join("")).toContain(hover);
			selector.updateModels([models(3)[1], models(3)[0], models(3)[2]]);
			tui.renderNow();
			expect(tui.getScreenLines().join("")).not.toContain(hover);
			for (let i = 0; i < 20; i++) {
				selector.updateModels([{ ...models(1)[0], id: `fresh-${i}` }]);
				expect(cache(selector).size).toBe(1);
			}
		} finally {
			tui.stop();
		}
	});

	it("wrapped options paint every child line, but never the description or hints", async () => {
		const selector = new ExtensionSelectorComponent(
			"Choose",
			["Yes", "A long option wrapping onto TARGET"],
			vi.fn(),
			vi.fn(),
			{
				description: "A wrapped description that is never clickable",
			},
		);
		mouse(selector, "TARGET", { type: "move", button: "none" }, 24);
		const lines = selector.render(24);
		const cells = await backgrounds(lines, 24);
		const start = lines.map(stripAnsi).findIndex((line) => line.includes("A long"));
		const end = lines.map(stripAnsi).findIndex((line) => line.includes("TARGET"));
		expect(end).toBeGreaterThan(start);
		for (let y = 0; y < lines.length; y++) {
			expect(cells[y]).toEqual(Array(24).fill(y >= start && y <= end ? 235 : undefined));
		}
	});

	it("empty refresh invalidates even selected hover without a provider and preserves held-key admission", () => {
		setPointerHoverBackground(undefined);
		const f = create("scoped", 3);
		const selector = f.selector as ScopedModelsSelectorComponent;
		mouse(selector, "model-01", { type: "press", gestureId: 1 });
		const move = mouse(selector, "model-01", { type: "move", button: "none" });
		selector.updateModels([]);
		expect(cache(selector).size).toBe(0);
		expect(move?.hoverValid?.()).toBe(false);
		selector.updateModels([models(3)[2]]);
		mouse(selector, "model-02", { clickSource: "captured", gestureId: 1 });
		expect(f.activated).not.toHaveBeenCalled();
		mouse(selector, "model-02", { type: "press", gestureId: 2 });
		selector.handleInput("\x1b[B");
		mouse(selector, "model-02", { clickSource: "captured", gestureId: 3 });
		expect(f.activated).not.toHaveBeenCalled();
		mouse(selector, "model-02", { type: "press", gestureId: 4 });
		mouse(selector, "model-02", { clickSource: "captured", gestureId: 4 });
		expect(f.activated).toHaveBeenCalledOnce();
	});

	it("logout confirmation hover does not bypass its 500 ms mouse arming delay or delay keyboard confirmation", () => {
		vi.useFakeTimers();
		const selected = vi.fn();
		const selector = new ExtensionSelectorComponent("Logout provider?", ["Yes", "No"], selected, vi.fn(), {
			mouseDelayMs: 500,
		});
		expect(mouse(selector, "No", { type: "move", button: "none" })).toBeUndefined();
		expect(mouse(selector, "Yes", { type: "press" })).toBeUndefined();
		vi.advanceTimersByTime(500);
		mouse(selector, "Yes", { clickSource: "captured" });
		expect(selected).not.toHaveBeenCalled();
		expect(mouse(selector, "No", { type: "move", button: "none" })?.pointerShape).toBe("pointer");
		expect(selector.render(80).join("")).toContain(hover);
		expect(selected).not.toHaveBeenCalled();
		selector.handleInput("\r");
		expect(selected).toHaveBeenCalledExactlyOnceWith("Yes");
		const immediate = new ExtensionSelectorComponent("Logout?", ["Yes", "No"], selected, vi.fn(), {
			mouseDelayMs: 500,
		});
		immediate.handleInput("\r");
		expect(selected).toHaveBeenCalledTimes(2);
	});
});
