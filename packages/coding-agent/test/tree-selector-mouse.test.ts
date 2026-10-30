import {
	type ListMouse,
	ScrollView,
	setKeybindings,
	stripTerminalSequences,
	Text,
	type TuiMouseEvent,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager, type SessionTreeNode } from "../src/core/session-manager.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { mouse } from "./helpers/selector-mouse.ts";

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
function fixture(
	tree = [node("root", null, [node("branch", "root", [node("tip", "branch")]), node("other", "root")])],
	height = 40,
) {
	const selected = vi.fn();
	const cancelled = vi.fn();
	const labeled = vi.fn();
	const selector = new TreeSelectorComponent(tree, null, height, selected, cancelled, labeled, tree[0].entry.id);
	return { selector, list: selector.getTreeList(), selected, cancelled, labeled };
}
function plain(selector: TreeSelectorComponent, width = 80) {
	return selector.render(width).map(stripTerminalSequences);
}
function glyph(selector: TreeSelectorComponent, label: string, width = 80) {
	const line = plain(selector, width).find((line) => line.includes(`user: ${label}`));
	expect(line).toBeDefined();
	const x = line!.search(/[⊟⊞]/);
	expect(x).toBeGreaterThanOrEqual(2);
	return x;
}
function click(selector: TreeSelectorComponent, label: string, x = 12, width = 80) {
	mouse(selector, `user: ${label}`, { type: "press", x }, width);
	mouse(selector, `user: ${label}`, { clickSource: "captured", x }, width);
}
function deepTree() {
	let child = node("D16", "D15");
	for (let i = 15; i >= 0; i--) child = node(`D${i}`, i === 0 ? null : `D${i - 1}`, [child, node(`S${i}`, `D${i}`)]);
	return [child];
}

