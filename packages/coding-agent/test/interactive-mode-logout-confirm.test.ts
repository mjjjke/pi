import type { AuthInteraction } from "@earendil-works/pi-ai";
import type { Container } from "@earendil-works/pi-tui";
import { Input, setKeybindings, stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import type { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { flush, mouseHost } from "./helpers/mouse-host.ts";
import { mouse } from "./helpers/selector-mouse.ts";

describe("mouse logout confirmation", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterEach(() => vi.useRealTimers());
	for (const authType of ["oauth", "api_key"] as const)
		it(`${authType}: mouse mounts a named confirm immediately; Yes logs out once`, async () => {
			const f = mouseHost([{ id: "fake", name: "Fake Provider", authType }]);
			await f.host.showOAuthSelector("logout");
			mouse(f.host.editorContainer.children[0] as Container, "Fake Provider");
			const confirm = f.host.editorContainer.children[0] as ExtensionSelectorComponent;
			expect(confirm.render(80).map(stripTerminalSequences).join("\n")).toContain("Log out of Fake Provider?");
			expect(confirm.render(120).map(stripTerminalSequences).join("\n")).toContain(
				authType === "oauth"
					? "Stored sign-in credentials will be deleted."
					: "The stored API key will be deleted.",
			);
			expect(f.logout).not.toHaveBeenCalled();
			confirm.handleInput?.("\r");
			await flush();
			expect(f.logout).toHaveBeenCalledOnce();
			expect(f.logout.mock.calls[0][0]).toBe("fake");
		});
	it("names the clicked provider rather than the initial highlight; delayed mouse No reopens", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1000);
		const f = mouseHost([
			{ id: "first", name: "First Provider", authType: "oauth" },
			{ id: "clicked", name: "Clicked Provider", authType: "api_key" },
		]);
		await f.host.showOAuthSelector("logout");
		mouse(f.host.editorContainer.children[0] as Container, "Clicked Provider");
		const confirm = f.host.editorContainer.children[0] as Container;
		expect(confirm.render(80).map(stripTerminalSequences).join("\n")).toContain("Log out of Clicked Provider?");
		vi.setSystemTime(1500);
		mouse(confirm, "No", { type: "press" });
		mouse(confirm, "No", { clickSource: "captured" });
		await flush();
		expect(f.logout).not.toHaveBeenCalled();
		expect(f.getLogoutProviderOptions).toHaveBeenCalledTimes(2);
	});
	for (const answer of ["No", "Esc"] as const)
		it(`${answer} reopens the chooser without logging out`, async () => {
			const f = mouseHost();
			await f.host.showOAuthSelector("logout");
			mouse(f.host.editorContainer.children[0] as Container, "Fake Provider");
			const confirm = f.host.editorContainer.children[0];
			if (answer === "No") {
				confirm.handleInput?.("\x1b[B");
				confirm.handleInput?.("\r");
			} else confirm.handleInput?.("\x1b");
			await flush();
			expect(f.logout).not.toHaveBeenCalled();
			expect(f.getLogoutProviderOptions).toHaveBeenCalledTimes(2);
			expect(f.host.editorContainer.render(80).map(stripTerminalSequences).join("\n")).toContain(
				"Select provider to logout",
			);
		});
	for (const answer of ["No", "Esc"] as const)
		for (const replacementType of ["login", "extension input"] as const)
			it(`${answer}: pending credential refresh preserves a newer ${replacementType}`, async () => {
				const f = mouseHost();
				const login = vi.fn(async (_id: string, _method: string, callbacks: AuthInteraction) => {
					await callbacks.prompt({ type: "secret", message: "Enter dummy key", signal: callbacks.signal });
				});
				const session = Reflect.get(f.host, "runtimeHost").session;
				Object.assign(session, {
					extensionRunner: {
						runUIPrompt: (_kind: string, _message: string, callback: () => unknown) => callback(),
					},
					settingsManager: { getOrCreateDeviceId: () => "test" },
				});
				Object.assign(session.modelRuntime, { login });
				Object.assign(f.host, {
					getLoginProviderOptions: () => [
						{ id: "fake", name: "Fake API", authType: "api_key", method: { name: "Fake API", login() {} } },
					],
				});
				await f.host.showOAuthSelector("logout");
				mouse(f.host.editorContainer.children[0] as Container, "Fake Provider");
				let finish!: (options: unknown[]) => void;
				f.getLogoutProviderOptions.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							finish = resolve;
						}),
				);
				const confirm = f.host.editorContainer.children[0];
				if (answer === "No") {
					confirm.handleInput?.("\x1b[B");
					confirm.handleInput?.("\r");
				} else confirm.handleInput?.("\x1b");
				await flush();
				expect(f.getLogoutProviderOptions).toHaveBeenCalledTimes(2);
				let inputResult: Promise<string | undefined> | undefined;
				if (replacementType === "login") {
					Reflect.apply(Reflect.get(InteractiveMode.prototype, "showLoginProviderSelector"), f.host, ["api_key"]);
					mouse(f.host.editorContainer.children[0] as Container, "Fake API");
					await flush();
					expect(login).toHaveBeenCalledOnce();
				} else inputResult = f.host.showExtensionInput("Replacement");
				const replacement = f.host.editorContainer.children[0];
				replacement.handleInput?.("scratch-input");
				finish([{ id: "fake", name: "Fake Provider", authType: "oauth" }]);
				await flush();
				const current = f.host.editorContainer.children[0];
				if (replacementType === "login") expect(Reflect.get(replacement, "signal").aborted).toBe(false);
				expect(f.logout).not.toHaveBeenCalled();
				// Cancel even on regression so mocked authentication cannot remain orphaned.
				replacement.handleInput?.("\x1b");
				await flush();
				if (inputResult) expect(await inputResult).toBeUndefined();
				expect(current === replacement, "pending logout chooser replaced the newer dialog").toBe(true);
			});
	for (const path of ["handleInput", "searchSubmit"] as const)
		it(`${path}: keyboard logout is direct`, async () => {
			const f = mouseHost();
			await f.host.showOAuthSelector("logout");
			const selector = f.host.editorContainer.children[0] as OAuthSelectorComponent;
			if (path === "handleInput") selector.handleInput?.("\r");
			else (selector.children.find((c) => c instanceof Input) as Input).onSubmit?.("");
			await flush();
			expect(f.logout).toHaveBeenCalledOnce();
			expect(f.host.editorContainer.children).toEqual([f.host.editor]);
		});
	it("displaced confirm never logs out or reopens the chooser", async () => {
		const f = mouseHost();
		await f.host.showOAuthSelector("logout");
		mouse(f.host.editorContainer.children[0] as Container, "Fake Provider");
		void f.host.showExtensionInput("Replacement");
		const replacement = f.host.editorContainer.children[0];
		await flush();
		expect(f.logout).not.toHaveBeenCalled();
		expect(f.getLogoutProviderOptions).toHaveBeenCalledTimes(1);
		expect(f.host.editorContainer.children).toEqual([replacement]);
	});
	for (const lateRelease of [false, true])
		it(`fullscreen spill rejects an early Yes press (late release: ${lateRelease})`, async () => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(1000);
			const f = mouseHost();
			await f.host.showOAuthSelector("logout");
			f.ui.start();
			f.ui.renderNow();
			const row = (text: string) => {
				const y =
					f.ui
						.getScreenLines()
						.map(stripTerminalSequences)
						.findIndex((s) => s.includes(text)) + 1;
				expect(y).toBeGreaterThan(0);
				return y;
			};
			const send = (y: number, release: boolean) => f.terminal.sendInput(`\x1b[<0;4;${y}${release ? "m" : "M"}`);
			try {
				const providerRow = row("Fake Provider");
				send(providerRow, false);
				send(providerRow, true);
				f.ui.renderNow();
				const y = row("Yes");
				vi.setSystemTime(1100);
				send(y, false);
				if (lateRelease) vi.setSystemTime(1600);
				send(y, true);
				await flush();
				expect(f.logout).not.toHaveBeenCalled();
				expect(f.host.editorContainer.render(80).map(stripTerminalSequences).join("\n")).toContain(
					"Log out of Fake Provider?",
				);
				vi.setSystemTime(1700);
				send(y, false);
				send(y, true);
				await flush();
				expect(f.logout).toHaveBeenCalledOnce();
			} finally {
				f.ui.stop();
			}
		});
});
