import {
	Container,
	Input,
	ScrollView,
	setKeybindings,
	stripTerminalSequences,
	Text,
	type TuiMouseEvent,
	VStack,
} from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { mouse } from "./helpers/selector-mouse.ts";

const CTRL_R = "\x1b[114;5u";
async function fixture(count = 3) {
	const sessions: SessionInfo[] = Array.from({ length: count }, (_, i) => ({
		path: `/nonexistent-selector-mouse/session-${i}.jsonl`,
		id: `id-${i}`,
		cwd: "/nonexistent-selector-mouse",
		created: new Date(0),
		modified: new Date(count - i),
		messageCount: 1,
		firstMessage: `session-${i}`,
		allMessagesText: `session-${i}`,
	}));
	const selected = vi.fn();
	const cancelled = vi.fn();
	const renamed = vi.fn(async () => {});
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => sessions,
		selected,
		cancelled,
		vi.fn(),
		vi.fn(),
		{
			keybindings: new KeybindingsManager(),
			renameSession: renamed,
		},
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	return { sessions, selected, cancelled, renamed, selector, list: selector.getSessionList() };
}

describe("resume selector mouse", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	it("press highlights with parent focus and click resumes once", async () => {
		const f = await fixture();
		expect(mouse(f.selector, "session-1", { type: "press" })?.focusTarget).toBe(f.selector);
		expect(f.list.getSelectedSessionPath()).toBe(f.sessions[1].path);
		expect(f.selected).not.toHaveBeenCalled();
		mouse(f.selector, "session-1", { clickSource: "captured" });
		mouse(f.selector, "session-1");
		expect(f.selected).toHaveBeenCalledExactlyOnceWith(f.sessions[1].path);
	});
	it("ignores non-primary events, fallback clicks, header and blanks", async () => {
		const f = await fixture();
		for (const type of ["release", "drag", "move", "leave"] as const)
			expect(mouse(f.selector, "session-1", { type })).toBeUndefined();
		for (const button of ["middle", "right"] as const)
			expect(mouse(f.selector, "session-1", { type: "press", button })).toBeUndefined();
		expect(mouse(f.selector, "session-1", { clickSource: "fallback" })).toBeUndefined();
		for (const label of ["Resume Session", "regex", "delete"])
			for (const event of [{}, { type: "wheel", wheelDelta: 1 }] satisfies Partial<TuiMouseEvent>[])
				expect(mouse(f.selector, label, event)).toBeUndefined();
		const y =
			f.selector
				.render(80)
				.map(stripTerminalSequences)
				.findIndex((line) => line.includes("session-0")) - 1;
		expect(mouse(f.selector, "session-0", { y })).toBeUndefined();
		expect(mouse(f.selector, "session-0", { type: "wheel", wheelDelta: 1 })).toBeUndefined();
		expect(f.selected).not.toHaveBeenCalled();
	});
	it("wheel steps one, clamps, excludes counter/search and preserves touched selection on refresh", async () => {
		const f = await fixture(15);
		expect(mouse(f.selector, "session-0", { type: "wheel", wheelDelta: 9 })?.render).toBe(true);
		expect(f.list.getSelectedSessionPath()).toBe(f.sessions[1].path);
		f.list.setSessions([...f.sessions].reverse(), false);
		expect(f.list.getSelectedSessionPath()).toBe(f.sessions[1].path);
		for (let i = 0; i < 16; i++) {
			const lines = f.selector.render(80).map(stripTerminalSequences);
			const y = lines.findIndex((line) => line.startsWith("› "));
			expect(mouse(f.selector, "Resume Session", { type: "wheel", wheelDelta: 9, y })?.handled).toBe(true);
		}
		expect(f.list.getSelectedSessionPath()).toBe(f.sessions[14].path);
		expect(mouse(f.selector, "session-14", { type: "wheel", wheelDelta: 1 })?.render).toBe(false);
		expect(mouse(f.selector, "(15/15)", { type: "wheel", wheelDelta: -1 })).toBeUndefined();
		const y =
			f.selector
				.render(80)
				.map(stripTerminalSequences)
				.findIndex((line) => line.includes("session-5")) - 2;
		expect(mouse(f.selector, "Resume Session", { type: "wheel", wheelDelta: -1, y })).toBeUndefined();
	});
	it("press counts as touched selection when sessions arrive", async () => {
		const f = await fixture();
		mouse(f.selector, "session-1", { type: "press" });
		f.list.setSessions(f.sessions, false);
		expect(f.list.getSelectedSessionPath()).toBe(f.sessions[1].path);
	});
	it("revalidates press identity after refresh reordering", async () => {
		const f = await fixture();
		mouse(f.selector, "session-1", { type: "press" });
		f.list.setSessions(
			f.sessions.map((session, i) => ({ ...session, modified: new Date(i) })),
			false,
		);
		mouse(f.selector, "session-0", { clickSource: "captured" });
		expect(f.selected).toHaveBeenCalledExactlyOnceWith(f.sessions[1].path);
	});
	for (const change of ["refresh", "filter"])
		it(`removed press key after ${change} leaves the list usable`, async () => {
			const f = await fixture();
			mouse(f.selector, "session-1", { type: "press" });
			if (change === "refresh") f.list.setSessions([f.sessions[2]], false);
			else f.selector.handleInput("session-2");
			const y = f.selector
				.render(80)
				.map(stripTerminalSequences)
				.findIndex((line) => line.startsWith("› "));
			mouse(f.selector, "session-2", { clickSource: "captured", y });
			expect(f.selected).not.toHaveBeenCalled();
			mouse(f.selector, "session-2", { type: "press", y });
			mouse(f.selector, "session-2", { clickSource: "captured", y });
			expect(f.selected).toHaveBeenCalledExactlyOnceWith(f.sessions[2].path);
		});
	it("forwards search press to Input cursor without activation", async () => {
		const f = await fixture();
		f.selector.handleInput("session");
		const lines = f.selector.render(80).map(stripTerminalSequences);
		const y = lines.findIndex((line) => line.includes("session") && !line.includes("session-"));
		expect(y).toBeGreaterThanOrEqual(0);
		expect(mouse(f.selector, "session-0", { type: "press", x: 2, y })?.focusTarget).toBe(f.selector);
		f.selector.handleInput("X");
		expect(f.selector.render(80).map(stripTerminalSequences).join("\n")).toContain("Xsession");
		expect(f.selected).not.toHaveBeenCalled();
	});
	it("delete-confirm disables rows, wheel and search until cancelled", async () => {
		const f = await fixture(15);
		f.selector.handleInput("\x04");
		for (const event of [
			{ type: "press" },
			{ type: "click" },
			{ type: "wheel", wheelDelta: 1 },
		] satisfies Partial<TuiMouseEvent>[])
			expect(mouse(f.selector, "session-1", event)).toBeUndefined();
		const y =
			f.selector
				.render(80)
				.map(stripTerminalSequences)
				.findIndex((line) => line.includes("session-0")) - 2;
		expect(mouse(f.selector, "session-0", { type: "press", y })).toBeUndefined();
		f.selector.handleInput("\x1b");
		expect(f.cancelled).not.toHaveBeenCalled();
		mouse(f.selector, "session-1", { type: "press" });
		mouse(f.selector, "session-1", { clickSource: "captured" });
		expect(f.selected).toHaveBeenCalledExactlyOnceWith(f.sessions[1].path);
	});
	it("rename hides session rows, accepts typing, and restores clickable rows after save", async () => {
		const f = await fixture();
		f.selector.focused = true;
		f.selector.handleInput(CTRL_R);
		expect(f.selector.render(80).map(stripTerminalSequences).join("\n")).not.toContain("session-1");
		const panel = f.selector.children.find(
			(child) => child instanceof Container && child.children.some((item) => item instanceof Input),
		);
		expect(panel).toBeDefined();
		f.selector.handleInput("Renamed");
		f.selector.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(f.renamed).toHaveBeenCalledExactlyOnceWith(f.sessions[0].path, "Renamed");
		mouse(f.selector, "session-1", { type: "press" });
		mouse(f.selector, "session-1", { clickSource: "captured" });
		expect(f.selected).toHaveBeenCalledExactlyOnceWith(f.sessions[1].path);
	});
	it("real renderer rejects disabled press → Esc → fallback release, then accepts a fresh click", async () => {
		const f = await fixture();
		const terminal = new VirtualTerminal(80, 40);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(f.selector);
		tui.setFocus(f.selector);
		tui.start();
		tui.renderNow();
		try {
			terminal.sendInput("\x04");
			tui.renderNow();
			const y =
				tui
					.getScreenLines()
					.map(stripTerminalSequences)
					.findIndex((line) => line.includes("session-1")) + 1;
			expect(y).toBeGreaterThan(0);
			terminal.sendInput(`\x1b[<0;4;${y}M`);
			terminal.sendInput("\x1b");
			tui.renderNow();
			terminal.sendInput(`\x1b[<0;4;${y}m`);
			expect(f.cancelled).not.toHaveBeenCalled();
			expect(f.selected).not.toHaveBeenCalled();
			terminal.sendInput(`\x1b[<0;4;${y}M`);
			terminal.sendInput(`\x1b[<0;4;${y}m`);
			expect(f.selected).toHaveBeenCalledExactlyOnceWith(f.sessions[1].path);
		} finally {
			tui.stop();
		}
	});
	for (const pane of ["rename", "delete"])
		it(`real renderer voids a held press on ${pane} and keeps focus for typing/Esc`, async () => {
			const f = await fixture();
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
						.findIndex((line) => line.includes("session-1")) + 1;
				terminal.sendInput(`\x1b[<0;4;${y}M`);
				terminal.sendInput(pane === "rename" ? CTRL_R : "\x04");
				terminal.sendInput("X");
				if (pane === "rename") expect(f.selector.render(80).map(stripTerminalSequences).join("\n")).toContain("X");
				terminal.sendInput("\x1b");
				tui.renderNow();
				terminal.sendInput(`\x1b[<0;4;${y}m`);
				expect(f.selected).not.toHaveBeenCalled();
				expect(f.cancelled).not.toHaveBeenCalled();
				terminal.sendInput(`\x1b[<0;4;${y}M`);
				terminal.sendInput("session-1");
				terminal.sendInput("\x1b");
				expect(f.cancelled).toHaveBeenCalledTimes(1);
				expect(f.selector.render(80).map(stripTerminalSequences).join("\n")).not.toContain("session-0");
			} finally {
				tui.stop();
			}
		});
	for (const cancel of ["drag", "key", "rename"] as const)
		it(`search gesture ownership after a ${cancel}-cancelled row press; typing and a fresh row click still work`, async () => {
			const f = await fixture();
			const terminal = new VirtualTerminal(80, 40);
			const tui = new TuiAltScreen(terminal);
			tui.addChild(f.selector);
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
				const y = row("session-1");
				terminal.sendInput(`\x1b[<0;4;${y}M`);
				if (cancel === "drag") {
					terminal.sendInput(`\x1b[<32;8;${y}M`);
					terminal.sendInput(`\x1b[<0;8;${y}m`);
				} else {
					if (cancel === "rename") {
						terminal.sendInput(CTRL_R);
						terminal.sendInput("\x1b");
					} else terminal.sendInput("\x1b[B");
					terminal.sendInput(`\x1b[<0;4;${y}m`);
				}
				expect(f.selected).not.toHaveBeenCalled();
				tui.renderNow();
				// Search is two rows above the first session in the rendered layout.
				const searchY = row("session-0") - 2;
				expect(searchY).toBeGreaterThan(0);
				terminal.sendInput(`\x1b[<0;4;${searchY}M`);
				terminal.sendInput(`\x1b[<0;4;${searchY}m`);
				expect(f.selected).not.toHaveBeenCalled();
				terminal.sendInput("session-2");
				tui.renderNow();
				expect(tui.getScreenLines().map(stripTerminalSequences).join("\n")).not.toContain("session-0");
				const freshY =
					tui
						.getScreenLines()
						.map(stripTerminalSequences)
						.findIndex((line) => line.startsWith("› ") && line.includes("session-2")) + 1;
				expect(freshY).toBeGreaterThan(0);
				terminal.sendInput(`\x1b[<0;4;${freshY}M`);
				terminal.sendInput(`\x1b[<0;4;${freshY}m`);
				expect(f.selected).toHaveBeenCalledExactlyOnceWith(f.sessions[2].path);
				expect(f.cancelled).not.toHaveBeenCalled();
			} finally {
				tui.stop();
			}
		});
	for (const [count, width] of [
		[3, 80],
		[15, 80],
		[15, 24],
	])
		it(`fullscreen manual rows recenter, cancel drag and route chat wheel (${count}, ${width})`, async () => {
			const f = await fixture(count);
			const terminal = new VirtualTerminal(width, 40);
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
				terminal.sendInput(`\x1b[<64;4;${row("session-0")}M`);
				expect(chat.isFollowingEnd).toBe(count > 10);
				chat.scrollToEnd();
				tui.renderNow();
				terminal.sendInput(`\x1b[<64;4;${row("re:")}M`);
				expect(chat.isFollowingEnd).toBe(false);
				const label = count > 10 ? "session-8" : "session-1";
				const y = row(label);
				terminal.sendInput(`\x1b[<0;4;${y}M`);
				tui.renderNow();
				terminal.sendInput(`\x1b[<32;8;${y}M`);
				terminal.sendInput(`\x1b[<0;8;${y}m`);
				expect(f.selected).not.toHaveBeenCalled();
				for (let i = 0; i < (count > 10 ? 8 : 1); i++) terminal.sendInput("\x1b[A");
				tui.renderNow();
				const freshY = row(label);
				terminal.sendInput(`\x1b[<0;4;${freshY}M`);
				tui.renderNow();
				if (count > 10) expect(row(label)).not.toBe(freshY);
				terminal.sendInput(`\x1b[<0;4;${freshY}m`);
				expect(f.selected).toHaveBeenCalledExactlyOnceWith(f.sessions[count > 10 ? 8 : 1].path);
			} finally {
				tui.stop();
			}
		});
});
