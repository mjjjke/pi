import { Input, setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { mouse, mouseContract } from "./helpers/selector-mouse.ts";

function create(count: number) {
	const callback = vi.fn();
	const cancel = vi.fn();
	const selector = new OAuthSelectorComponent(
		"logout",
		Array.from({ length: count }, (_, i) => ({
			id: `model-${String(i).padStart(2, "0")}`,
			name: `model-${String(i).padStart(2, "0")}`,
			authType: "oauth",
		})),
		callback,
		cancel,
	);
	return { selector, selected: () => callback.mock.calls.length, cancelled: () => cancel.mock.calls.length, callback };
}
describe("OAuth selector mouse", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	mouseContract(create, "model-01", "Select provider");
	it("reports mouse provenance", () => {
		const f = create(3);
		mouse(f.selector, "model-01");
		expect(f.callback).toHaveBeenCalledExactlyOnceWith("model-01", "oauth", "mouse");
	});
	for (const path of ["handleInput", "searchSubmit"] as const)
		it(`${path} reports keyboard provenance`, () => {
			const f = create(3);
			if (path === "handleInput") f.selector.handleInput("\r");
			else (f.selector.children.find((child) => child instanceof Input) as Input).onSubmit?.("");
			expect(f.callback).toHaveBeenCalledExactlyOnceWith("model-00", "oauth", "keyboard");
		});
	it("invalidated key leaves the list usable", () => {
		const f = create(3);
		mouse(f.selector, "model-01", { type: "press" });
		f.selector.handleInput("2");
		mouse(f.selector, "model-02", { clickSource: "captured" });
		expect(f.selected()).toBe(0);
		mouse(f.selector, "model-02", { type: "press" });
		mouse(f.selector, "model-02", { clickSource: "captured" });
		expect(f.callback).toHaveBeenCalledExactlyOnceWith("model-02", "oauth", "mouse");
	});
});
