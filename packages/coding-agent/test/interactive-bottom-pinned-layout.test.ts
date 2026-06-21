import { describe, expect, test } from "vitest";
import type { Component } from "../../tui/src/tui.ts";
import { Container, TUI } from "../../tui/src/tui.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { BottomPinnedLayout } from "../src/modes/interactive/interactive-mode.ts";

class LinesComponent implements Component {
	private lines: string[];

	constructor(...lines: string[]) {
		this.lines = lines;
	}

	setLines(...lines: string[]): void {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

async function render(tui: TUI, terminal: VirtualTerminal): Promise<string[]> {
	tui.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
	return terminal.getViewport();
}

describe("BottomPinnedLayout", () => {
	test("pins short-content editor and footer to the viewport bottom", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const layout = new BottomPinnedLayout(() => terminal.rows);
		layout.topContainer.addChild(new LinesComponent("HEADER", "CHAT"));
		layout.bottomContainer.addChild(new LinesComponent("EDITOR", "FOOTER"));
		tui.addChild(layout);
		tui.start();

		try {
			const viewport = await render(tui, terminal);
			expect(viewport).toEqual(["HEADER", "CHAT", "", "", "", "", "EDITOR", "FOOTER"]);
		} finally {
			tui.stop();
		}
	});

	test("does not add spacer rows when content overflows", async () => {
		const terminal = new VirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const layout = new BottomPinnedLayout(() => terminal.rows);
		layout.topContainer.addChild(new LinesComponent("TOP-1", "TOP-2", "TOP-3", "TOP-4", "TOP-5"));
		layout.bottomContainer.addChild(new LinesComponent("EDITOR", "FOOTER"));
		tui.addChild(layout);
		tui.start();

		try {
			const renderedLines = layout.render(40);
			expect(renderedLines).toEqual(["TOP-1", "TOP-2", "TOP-3", "TOP-4", "TOP-5", "EDITOR", "FOOTER"]);
			const viewport = await render(tui, terminal);
			expect(viewport).toEqual(["TOP-3", "TOP-4", "TOP-5", "EDITOR", "FOOTER"]);
		} finally {
			tui.stop();
		}
	});

	test("keeps custom footer replacements pinned", async () => {
		const terminal = new VirtualTerminal(40, 6);
		const tui = new TUI(terminal);
		const layout = new BottomPinnedLayout(() => terminal.rows);
		const footerContainer = new Container();
		footerContainer.addChild(new LinesComponent("BUILT-IN FOOTER"));
		layout.topContainer.addChild(new LinesComponent("HEADER"));
		layout.bottomContainer.addChild(new LinesComponent("EDITOR"));
		layout.bottomContainer.addChild(footerContainer);
		tui.addChild(layout);
		tui.start();

		try {
			expect(await render(tui, terminal)).toEqual(["HEADER", "", "", "", "EDITOR", "BUILT-IN FOOTER"]);

			footerContainer.clear();
			footerContainer.addChild(new LinesComponent("CUSTOM FOOTER"));

			expect(await render(tui, terminal)).toEqual(["HEADER", "", "", "", "EDITOR", "CUSTOM FOOTER"]);
		} finally {
			tui.stop();
		}
	});

	test("recomputes spacer rows on resize", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const layout = new BottomPinnedLayout(() => terminal.rows);
		layout.topContainer.addChild(new LinesComponent("HEADER"));
		layout.bottomContainer.addChild(new LinesComponent("EDITOR", "FOOTER"));
		tui.addChild(layout);
		tui.start();

		try {
			expect(await render(tui, terminal)).toEqual(["HEADER", "", "", "", "", "", "EDITOR", "FOOTER"]);

			terminal.resize(40, 5);
			expect(await render(tui, terminal)).toEqual(["HEADER", "", "", "EDITOR", "FOOTER"]);

			terminal.resize(40, 3);
			expect(await render(tui, terminal)).toEqual(["HEADER", "EDITOR", "FOOTER"]);
		} finally {
			tui.stop();
		}
	});
});
