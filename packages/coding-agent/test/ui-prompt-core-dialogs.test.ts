import type { AuthPrompt } from "@earendil-works/pi-ai";
import { Container, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ProjectTrustContext, UIPromptEndEvent, UIPromptStartEvent } from "../src/core/extensions/types.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createHarness, createTestUiContext, type Harness } from "./suite/harness.ts";

function invoke(name: string, mode: object, ...args: unknown[]): unknown {
	return Reflect.apply(Reflect.get(InteractiveMode.prototype, name), mode, args);
}
const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});
beforeAll(() => initTheme("dark"));
async function setup() {
	const events: Array<UIPromptStartEvent | UIPromptEndEvent> = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("ui_prompt_start", (event) => {
					events.push(event);
				});
				pi.on("ui_prompt_end", (event) => {
					events.push(event);
				});
			},
		],
	});
	harnesses.push(harness);
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		ui: new TuiMainScreen(new VirtualTerminal()),
		editorContainer: new Container(),
		programStatus: { setBlocked() {} },
	});
	const ui = createTestUiContext();
	harness.session.extensionRunner.setUIContext(ui, "tui");
	return { harness, mode, ui, events };
}
async function assertExtensionPair(harness: Harness, events: Array<UIPromptStartEvent | UIPromptEndEvent>) {
	events.length = 0;
	await harness.session.extensionRunner.getUIContext().input("extension");
	await Promise.resolve();
	expect(events.map((event) => [event.type, event.title, event.source])).toEqual([
		["ui_prompt_start", "extension", undefined],
		["ui_prompt_end", "extension", undefined],
	]);
}

describe("core prompt lifecycle", () => {
	it("trust select is sourced and shares depth with nested extension prompts", async () => {
		const { harness, mode, events } = await setup();
		Reflect.set(mode, "showExtensionSelector", async () => {
			await harness.session.extensionRunner.getUIContext().input("nested");
			return "Yes";
		});
		const trust = invoke("createProjectTrustContext", mode, "/untrusted") as ProjectTrustContext;
		expect(await trust.ui.select("Trust project folder?\n/untrusted", ["Yes", "No"])).toBe("Yes");
		await Promise.resolve();
		expect(events).toEqual([
			{
				type: "ui_prompt_start",
				reason: "ui_prompt",
				kind: "select",
				title: "Trust project folder?\n/untrusted",
				source: "project_trust",
			},
			{
				type: "ui_prompt_end",
				reason: "ui_prompt",
				kind: "select",
				title: "Trust project folder?\n/untrusted",
				source: "project_trust",
			},
		]);
		await assertExtensionPair(harness, events);
	});

	it.each(["browser", "already-aborted", "escape", "login-failure"] as const)(
		"auth %s balances depth",
		async (scenario) => {
			const { harness, mode, events } = await setup();
			const dialog = new LoginDialogComponent(mode.ui, "test", () => {});
			const abort = new AbortController();
			const done = new AbortController();
			if (scenario === "already-aborted") abort.abort();
			const prompt: AuthPrompt = {
				type: "manual_code",
				message: "Paste callback code",
				...(scenario !== "login-failure" ? { signal: abort.signal } : {}),
			};
			const response = invoke("showAuthPrompt", mode, dialog, prompt, "test", done.signal) as Promise<string>;
			const rejected = expect(response).rejects.toThrow("Login cancelled");
			await Promise.resolve();
			if (scenario === "browser") abort.abort();
			else if (scenario === "escape") dialog.handleInput("\x1b");
			else if (scenario === "login-failure") done.abort();
			await rejected;
			await Promise.resolve();
			expect(events.map((event) => [event.type, event.source, event.title])).toEqual(
				scenario === "already-aborted"
					? []
					: [
							["ui_prompt_start", "auth", "Paste callback code"],
							["ui_prompt_end", "auth", "Paste callback code"],
						],
			);
			await assertExtensionPair(harness, events);
		},
	);

	it("login finally ends a prompt without a provider signal", async () => {
		const { harness, mode, events } = await setup();
		const dialog = new LoginDialogComponent(mode.ui, "test", () => {});
		let response: Promise<string> | undefined;
		Reflect.set(
			harness.session.modelRuntime,
			"login",
			async (_id: string, _method: string, callbacks: { prompt(prompt: AuthPrompt): Promise<string> }) => {
				response = callbacks.prompt({ type: "manual_code", message: "code" });
				void response.catch(() => {});
				throw new Error("provider failed");
			},
		);
		await expect(invoke("loginProvider", mode, dialog, "test", "Test", "oauth")).rejects.toThrow("provider failed");
		await expect(response).rejects.toThrow("Login cancelled");
		await Promise.resolve();
		expect(events.map((event) => event.type)).toEqual(["ui_prompt_start", "ui_prompt_end"]);
		await assertExtensionPair(harness, events);
	});
});
