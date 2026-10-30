import { Container, ListMouse, setKeybindings, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { flush, mouseHost } from "./helpers/mouse-host.ts";

describe("editor-slot mouse displacement", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	for (const kind of ["confirm", "custom", "logout"] as const)
		it(`a held ${kind} cannot dismiss its replacement`, async () => {
			const f = mouseHost();
			const resolved = vi.fn();
			if (kind === "confirm") void f.host.showExtensionSelector("Confirm", ["Yes", "No"]).then(resolved);
			else if (kind === "logout") {
				await f.host.showOAuthSelector("logout");
				// Keyboard-free synthetic chooser click; the real renderer exercises the held confirm.
				const chooser = f.host.editorContainer.children[0] as Container;
				const lines = chooser.render(80).map(stripTerminalSequences);
				chooser.handleMouse({
					type: "click",
					button: "left",
					x: 4,
					y: lines.findIndex((s) => s.includes("Fake Provider")),
					screenX: 4,
					screenY: 0,
					width: 80,
					height: lines.length,
					shift: false,
					alt: false,
					ctrl: false,
				});
				// The logout arming deadline is past before we press.
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(Date.now() + 1000);
			} else {
				void f.host
					.showExtensionCustom((_ui, _theme, _keys, done) => {
						const c = Object.assign(new Container(), { handleInput() {} });
						const mouse = new ListMouse({
							select() {},
							activate: () => {
								done("done");
								return true;
							},
						});
						c.addChild(mouse.row("yes", new Text("Yes", 0, 0)));
						return c;
					})
					.then(resolved);
				await flush();
			}
			f.ui.start();
			f.ui.renderNow();
			try {
				const y =
					f.ui
						.getScreenLines()
						.map(stripTerminalSequences)
						.findIndex((s) => s.includes("Yes")) + 1;
				expect(y).toBeGreaterThan(0);
				f.terminal.sendInput(`\x1b[<0;4;${y}M`);
				void f.host.showExtensionInput("Replacement").then(resolved);
				const replacement = f.host.editorContainer.children[0];
				f.ui.renderNow();
				f.terminal.sendInput(`\x1b[<0;4;${y}m`);
				await flush();
				expect(resolved).not.toHaveBeenCalled();
				expect(f.logout).not.toHaveBeenCalled();
				expect(f.getLogoutProviderOptions).toHaveBeenCalledTimes(kind === "logout" ? 1 : 0);
				expect(f.host.editorContainer.children).toEqual([replacement]);
			} finally {
				f.ui.stop();
				vi.useRealTimers();
			}
		});
});