describe("tree selector mouse", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	it("press highlights with parent focus; row click navigates directly once", () => {
		const f = fixture();
		expect(mouse(f.selector, "user: other", { type: "press" })?.focusTarget).toBe(f.selector);
		expect(f.list.getSelectedNode()?.entry.id).toBe("other");
		expect(f.selected).not.toHaveBeenCalled();
		mouse(f.selector, "user: other", { clickSource: "captured" });
		click(f.selector, "root");
		expect(f.selected).toHaveBeenCalledExactlyOnceWith("other");
	});
	it("ignores non-primary events, fallback and mismatched gestures, and inert lines", () => {
		const f = fixture();
		for (const type of ["release", "drag", "move", "leave"] as const)
			expect(mouse(f.selector, "user: other", { type })).toBeUndefined();
		for (const button of ["middle", "right"] as const)
			expect(mouse(f.selector, "user: other", { type: "press", button })).toBeUndefined();
		mouse(f.selector, "user: root", { type: "press", gestureId: 1, x: glyph(f.selector, "root") });
		expect(mouse(f.selector, "user: other", { clickSource: "captured", gestureId: 2 })).toBeUndefined();
		expect(mouse(f.selector, "user: other", { clickSource: "fallback" })).toBeUndefined();
		for (const label of ["Session Tree", "Type to search:", "filters", "(1/4)"])
			for (const event of [{}, { type: "wheel", wheelDelta: 1 }] satisfies Partial<TuiMouseEvent>[])
				expect(mouse(f.selector, label, event)).toBeUndefined();
		expect(f.selected).not.toHaveBeenCalled();
		click(f.selector, "other");
		expect(f.selected).toHaveBeenCalledExactlyOnceWith("other");
	});
	it("root glyph toggles on the first click and remains usable for unfold and row activation", () => {
		const f = fixture();
		expect(plain(f.selector).find((line) => line.includes("user: root"))).toContain("⊟");
		click(f.selector, "root", glyph(f.selector, "root"));
		expect(plain(f.selector).join("\n")).not.toContain("user: tip");
		expect(plain(f.selector).join("\n")).toContain("⊞");
		expect(f.selected).not.toHaveBeenCalled();
		click(f.selector, "root", glyph(f.selector, "root"));
		expect(plain(f.selector).join("\n")).toContain("user: tip");
		click(f.selector, "branch");
		expect(f.selected).toHaveBeenCalledExactlyOnceWith("branch");
	});
	for (const offset of [-1, 0, 1])
		it(`connector fold zone is exactly one cell (offset ${offset})`, () => {
			const f = fixture();
			click(f.selector, "branch", glyph(f.selector, "branch") + offset);
			if (offset === 0) {
				expect(f.selected).not.toHaveBeenCalled();
				expect(plain(f.selector).join("\n")).not.toContain("user: tip");
			} else expect(f.selected).toHaveBeenCalledExactlyOnceWith("branch");
		});
	it("a nonfoldable connector dash is row body", () => {
		const f = fixture();
		const line = plain(f.selector).find((line) => line.includes("user: other"))!;
		click(f.selector, "other", line.indexOf("─"));
		expect(f.selected).toHaveBeenCalledExactlyOnceWith("other");
	});
	it("multiple real roots each have independently togglable connector-less glyphs", () => {
		const manager = SessionManager.inMemory("/nonexistent-tree-mouse");
		const first = manager.appendMessage({ role: "user", content: "first-root", timestamp: 0 });
		manager.appendMessage({ role: "user", content: "first-child", timestamp: 0 });
		manager.resetLeaf();
		manager.appendMessage({ role: "user", content: "second-root", timestamp: 0 });
		manager.appendMessage({ role: "user", content: "second-child", timestamp: 0 });
		const tree = manager.getTree();
		expect(tree).toHaveLength(2);
		expect(tree[1].entry.parentId).toBeNull();
		const f = fixture(tree);
		for (const label of ["first-root", "second-root"]) {
			expect(glyph(f.selector, label)).toBe(2);
			click(f.selector, label, 2);
		}
		expect(plain(f.selector).join("\n")).not.toContain("-child");
		click(f.selector, "first-root", 2);
		expect(plain(f.selector).join("\n")).toContain("first-child");
		expect(plain(f.selector).join("\n")).not.toContain("second-child");
		click(f.selector, "first-root", 6);
		expect(f.selected).toHaveBeenCalledExactlyOnceWith(first);
	});
	it("maps fold zones through horizontal pan and retains the press-time zone across pan changes", () => {
		const f = fixture(deepTree(), 200);
		const before = plain(f.selector, 40).find((line) => line.includes("user: D0"))!;
		expect(before).toContain("⊟");
		for (let i = 0; i < 12; i++) f.selector.handleInput("\x1b[B");
		expect(f.list.getSelectedNode()?.entry.id).toBe("D12");
		const panned = plain(f.selector, 40);
		expect(panned.find((line) => line.startsWith("› "))).toContain("user: D12");
		expect(panned[plain(f.selector, 40).findIndex((line) => line.includes("user: D12"))]).toContain("⊟");
		const x = glyph(f.selector, "D12", 40);
		expect(x).toBeLessThan(38);
		mouse(f.selector, "user: D12", { type: "press", x }, 40);
		// Rendering at a different width changes the pan, not the retained key/zone.
		f.selector.render(160);
		mouse(f.selector, "user: D12", { clickSource: "captured", x: 0 }, 160);
		expect(plain(f.selector, 160).join("\n")).not.toContain("user: D13");
		expect(f.selected).not.toHaveBeenCalled();
		click(f.selector, "D12", glyph(f.selector, "D12", 40), 40);
		expect(plain(f.selector, 160).join("\n")).toContain("user: D13");
	});
	it.each([1, 3, 12, 40, 80, 160])("keeps Unicode fold geometry within width %i before and after pan", (width) => {
		const tree = [...deepTree(), node("second", null, [node("second-child", "second")])];
		const decorate = (nodes: SessionTreeNode[]) => {
			for (const item of nodes) {
				if (item.entry.type === "message" && item.entry.message.role === "user")
					item.entry.message.content = `${item.entry.id} ${"界🙂e\u0301".repeat(50)}`;
				item.label = "広い🙂e\u0301ラベル";
				decorate(item.children);
			}
		};
		decorate(tree);
		const f = fixture(tree, 200);
		const hits = Reflect.get(f.list, "mouse") as ListMouse<string>;
		const full = f.list.render(160).map(stripTerminalSequences);
		for (const id of ["D0", "second"]) {
			const row = full.find((line) => line.includes(`user: ${id} `))!;
			expect(row).toContain("⊟");
			expect(visibleWidth(row.slice(0, row.indexOf("⊟")))).toBe(2);
		}
		for (const selection of [0, 12]) {
			if (selection > 0) for (let i = 0; i < selection; i++) f.selector.handleInput("\x1b[B");
			const rows = f.list.render(width).map(stripTerminalSequences);
			for (const [y, line] of rows.entries()) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				const index = line.search(/[⊟⊞]/);
				const x = index < 0 ? -1 : visibleWidth(line.slice(0, index));
				for (let cell = 0; cell < width; cell++)
					expect(hits.hitTest(cell, y)?.zone).toBe(cell === x ? "fold" : undefined);
			}
			if (width < 160) expect(rows.join("\n")).not.toContain("界🙂e\u0301".repeat(50));
			if (selection > 0 && width >= 40) {
				const row = rows.find((line) => line.startsWith("› "))!;
				expect(row).toContain("user: D12");
				if (width === 40) {
					const unpanned = full.find((line) => line.includes("user: D12 "))!;
					expect(visibleWidth(row.slice(0, row.indexOf("⊟")))).toBeLessThan(
						visibleWidth(unpanned.slice(0, unpanned.indexOf("⊟"))),
					);
				}
			}
		}
	});
	it("a glyph scrolled out of the body does not leave a zone in the fixed gutter", () => {
		const f = fixture(deepTree(), 200);
		for (let i = 0; i < 12; i++) f.selector.handleInput("\x1b[B");
		f.selector.render(40);
		const firstRow = plain(f.selector, 40).findIndex((line) => line.startsWith("› ")) - 12;
		expect(firstRow).toBeGreaterThan(0);
		mouse(f.selector, "Session Tree", { type: "press", x: 2, y: firstRow }, 40);
		mouse(f.selector, "Session Tree", { clickSource: "captured", x: 2, y: firstRow }, 40);
		expect(f.selected).toHaveBeenCalledExactlyOnceWith("D0");
	});
	for (const change of ["removed", "nonfoldable"] as const)
		it(`revalidates a ${change} press-time zone and keeps the list usable`, () => {
			const tree = [node("root", null, [node("branch", "root", [node("tip", "branch")]), node("other", "root")])];
			const f = fixture(tree);
			mouse(f.selector, "user: branch", { type: "press", x: glyph(f.selector, "branch") });
			if (change === "removed") f.selector.handleInput("other");
			else {
				f.list.updateNodeLabel("branch", "keep");
				f.list.updateNodeLabel("other", "keep");
				f.selector.handleInput("keep");
			}
			mouse(f.selector, "user: other", { clickSource: "captured" });
			expect(f.selected).not.toHaveBeenCalled();
			expect(plain(f.selector).join("\n")).not.toContain("⊞");
			f.selector.handleInput("\x1b");
			expect(plain(f.selector).join("\n")).toContain("user: tip");
			click(f.selector, "other");
			expect(f.selected).toHaveBeenCalledExactlyOnceWith("other");
		});
	it("a press-time row hidden by folding is ignored without closing the list", () => {
		const f = fixture();
		mouse(f.selector, "user: tip", { type: "press", x: 12 });
		f.selector.handleInput("\x1b[1;5D"); // jump to branch
		f.selector.handleInput("\x1b[1;5D"); // fold branch
		mouse(f.selector, "user: other", { clickSource: "captured" });
		expect(f.selected).not.toHaveBeenCalled();
		click(f.selector, "other");
		expect(f.selected).toHaveBeenCalledExactlyOnceWith("other");
	});
	it("a removed row key does not close mouse admission", () => {
		const f = fixture();
		mouse(f.selector, "user: branch", { type: "press", x: 12 });
		f.selector.handleInput("other");
		mouse(f.selector, "user: other", { clickSource: "captured" });
		expect(f.selected).not.toHaveBeenCalled();
		click(f.selector, "other");
		expect(f.selected).toHaveBeenCalledExactlyOnceWith("other");
	});
	it("wheel belongs only to clipped node rows, steps one and clamps", () => {
		const f = fixture(
			[
				node(
					"root",
					null,
					Array.from({ length: 14 }, (_, i) => node(`item-${i}`, "root")),
				),
			],
			10,
		);
		for (let i = 0; i < 16; i++) {
			const label = f.list.getSelectedNode()!.entry.id;
			expect(mouse(f.selector, `user: ${label}`, { type: "wheel", wheelDelta: 9 })?.handled).toBe(true);
		}
		expect(f.list.getSelectedNode()?.entry.id).toBe("item-13");
		expect(mouse(f.selector, "user: item-13", { type: "wheel", wheelDelta: 1 })?.render).toBe(false);
		for (const label of ["Type to search:", "Session Tree", "(15/15)"])
			expect(mouse(f.selector, label, { type: "wheel", wheelDelta: -1 })).toBeUndefined();
		const short = fixture();
		expect(mouse(short.selector, "user: root", { type: "wheel", wheelDelta: 1 })).toBeUndefined();
	});
	for (const mode of ["label-save", "label-cancel", "search"] as const)
		it(`real renderer cancels a held gesture for ${mode}, retains focus and restores usable rows`, () => {
			const f = fixture();
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
						.map(stripTerminalSequences)
						.findIndex((line) => line.includes("user: branch")) + 1;
				terminal.sendInput(`\x1b[<0;4;${y}M`);
				terminal.sendInput(mode === "search" ? "other" : "L");
				tui.renderNow();
				if (mode !== "search") {
					expect(tui.getScreenLines().map(stripTerminalSequences).join("\n")).not.toContain("user: root");
					terminal.sendInput("saved");
					terminal.sendInput(mode === "label-save" ? "\r" : "\x1b");
					if (mode === "label-save") expect(f.labeled).toHaveBeenCalledExactlyOnceWith("branch", "saved");
					else expect(f.labeled).not.toHaveBeenCalled();
				} else terminal.sendInput("\x1b");
				terminal.sendInput(`\x1b[<0;4;${y}m`);
				expect(f.selected).not.toHaveBeenCalled();
				expect(f.cancelled).not.toHaveBeenCalled();
				tui.renderNow();
				const fresh =
					tui
						.getScreenLines()
						.map(stripTerminalSequences)
						.findIndex((line) => line.includes("user: other")) + 1;
				terminal.sendInput(`\x1b[<0;8;${fresh}M`);
				terminal.sendInput(`\x1b[<0;8;${fresh}m`);
				expect(f.selected).toHaveBeenCalledExactlyOnceWith("other");
			} finally {
				tui.stop();
			}
		});
	for (const count of [3, 15])
		it(`fullscreen manual rows recenter, cancel drag, and route item/header wheel (${count})`, () => {
			const f = fixture(
				[
					node(
						"root",
						null,
						Array.from({ length: count - 1 }, (_, i) => node(`item-${i}`, "root")),
					),
				],
				10,
			);
			const terminal = new VirtualTerminal(40, 40);
			const tui = new TuiAltScreen(terminal);
			const chat = new ScrollView(new Text(Array.from({ length: 100 }, (_, i) => `Chat ${i}`).join("\n"), 0, 0), {
				follow: "end",
				primary: true,
			});
			tui.setLayoutRoot(
				new VStack([
					{ component: chat, basis: 0, grow: 1, minSize: 1 },
					{ component: f.selector, basis: "auto", minSize: 1 },
				]),
			);
			tui.setFocus(f.selector);
			tui.start();
			tui.renderNow();
			const row = (label: string) => {
				const y =
					tui
						.getScreenLines()
						.map(stripTerminalSequences)
						.findIndex((line) => line.includes(label)) + 1;
				expect(y).toBeGreaterThan(0);
				return y;
			};
			try {
				terminal.sendInput(`\x1b[<64;8;${row("user: root")}M`);
				expect(chat.isFollowingEnd).toBe(count > 5);
				chat.scrollToEnd();
				tui.renderNow();
				terminal.sendInput(`\x1b[<64;8;${row("Type to search:")}M`);
				expect(chat.isFollowingEnd).toBe(false);
				const label = count > 5 ? "user: item-3" : "user: item-1";
				const y = row(label);
				terminal.sendInput(`\x1b[<0;8;${y}M`);
				tui.renderNow();
				terminal.sendInput(`\x1b[<32;12;${y}M`);
				terminal.sendInput(`\x1b[<0;12;${y}m`);
				expect(f.selected).not.toHaveBeenCalled();
				for (let i = 0; i < count; i++) terminal.sendInput("\x1b[A");
				// Reset selection to root through search, then clear it.
				terminal.sendInput("root");
				terminal.sendInput("\x1b");
				tui.renderNow();
				const fresh = row(label);
				terminal.sendInput(`\x1b[<0;8;${fresh}M`);
				tui.renderNow();
				if (count > 5) expect(row(label)).not.toBe(fresh);
				terminal.sendInput(`\x1b[<0;8;${fresh}m`);
				expect(f.selected).toHaveBeenCalledExactlyOnceWith(count > 5 ? "item-3" : "item-1");
			} finally {
				tui.stop();
			}
		});
});
