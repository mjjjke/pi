import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen as Tui } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

for (const mode of ["regular", "fullscreen", "fullscreen-no-mouse"] as const) {
	describe(`terminal focus: ${mode}`, () => {
		it("enables reporting independently of mouse, disables and resets on stop", () => {
			const terminal = new VirtualTerminal();
			const writes: string[] = [];
			terminal.write = (data) => {
				writes.push(data);
			};
			const tui =
				mode === "regular"
					? new Tui(terminal)
					: new TuiAltScreen(terminal, false, undefined, { mouse: mode !== "fullscreen-no-mouse" });
			tui.start();
			assert.equal(writes.join("").split("\x1b[?1004h").length - 1, 1);
			assert.equal(
				writes.filter((write) => write.includes("1004")).every((write) => write === "\x1b[?1004h"),
				true,
			);
			assert.equal(tui.getTerminalFocus(), undefined);
			terminal.sendInput("\x1b[I");
			assert.equal(tui.getTerminalFocus(), true);
			tui.stop();
			assert.equal(writes.join("").split("\x1b[?1004l").length - 1, 1);
			assert.equal(tui.getTerminalFocus(), undefined);
		});

		it("reports changes once, isolates listeners and never sends reports to components", () => {
			const terminal = new VirtualTerminal();
			const tui = mode === "regular" ? new Tui(terminal) : new TuiAltScreen(terminal);
			const changes: boolean[] = [];
			const input: string[] = [];
			tui.setFocus({ render: () => ["hello"], invalidate() {}, handleInput: (data) => input.push(data) });
			tui.onTerminalFocusChange(() => {
				throw new Error("listener");
			});
			const unsubscribe = tui.onTerminalFocusChange((focused) => changes.push(focused));
			tui.start();
			try {
				terminal.sendInput("\x1b[I");
				terminal.sendInput("\x1b[I");
				terminal.sendInput("\x1b[O");
				assert.equal(tui.getTerminalFocus(), false);
				assert.deepEqual(changes, [true, false]);
				const buffer = new StdinBuffer();
				buffer.on("data", (data) => terminal.sendInput(data));
				buffer.process("\x1b[Ia");
				buffer.destroy();
				assert.deepEqual(changes, [true, false, true]);
				assert.deepEqual(input, ["a"]);
				unsubscribe();
				terminal.sendInput("\x1b[O");
				assert.deepEqual(changes, [true, false, true]);
			} finally {
				tui.stop();
			}
		});
	});
}

it("focus-out still clears an active fullscreen selection", () => {
	const terminal = new VirtualTerminal();
	const tui = new TuiAltScreen(terminal);
	tui.addChild({ render: () => ["hello world"], invalidate() {} });
	tui.start();
	try {
		tui.renderNow();
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;5;1M");
		assert.equal(tui.hasActiveSelection(), true);
		terminal.sendInput("\x1b[O");
		assert.equal(tui.hasActiveSelection(), false);
	} finally {
		tui.stop();
	}
});
