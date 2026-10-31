import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { setPointerHoverBackground } from "../src/components/list-mouse.ts";
import { SelectList } from "../src/components/select-list.ts";
import { SettingsList } from "../src/components/settings-list.ts";
import { Spacer } from "../src/components/spacer.ts";
import { setCapabilities } from "../src/terminal-image.ts";
import type { Component, TuiMouseDispatchTarget } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const bg = "\x1b[48;5;235m";
const identity = (text: string) => text;
const settingsTheme = { label: identity, value: identity, description: identity, cursor: "→ ", hint: identity };
const selectTheme = {
	selectedPrefix: identity,
	selectedText: identity,
	description: identity,
	scrollInfo: identity,
	noMatch: identity,
};
afterEach(() => setPointerHoverBackground(undefined));

// Every ordered pair includes the selected row: pointer ownership must not depend on paint.
for (const surface of ["settings", "select"] as const) {
	for (const depth of [0, 1, 2, 4, 8, 32]) {
		for (const color of [false, true]) {
			for (const renderBetween of [false, true]) {
				it(`${surface} first re-entry: depth=${depth}, color=${color}, render=${renderBetween}`, async (t) => {
					if (color) setPointerHoverBackground(() => bg);
					setCapabilities({ images: null, trueColor: true, hyperlinks: true, pointerShapes: true });
					let activations = 0;
					const items = ["A", "B", "C", "D"].map((label) => ({
						id: label,
						value: label,
						label,
						currentValue: "off",
						values: ["off", "on"],
					}));
					const leaf =
						surface === "settings"
							? new SettingsList(
									items,
									3,
									settingsTheme,
									() => activations++,
									() => {},
								)
							: new SelectList(items, 3, selectTheme);
					if (leaf instanceof SelectList) leaf.onSelect = () => activations++;
					const box = new Box(2, 1);
					box.addChild(new Spacer(1));
					box.addChild(leaf);
					box.addChild(new Spacer(1));
					let root: Component = box;
					for (let i = 0; i < depth; i++) {
						const child = root;
						const parent = new SettingsList(
							[{ id: "sub", label: "Sub", currentValue: "", submenu: () => child }],
							5,
							settingsTheme,
							() => activations++,
							() => {},
						);
						parent.handleInput("\r");
						root = parent;
					}
					const terminal = new VirtualTerminal(40, 20);
					const tui = new TuiAltScreen(terminal);
					t.after(() => tui.stop());
					const writes: string[] = [];
					const write = terminal.write.bind(terminal);
					terminal.write = (data) => {
						writes.push(data);
						write(data);
					};
					const owner = () =>
						(tui as unknown as { mouseHover?: { target: TuiMouseDispatchTarget; hoverValid?: () => boolean } })
							.mouseHover;
					const move = (x: number, y: number) => terminal.sendInput(`\x1b[<35;${x + 1};${y + 1}M`);
					tui.addChild(root);
					tui.setFocus(leaf);
					tui.start();
					tui.renderNow();
					const before = tui.getScreenLines();
					const exits = [
						[4, 0],
						[4, 1],
						[4, 5],
						[4, before.length - 1],
						[0, 3],
						[39, 3],
						[4, 18],
					];
					// SettingsList also owns inert description/hint rows, unlike the surrounding Box.
					if (surface === "settings") exits.push([4, 6], [4, 7]);
					for (const from of [2, 3, 4]) {
						for (const to of [2, 3, 4]) {
							for (const [x, y] of exits) {
								move(4, from);
								tui.renderNow();
								const old = owner()!;
								assert.equal(old.target.component, leaf);
								assert.equal(old.hoverValid?.(), true);
								move(x, y);
								if (renderBetween) tui.renderNow();
								assert.equal(old.hoverValid?.(), false);
								assert.ok(
									!owner() || owner()!.target.component === leaf,
									"cleanup must not acquire a parent owner",
								);
								writes.length = 0;
								move(4, to);
								tui.renderNow();
								assert.equal(owner()?.target.component, leaf);
								assert.equal(owner()?.hoverValid?.(), true, `${from}->(${x},${y})->${to}`);
								assert.equal(old.hoverValid?.(), false, "old episodes cannot revive");
								const painted = tui.getScreenLines().flatMap((line, row) => (line.includes(bg) ? [row] : []));
								assert.deepEqual(painted, color && to !== 2 ? [to] : []);
								assert.ok(writes.join("").includes("\x1b]22;pointer\x1b\\"));
								assert.equal(tui.getFocusedComponent(), leaf);
							}
						}
					}
					assert.equal(activations, 0);
					assert.ok(items.every((item) => item.currentValue === "off"));
					await terminal.flush();
					assert.ok(terminal.getViewport()[4].includes("C"));
				});
			}
		}
	}
}
