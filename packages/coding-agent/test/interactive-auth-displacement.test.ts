import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { Input, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import type { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { flush, mouseHost } from "./helpers/mouse-host.ts";
import { mouse } from "./helpers/selector-mouse.ts";

const invoke = (host: object, name: string, ...args: unknown[]) =>
	Reflect.apply(Reflect.get(InteractiveMode.prototype, name), host, args);

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function setup(login: (id: string, method: string, interaction: AuthInteraction) => Promise<unknown>) {
	const f = mouseHost();
	// Real per-provider serialization and login/logout entry points; no credential storage or provider APIs.
	const logout = vi.fn().mockResolvedValue(undefined);
	const runtime = Object.create(ModelRuntime.prototype) as ModelRuntime;
	Object.assign(runtime, {
		credentialOperations: new Map<string, Promise<void>>(),
		models: { login, logout },
		synchronizeCredentialState: vi.fn().mockResolvedValue(undefined),
	});
	Object.assign(Reflect.get(f.host, "runtimeHost").session, {
		modelRuntime: runtime,
		settingsManager: { getOrCreateDeviceId: () => "scratch" },
		extensionRunner: { runUIPrompt: (_kind: string, _message: string, callback: () => unknown) => callback() },
	});
	Object.assign(f.host, { completeProviderAuthentication: vi.fn().mockResolvedValue(undefined) });
	return { ...f, runtime, providerLogout: logout };
}

function promptOf(type: "select" | "secret" | "manual_code"): AuthPrompt {
	return type === "select"
		? { type, message: "Choose dummy method", options: [{ id: "one", label: "One" }] }
		: { type, message: "Enter dummy input" };
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

for (const method of ["api_key", "oauth"] as const) {
	const entry = method === "api_key" ? "showApiKeyLoginDialog" : "showLoginDialog";
	for (const type of ["select", "secret", "manual_code"] as const) {
		it(`${method}: displacement cancels pending ${type} and releases same-provider logout`, async () => {
			const requested = deferred<void>();
			let interaction!: AuthInteraction;
			let promptResult!: Promise<string>;
			const f = setup(async (_id, _method, callbacks) => {
				interaction = callbacks;
				// Deliberately omit prompt.signal: the login's own lifetime must still apply.
				promptResult = callbacks.prompt(promptOf(type));
				requested.resolve();
				await promptResult;
			});
			const back = vi.fn();
			const login = invoke(f.host, entry, "fake", "Fake", back) as Promise<void>;
			const dialog = f.host.editorContainer.children[0] as LoginDialogComponent;
			await requested.promise;
			const pendingComponent = f.host.editorContainer.children[0];
			const next = f.runtime.logout("fake");
			await flush();
			expect(f.providerLogout).not.toHaveBeenCalled();
			const input = f.host.showExtensionInput("New input");
			const replacement = f.host.editorContainer.children[0];
			try {
				expect(interaction.signal?.aborted).toBe(true);
				await expect(promptResult).rejects.toThrow("Login cancelled");
				await login;
				await next;
				expect(f.providerLogout).toHaveBeenCalledOnce();
				expect(back).not.toHaveBeenCalled();
				expect(f.host.editorContainer.children).toEqual([replacement]);
				// A stale selector callback cannot restore the login over the replacement.
				pendingComponent.handleInput?.("\r");
				await flush();
				expect(f.host.editorContainer.children).toEqual([replacement]);
				await expect(interaction.prompt(promptOf(type))).rejects.toThrow("Login cancelled");
				expect(f.host.editorContainer.children).toEqual([replacement]);
			} finally {
				dialog.handleInput("\x1b");
				replacement.handleInput?.("\x1b");
				await input;
			}
		});

		it(`${method}: a late ${type} request cannot mount after displacement`, async () => {
			const gate = deferred<void>();
			const requested = deferred<void>();
			let interaction!: AuthInteraction;
			const f = setup(async (_id, _method, callbacks) => {
				interaction = callbacks;
				requested.resolve();
				await gate.promise;
				await callbacks.prompt(promptOf(type));
			});
			const back = vi.fn();
			const login = invoke(f.host, entry, "fake", "Fake", back) as Promise<void>;
			const dialog = f.host.editorContainer.children[0] as LoginDialogComponent;
			await requested.promise;
			const input = f.host.showExtensionInput("Replacement");
			const replacement = f.host.editorContainer.children[0];
			gate.resolve();
			await flush();
			try {
				expect(interaction.signal?.aborted).toBe(true);
				await login;
				expect(back).not.toHaveBeenCalled();
				expect(f.host.editorContainer.children).toEqual([replacement]);
			} finally {
				dialog.handleInput("\x1b");
				replacement.handleInput?.("\x1b");
				await input;
			}
		});
	}

	for (const replacementType of ["select", "custom", "editor"] as const) {
		it(`${method}: displacement by extension ${replacementType} allows a fresh same-provider login`, async () => {
			const requested = deferred<void>();
			let calls = 0;
			const f = setup(async (_id, _method, callbacks) => {
				calls++;
				const response = callbacks.prompt(promptOf("secret"));
				requested.resolve();
				await response;
			});
			const first = invoke(f.host, entry, "fake", "Fake") as Promise<void>;
			const firstDialog = f.host.editorContainer.children[0] as LoginDialogComponent;
			await requested.promise;
			let replacement: Promise<unknown> | undefined;
			if (replacementType === "select") replacement = f.host.showExtensionSelector("New selector", ["OK"]);
			else if (replacementType === "custom") {
				replacement = f.host.showExtensionCustom((_ui, _theme, _keys, done) => {
					const component = new Input();
					component.onEscape = () => done("");
					return component;
				});
				await flush();
			} else {
				Object.assign(f.host, { defaultEditor: { onSubmit: undefined, onChange: undefined } });
				invoke(f.host, "setCustomEditorComponent", () =>
					Object.assign(new Input(), {
						setText: () => {},
						getText: () => "",
					}),
				);
			}
			const mounted = f.host.editorContainer.children[0];
			try {
				expect(firstDialog.signal.aborted).toBe(true);
				await first;
				expect(f.host.editorContainer.children).toEqual([mounted]);
				mounted.handleInput?.("\x1b");
				await replacement;
				const second = invoke(f.host, entry, "fake", "Fake") as Promise<void>;
				const secondDialog = f.host.editorContainer.children[0] as LoginDialogComponent;
				await flush();
				expect(calls).toBe(2);
				expect(secondDialog.signal.aborted).toBe(false);
				secondDialog.handleInput("\x1b");
				await second;
			} finally {
				firstDialog.handleInput("\x1b");
				mounted.handleInput?.("\x1b");
			}
		});
	}

	for (const source of ["keyboard", "mouse"] as const) {
		it(`${method}: own selector transitions still reach input (${source})`, async () => {
			let signal: AbortSignal | undefined;
			const f = setup(async (_id, _method, callbacks) => {
				signal = callbacks.signal;
				expect(await callbacks.prompt(promptOf("select"))).toBe("one");
				expect(await callbacks.prompt(promptOf("secret"))).toBe("dummy");
				expect(await callbacks.prompt(promptOf("manual_code"))).toBe("code");
			});
			const login = invoke(f.host, entry, "fake", "Fake") as Promise<void>;
			const dialog = f.host.editorContainer.children[0] as LoginDialogComponent;
			await flush();
			const selector = f.host.editorContainer.children[0];
			if (source === "keyboard") selector.handleInput?.("\r");
			else mouse(selector as LoginDialogComponent, "One");
			await flush();
			expect(f.host.editorContainer.children).toEqual([dialog]);
			dialog.handleInput("dummy");
			dialog.handleInput("\r");
			await flush();
			dialog.handleInput("code");
			dialog.handleInput("\r");
			await login;
			expect(signal?.aborted).toBe(false);
			expect(f.host.editorContainer.children).toEqual([f.host.editor]);
		});
	}
}

it("initial logout enumeration preserves UI opened while lookup was pending", async () => {
	const f = mouseHost();
	const lookup = deferred<unknown[]>();
	f.getLogoutProviderOptions.mockImplementationOnce(() => lookup.promise);
	const logout = f.host.showOAuthSelector("logout");
	const input = f.host.showExtensionInput("New input");
	const replacement = f.host.editorContainer.children[0];
	lookup.resolve([{ id: "fake", name: "Fake", authType: "oauth" }]);
	await logout;
	const current = f.host.editorContainer.children[0];
	replacement.handleInput?.("\x1b");
	await input;
	expect(current).toBe(replacement);
});

for (const method of ["api_key", "oauth"] as const) {
	it(`${method} login displaced while mounting (custom editor blur) is cancelled`, async () => {
		const providerLogin = vi.fn(async (_id: string, _method: string, callbacks: AuthInteraction) => {
			await callbacks.prompt(promptOf("secret"));
		});
		const f = setup(providerLogin);
		Object.assign(f.host, {
			defaultEditor: f.host.editor,
			getLoginProviderOptions: () => [
				{ id: "fake", name: "Fake", authType: method, method: { name: "Fake", login() {} } },
			],
		});
		const uiContext = invoke(f.host, "createExtensionUIContext") as {
			setEditorComponent: (factory: () => Input) => void;
			input: (title: string) => Promise<string | undefined>;
		};
		let armed = false;
		let focused = false;
		let replacementInput: Promise<string | undefined> | undefined;
		// A custom editor that opens an input when it loses focus displaces the login while it mounts.
		uiContext.setEditorComponent(() => {
			const custom = Object.assign(new Input(), { getText: () => "", setText: () => {} });
			Object.defineProperty(custom, "focused", {
				get: () => focused,
				set: (value: boolean) => {
					focused = value;
					if (armed && !value) {
						armed = false;
						replacementInput = uiContext.input("Replacement opened on blur");
					}
				},
			});
			return custom;
		});
		armed = true;
		await invoke(f.host, "handleLoginCommand", "fake");
		const replacement = f.host.editorContainer.children[0];
		expect(replacementInput).toBeDefined();
		expect(providerLogin).not.toHaveBeenCalled();
		await f.runtime.logout("fake");
		expect(f.providerLogout).toHaveBeenCalledTimes(1);
		expect(f.host.editorContainer.children[0]).toBe(replacement);
		replacement.handleInput?.("\x1b");
		await replacementInput;
	});
}
