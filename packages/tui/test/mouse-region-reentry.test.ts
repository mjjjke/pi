import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { Box } from "../src/components/box.ts";
import { ListMouse, setPointerHoverBackground } from "../src/components/list-mouse.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { SelectList } from "../src/components/select-list.ts";
import { SettingsList } from "../src/components/settings-list.ts";
import { setCapabilities } from "../src/terminal-image.ts";
import { type Component, Container, dispatchMouseEvent, type TuiMouseDispatchTarget } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const identity = (text: string) => text;
const theme = {
	selectedPrefix: identity,
	selectedText: identity,
	description: identity,
	scrollInfo: identity,
	noMatch: identity,
};
const bg = "\x1b[48;5;235m";
afterEach(() => setPointerHoverBackground(undefined));

// Review F1: the old wrapper's leave follows the new child's move. Include selected
// rows (ownership without paint), every row order, and both ownership directions.
for (const wrapper of ["MouseRegion", "ListMouseRegion"] as const) {
	for (const depth of [0, 1, 3]) {
		for (const color of [false, true]) {
			for (const renderBetween of [false, true]) {
				it(`${wrapper} re-entry: depth=${depth}, color=${color}, render=${renderBetween}`, async (t) => {
					if (color) setPointerHoverBackground(() => bg);
					setCapabilities({ images: null, trueColor: true, hyperlinks: true, pointerShapes: true });
					let actions = 0;
					const leaf = new SelectList(
						[
							{ value: "a", label: "A" },
							{ value: "b", label: "B" },
						],
						5,
						theme,
					);
					leaf.onSelect = () => actions++;
					leaf.onSelectionChange = () => actions++;
					const box = new Box(2, 1);
					box.addChild(leaf);
					const mouse = new ListMouse<string>({
						select: () => actions++,
						activate: () => {
							actions++;
							return true;
						},
					});
					mouse.addRow("parent", 0, 4);
					const region =
						wrapper === "ListMouseRegion"
							? mouse.row("parent", box)
							: new MouseRegion(box, (e) => mouse.handle(e));
					mouse.commitRows();
					// Both transparent forwarders must preserve the nested exact owner.
					const container = new Container();
					container.addChild(region);
					let mounted: Component = container;
					for (let i = 0; i < depth; i++) {
						const child = mounted;
						const settings = new SettingsList(
							[{ id: "sub", label: "Sub", currentValue: "", submenu: () => child }],
							5,
							{ label: identity, value: identity, description: identity, cursor: "→ ", hint: identity },
							() => actions++,
							() => {},
						);
						settings.handleInput("\r");
						mounted = settings;
					}
					const terminal = new VirtualTerminal(40, 12);
					const tui = new TuiAltScreen(terminal);
					t.after(() => tui.stop());
					const writes: string[] = [];
					const write = terminal.write.bind(terminal);
					terminal.write = (data) => {
						writes.push(data);
						write(data);
					};
					const move = (x: number, y: number) => terminal.sendInput(`\x1b[<35;${x + 1};${y + 1}M`);
					const owner = () =>
						(tui as unknown as { mouseHover?: { target: TuiMouseDispatchTarget; hoverValid?: () => boolean } })
							.mouseHover;
					tui.addChild(mounted);
					tui.setFocus(leaf);
					tui.start();
					tui.renderNow();
					for (const from of [1, 2]) {
						for (const to of [1, 2]) {
							for (const [x, y] of [
								[0, 2],
								[39, 1],
								[3, 0],
								[3, 3],
							]) {
								move(3, from);
								tui.renderNow();
								const oldLeaf = owner()!;
								assert.equal(oldLeaf.target.component, leaf);
								assert.equal(oldLeaf.hoverValid?.(), true);
								move(x, y);
								if (renderBetween) tui.renderNow();
								const parent = owner()!;
								assert.equal(parent.target.component, region);
								assert.equal(parent.hoverValid?.(), true);
								assert.equal(oldLeaf.hoverValid?.(), false);
								writes.length = 0;
								move(3, to);
								tui.renderNow();
								assert.equal(owner()?.target.component, leaf);
								assert.equal(owner()?.hoverValid?.(), true, `${from}->(${x},${y})->${to}`);
								assert.equal(parent.hoverValid?.(), false, "end only the previous wrapper episode");
								assert.equal(oldLeaf.hoverValid?.(), false, "old leaf episode cannot revive");
								assert.deepEqual(
									tui.getScreenLines().flatMap((line, row) => (line.includes(bg) ? [row] : [])),
									color && to === 2 ? [2] : [],
								);
								assert.equal((tui as unknown as { pointerShape: string }).pointerShape, "pointer");
								assert.ok(!writes.join("").includes("\x1b]22;default\x1b\\"));
								assert.equal(tui.getFocusedComponent(), leaf);
							}
						}
					}
					assert.equal(actions, 0);
					await terminal.flush();
					assert.ok(terminal.getViewport()[2].includes("B"));
				});
			}
		}
	}
}

it("nested dispatch cannot readdress a saved owner's leave after copying coordinates", () => {
	const seen: string[] = [];
	const child: Component = {
		render: () => ["child"],
		invalidate() {},
		handleMouse: () => {
			seen.push("child");
			return { handled: true };
		},
	};
	const parent = new MouseRegion(child, (event) => {
		// Even a forwarder using exact dispatch must not replace an existing address.
		const forwarded = dispatchMouseEvent(child, { ...event, x: event.x - 2 });
		seen.push("parent");
		return forwarded ?? { handled: true };
	});
	dispatchMouseEvent(parent, {
		type: "leave",
		button: "none",
		x: 100,
		y: -100,
		screenX: 100,
		screenY: -100,
		width: 40,
		height: 1,
		shift: false,
		alt: false,
		ctrl: false,
	});
	assert.deepEqual(seen, ["parent"]);
});

for (const wrapper of ["Container", "Box", "MouseRegion", "ListMouseRegion"] as const) {
	it(`${wrapper} never hit-tests a leave into its current child`, () => {
		const seen: string[] = [];
		const child: Component = {
			render: () => ["child"],
			invalidate() {},
			handleMouse: (event) => {
				seen.push(event.type);
				return { handled: true };
			},
		};
		const mouse = new ListMouse<string>({ select() {}, activate: () => false });
		const region =
			wrapper === "Container"
				? new Container()
				: wrapper === "Box"
					? new Box(0, 0)
					: wrapper === "MouseRegion"
						? new MouseRegion(child, () => {
								seen.push("own leave");
								return { handled: true };
							})
						: mouse.row("parent", child);
		if (region instanceof Container || region instanceof Box) region.addChild(child);
		region.render(40);
		for (const [x, y] of [
			[0, 0],
			[-100, 100],
		]) {
			dispatchMouseEvent(region, {
				type: "leave",
				button: "none",
				x,
				y,
				screenX: x,
				screenY: y,
				width: 40,
				height: 1,
				shift: false,
				alt: false,
				ctrl: false,
			});
		}
		assert.deepEqual(seen, wrapper === "MouseRegion" ? ["own leave", "own leave"] : []);
	});
}
