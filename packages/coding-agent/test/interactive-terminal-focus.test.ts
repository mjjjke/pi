import { afterEach, describe, expect, it } from "vitest";
import { TuiAltScreen } from "../../tui/src/tui-alt-screen.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionAPI, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

function invoke(name: string, mode: object, ...args: unknown[]): unknown {
	return Reflect.apply(Reflect.get(InteractiveMode.prototype, name), mode, args);
}
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("interactive terminal focus", () => {
	it("mirrors focus, routes to the current runtime after reload and rebinds a renderer", async () => {
		const calls: boolean[][] = [];
		const factory = (pi: ExtensionAPI) => {
			const events: boolean[] = [];
			calls.push(events);
			pi.on("terminal_focus", (event, ctx) => {
				expect(ctx.ui.terminalFocus()).toBe(event.focused);
				events.push(event.focused);
			});
		};
		let extensions = await createTestExtensionsResult([factory]);
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getExtensions = () => extensions;
		resourceLoader.reload = async () => {
			extensions = await createTestExtensionsResult([factory]);
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		const terminal = new VirtualTerminal();
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session: harness.session },
			ui: new TuiMainScreen(terminal),
		});
		const ui = invoke("createExtensionUIContext", mode) as ExtensionUIContext;
		await harness.session.bindExtensions({ uiContext: ui, mode: "tui" });
		invoke("bindTerminalFocusListener", mode);
		mode.ui.start();
		try {
			expect(ui.terminalFocus()).toBeUndefined();
			terminal.sendInput("\x1b[I");
			await Promise.resolve();
			expect(calls[0]).toEqual([true]);
			await harness.session.reload();
			terminal.sendInput("\x1b[O");
			await Promise.resolve();
			expect(calls[0]).toEqual([true]);
			expect(calls[1]).toEqual([false]);
			const old = mode.ui;
			old.stop();
			mode.ui = new TuiAltScreen(terminal);
			invoke("bindTerminalFocusListener", mode);
			mode.ui.start();
			expect(ui.terminalFocus()).toBeUndefined();
			terminal.sendInput("\x1b[I");
			await Promise.resolve();
			expect(calls[1]).toEqual([false, true]);
		} finally {
			mode.ui.stop();
		}
	});

	it("no-op contexts report unknown", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(harness.session.extensionRunner.getUIContext().terminalFocus()).toBeUndefined();
	});
});
