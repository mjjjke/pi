import { setKeybindings, setPointerHoverBackground, stripTerminalSequences } from "@earendil-works/pi-tui";
import xterm from "@xterm/headless";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo, SessionTreeNode } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { mouse } from "./helpers/selector-mouse.ts";

const hover = "\x1b[48;5;235m";
const surfaces = ["fork", "resume", "tree"] as const;
function node(id: string, parentId: string | null, children: SessionTreeNode[] = []): SessionTreeNode {
	return {
		entry: {
			type: "message",
			id,
			parentId,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: id, timestamp: 0 },
		},
		children,
	};
}

async function create(surface: (typeof surfaces)[number], count = 15) {
	const activated = vi.fn();
	const cancelled = vi.fn();
	const messages = Array.from({ length: count }, (_, i) => ({
		id: `entry-${String(i).padStart(2, "0")}`,
		text: `entry-${String(i).padStart(2, "0")} 界e\u0301 ${"long text ".repeat(12)}`,
	}));
	if (surface === "fork") {
		const items = [...messages];
		const selector = new UserMessageSelectorComponent(items, activated, cancelled, messages[0].id);
		return {
			selector,
			list: selector.getMessageList(),
			activated,
			refresh: () => items.splice(0, 2, items[1], items[0]),
			empty: () => items.splice(0),
			restore: () => items.splice(0, items.length, ...messages),
		};
	}
	if (surface === "resume") {
		const sessions: SessionInfo[] = messages.map((message, i) => ({
			path: `/nonexistent-hover/${message.id}.jsonl`,
			id: message.id,
			cwd: "/nonexistent-hover",
			created: new Date(0),
			modified: new Date(count - i),
			messageCount: 1,
			firstMessage: message.text,
			allMessagesText: message.text,
		}));
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => sessions,
			activated,
			cancelled,
			vi.fn(),
			vi.fn(),
			{ keybindings: new KeybindingsManager(), renameSession: vi.fn(async () => {}) },
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const list = selector.getSessionList();
		return {
			selector,
			list,
			activated,
			refresh: () =>
				list.setSessions(
					sessions.map((session, i) => ({ ...session, modified: new Date(i) })),
					false,
				),
			empty: () => list.setSessions([], false),
			restore: () => list.setSessions(sessions, false),
		};
	}
	const selector = new TreeSelectorComponent(
		messages.map((message) => node(message.id, null)),
		null,
		10,
		activated,
		cancelled,
		undefined,
		messages[0].id,
	);
	const list = selector.getTreeList();
	// Simulate filter refresh without a key: keyboard clearing must not mask render validation.
	const filter = list as unknown as { searchQuery: string; applyFilter(): void };
	const query = (value: string) => {
		filter.searchQuery = value;
		filter.applyFilter();
	};
	return {
		selector,
		list,
		activated,
		refresh: () => query("entry-01"),
		empty: () => query("no-match-xyz"),
		restore: () => query(""),
	};
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

describe("manual selector hover", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	beforeEach(() => setPointerHoverBackground(() => hover));
	afterEach(() => setPointerHoverBackground(undefined));

	for (const surface of surfaces) {
		for (const width of [40, 80]) {
			it(`${surface} at ${width}: whole nonselected footprint only, selected style and inert chrome unchanged`, async () => {
				const f = await create(surface);
				const before = f.selector.render(width);
				const plain = before.map(stripTerminalSequences);
				const selected = plain.find((line) => line.startsWith("› "));
				const move = mouse(f.selector, "entry-01", { type: "move", button: "none", x: 20 }, width);
				expect(move).toMatchObject({ handled: true, pointerShape: "pointer" });
				expect(move?.focus).not.toBe(true);
				expect(move?.focusTarget).toBeUndefined();
				expect(move?.hoverValid?.()).toBe(true);
				const lines = f.selector.render(width);
				const cells = await backgrounds(lines, width);
				const baseline = await backgrounds(before, width);
				const y = plain.findIndex((line) => line.includes("entry-01"));
				for (let i = 0; i < cells.length; i++) {
					const actionable = i === y || (surface === "fork" && i === y + 1);
					expect(cells[i], `row ${i}`).toEqual(actionable ? Array(width).fill(235) : baseline[i]);
				}
				expect(lines.map(stripTerminalSequences).find((line) => line.startsWith("› "))).toBe(selected);
				expect(f.activated).not.toHaveBeenCalled();
				mouse(f.selector, "entry-01", { type: "leave", button: "none" }, width);
				expect(move?.hoverValid?.()).toBe(false);
				expect(f.selector.render(width)).toEqual(before);
				mouse(f.selector, "entry-00", { type: "move", button: "none", x: 20 }, width);
				expect(f.selector.render(width)).toEqual(before);
				mouse(f.selector, "entry-00", { type: "leave" }, width);
				for (const [y, line] of plain.entries()) {
					if (line.includes("entry-") || (surface === "fork" && line.includes("Message "))) continue;
					expect(
						mouse(f.selector, "entry-00", { type: "move", button: "none", y }, width)?.pointerShape,
					).toBeUndefined();
				}
				expect(f.selector.render(width)).toEqual(before);
			});
		}

		it(`${surface}: metadata hover, keys, owned wheel and zero-width validation end episodes`, async () => {
			const f = await create(surface);
			const row = surface === "fork" ? "Message 2 of 15" : "entry-01";
			const move = mouse(f.selector, row, { type: "move", button: "none" });
			expect(f.selector.render(80).join("")).toContain(hover);
			f.list.handleInput("\x1b[B");
			expect(move?.hoverValid?.()).toBe(false);
			expect(f.selector.render(80).join("")).not.toContain(hover);
			const wheel = mouse(f.selector, "entry-02", { type: "move", button: "none" });
			expect(mouse(f.selector, "entry-02", { type: "wheel", wheelDelta: 1 })?.handled).toBe(true);
			expect(wheel?.hoverValid?.()).toBe(false);
			const zero = mouse(f.selector, "entry-02", { type: "move", button: "none" });
			f.list.render(0);
			expect(zero?.hoverValid?.()).toBe(false);
			expect(f.selector.render(80).join("")).not.toContain(hover);
			expect(f.activated).not.toHaveBeenCalled();
		});

		it(`${surface}: clamped owned wheel still clears selected hover`, async () => {
			const f = await create(surface);
			for (let i = 0; i < 15; i++) {
				const selected = f.selector
					.render(80)
					.map(stripTerminalSequences)
					.find((line) => line.startsWith("› "))!;
				mouse(f.selector, selected.trim(), { type: "wheel", wheelDelta: 1 });
			}
			const move = mouse(f.selector, "entry-14", { type: "move", button: "none" });
			expect(move?.hoverValid?.()).toBe(true);
			expect(mouse(f.selector, "entry-14", { type: "wheel", wheelDelta: 1 })).toMatchObject({
				handled: true,
				render: true,
			});
			expect(move?.hoverValid?.()).toBe(false);
			expect(mouse(f.selector, "entry-14", { type: "wheel", wheelDelta: 1 })?.render).toBe(false);
		});

		it(`${surface}: refresh under a still pointer clears instead of transferring hover`, async () => {
			const f = await create(surface);
			const move = mouse(f.selector, "entry-01", { type: "move", button: "none", x: 20 });
			expect(f.selector.render(80).join("")).toContain(hover);
			f.refresh();
			expect(f.selector.render(80).join("")).not.toContain(hover);
			expect(move?.hoverValid?.()).toBe(false);
			f.restore();
			expect(f.selector.render(80).join("")).not.toContain(hover);
		});

		for (const provider of [true, false]) {
			it(`${surface}: empty then restored cannot revive selected hover (provider ${provider})`, async () => {
				const f = await create(surface);
				if (!provider) setPointerHoverBackground(undefined);
				const move = mouse(f.selector, "entry-00", { type: "move", button: "none", x: 20 });
				expect(move?.hoverValid?.()).toBe(true);
				f.empty();
				f.selector.render(80);
				expect(move?.hoverValid?.()).toBe(false);
				f.restore();
				expect(f.selector.render(80).join("")).not.toContain(hover);
				expect(move?.hoverValid?.()).toBe(false);
			});
		}

		it(`${surface}: real fullscreen motion, key, wheel and stationary refresh use the same lifecycle`, async () => {
			const f = await create(surface);
			const terminal = new VirtualTerminal(80, 60);
			const tui = new TuiAltScreen(terminal);
			tui.addChild(f.selector);
			tui.setFocus(surface === "fork" ? f.list : f.selector);
			tui.start();
			try {
				tui.renderNow();
				const y =
					tui
						.getScreenLines()
						.map(stripTerminalSequences)
						.findIndex((line) => line.includes("entry-01")) + 1;
				expect(y).toBeGreaterThan(0);
				terminal.sendInput(`\x1b[<35;21;${y}M`);
				tui.renderNow();
				expect(tui.getScreenLines().join("")).toContain(hover);
				terminal.sendInput("\x1b[B");
				tui.renderNow();
				expect(tui.getScreenLines().join("")).not.toContain(hover);
				terminal.sendInput(`\x1b[<35;21;${y}M`);
				terminal.sendInput(`\x1b[<65;21;${y}M`);
				tui.renderNow();
				expect(tui.getScreenLines().join("")).not.toContain(hover);
				terminal.sendInput(`\x1b[<35;21;${y}M`);
				f.refresh();
				tui.renderNow();
				expect(tui.getScreenLines().join("")).not.toContain(hover);
				expect(f.activated).not.toHaveBeenCalled();
			} finally {
				tui.stop();
			}
		});
	}

	for (const surface of ["resume", "tree"] as const) {
		it(`${surface}: typing a search filter clears hover and restoration cannot revive it`, async () => {
			const f = await create(surface);
			const move = mouse(f.selector, "entry-01", { type: "move", button: "none" });
			f.list.handleInput("no-match-xyz");
			expect(move?.hoverValid?.()).toBe(false);
			expect(f.selector.render(80).join("")).not.toContain(hover);
			f.restore();
			expect(move?.hoverValid?.()).toBe(false);
		});
	}

	it("tree folding removes the hovered descendant rather than transferring to its replacement", () => {
		const selector = new TreeSelectorComponent(
			[node("root", null, [node("branch", "root", [node("tip", "branch")]), node("other", "root")])],
			null,
			40,
			vi.fn(),
			vi.fn(),
			undefined,
			"root",
		);
		const move = mouse(selector, "user: tip", { type: "move", button: "none", x: 20 });
		expect(selector.render(80).join("")).toContain(hover);
		// A refresh without another pointer report isolates paint-time identity validation.
		const folding = selector.getTreeList() as unknown as { fold(id: string): void; unfold(id: string): void };
		folding.fold("branch");
		expect(selector.render(80).join("")).not.toContain(hover);
		expect(move?.hoverValid?.()).toBe(false);
		folding.unfold("branch");
		expect(selector.render(80).join("")).not.toContain(hover);
	});

	for (const target of ["root", "branch"] as const) {
		it(`tree nonselected ${target} glyph is local; its neighboring body cell hovers the whole row`, async () => {
			const selector = new TreeSelectorComponent(
				[node("root", null, [node("branch", "root", [node("tip", "branch")]), node("other", "root")])],
				null,
				40,
				vi.fn(),
				vi.fn(),
				undefined,
				"other",
			);
			const before = selector.render(80);
			const y = before.map(stripTerminalSequences).findIndex((line) => line.includes(`user: ${target}`));
			const x = stripTerminalSequences(before[y]).indexOf("⊟");
			const baseline = await backgrounds(before);
			mouse(selector, `user: ${target}`, { type: "move", button: "none", x });
			const local = await backgrounds(selector.render(80));
			for (let row = 0; row < local.length; row++) {
				expect(local[row]).toEqual(baseline[row].map((bg, col) => (row === y && col === x ? 235 : bg)));
			}
			mouse(selector, `user: ${target}`, { type: "move", button: "none", x: x + 1 });
			const body = await backgrounds(selector.render(80));
			for (let row = 0; row < body.length; row++) {
				expect(body[row]).toEqual(row === y ? Array(80).fill(235) : baseline[row]);
			}
		});
	}

	for (const target of ["root", "branch", "panned"] as const) {
		it(`tree selected ${target} fold glyph: hover only that cell, selectedBg restored beside it`, async () => {
			let deep = node("D16", "D15");
			for (let i = 15; i >= 0; i--)
				deep = node(`D${i}`, i === 0 ? null : `D${i - 1}`, [deep, node(`S${i}`, `D${i}`)]);
			const tree =
				target === "panned"
					? [deep]
					: [node("root", null, [node("branch", "root", [node("tip", "branch")]), node("other", "root")])];
			const id = target === "panned" ? "D12" : target;
			const selector = new TreeSelectorComponent(tree, null, 200, vi.fn(), vi.fn(), undefined, id);
			const width = target === "panned" ? 40 : 80;
			const before = selector.render(width);
			const y = before.map(stripTerminalSequences).findIndex((line) => line.startsWith("› "));
			const x = stripTerminalSequences(before[y]).indexOf("⊟");
			expect(x).toBeGreaterThanOrEqual(2);
			const baseCells = await backgrounds(before, width);
			expect(baseCells[y][x - 1]).toBeDefined();
			expect(baseCells[y][x + 1]).toBe(baseCells[y][x - 1]);
			const move = mouse(selector, `user: ${id}`, { type: "move", button: "none", x }, width);
			const cells = await backgrounds(selector.render(width), width);
			for (let row = 0; row < cells.length; row++) {
				expect(cells[row]).toEqual(baseCells[row].map((bg, col) => (row === y && col === x ? 235 : bg)));
			}
			// The selected row body never gets a third selection style.
			mouse(selector, `user: ${id}`, { type: "move", button: "none", x: x + 1 }, width);
			expect(selector.render(width)).toEqual(before);
			expect(move?.hoverValid?.()).toBe(false);
			if (target === "panned") {
				const zone = mouse(selector, `user: ${id}`, { type: "move", button: "none", x }, width);
				selector.render(160);
				expect(zone?.hoverValid?.()).toBe(false);
				expect(selector.render(width).join("")).not.toContain(hover);
			} else {
				mouse(selector, `user: ${id}`, { type: "move", button: "none", x }, width);
				mouse(selector, `user: ${id}`, { type: "press", x }, width);
				mouse(selector, `user: ${id}`, { clickSource: "captured", x }, width);
				const folded = selector.render(width);
				expect(stripTerminalSequences(folded[y])).toContain("⊞");
				const foldedCells = await backgrounds(folded, width);
				expect(foldedCells[y][x]).toBe(235);
				expect(foldedCells[y][x + 1]).toBe(baseCells[y][x + 1]);
			}
		});
	}

	it("resume delete confirmation disables hover; rename and tree label replacement cannot revive it", async () => {
		const resume = await create("resume", 3);
		const selector = resume.selector as SessionSelectorComponent;
		let move = mouse(resume.selector, "entry-01", { type: "move", button: "none" });
		resume.list.handleInput("\x04");
		expect(resume.selector.render(80).join("")).not.toContain(hover);
		expect(move?.hoverValid?.()).toBe(false);
		expect(mouse(resume.selector, "entry-01", { type: "move", button: "none" })).toBeUndefined();
		resume.list.handleInput("\x1b");
		move = mouse(resume.selector, "entry-01", { type: "move", button: "none" });
		selector.handleInput("\x1b[114;5u");
		resume.selector.render(80);
		expect(move?.hoverValid?.()).toBe(false);
		selector.handleInput("\x1b");
		expect(resume.selector.render(80).join("")).not.toContain(hover);
		const tree = new TreeSelectorComponent([node("root", null), node("other", null)], null, 40, vi.fn(), vi.fn());
		move = mouse(tree, "user: other", { type: "move", button: "none" });
		tree.handleInput("L");
		tree.render(80);
		expect(move?.hoverValid?.()).toBe(false);
		tree.handleInput("\x1b");
		expect(tree.render(80).join("")).not.toContain(hover);
	});
});
