import { type Component, Container, Input } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { TuiAltScreen } from "../../../tui/src/tui-alt-screen.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import type { AuthSelectorProvider } from "../../src/modes/interactive/components/oauth-selector.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";

interface MouseHost {
	ui: TuiAltScreen;
	editor: Input;
	editorContainer: Container;
	showOAuthSelector(mode: "logout"): Promise<void>;
	showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
	showExtensionInput(title: string): Promise<string | undefined>;
	showExtensionCustom(
		factory: (ui: TuiAltScreen, theme: unknown, keys: KeybindingsManager, done: (value: string) => void) => Component,
	): Promise<string>;
}
export function mouseHost(
	providers: AuthSelectorProvider[] = [{ id: "fake", name: "Fake Provider", authType: "oauth" }],
) {
	const terminal = new VirtualTerminal(80, 32);
	const ui = new TuiAltScreen(terminal);
	const editor = Object.assign(new Input(), { getText: () => "", setText: () => {} });
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	ui.addChild(editorContainer);
	ui.setFocus(editor);
	const logout = vi.fn().mockResolvedValue(undefined);
	const getLogoutProviderOptions = vi.fn().mockResolvedValue(providers);
	const host = Object.assign(Object.create(InteractiveMode.prototype) as MouseHost, {
		ui,
		editor,
		editorContainer,
		keybindings: new KeybindingsManager(),
		programStatus: { setBlocked: vi.fn() },
		runtimeHost: { session: { modelRuntime: { logout } } },
		getLogoutProviderOptions,
		updateAvailableProviderCount: vi.fn().mockResolvedValue(undefined),
		showStatus: vi.fn(),
		showError: vi.fn(),
	});
	return { host, terminal, ui, logout, getLogoutProviderOptions };
}
export async function flush() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}
