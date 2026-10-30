import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ProjectTrustOption } from "../src/core/trust-manager.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { mouse, mouseContract } from "./helpers/selector-mouse.ts";

function create() {
	const callback = vi.fn();
	const cancel = vi.fn();
	const selector = new TrustSelectorComponent({
		cwd: "/project",
		savedDecision: null,
		projectTrusted: false,
		onSelect: callback,
		onCancel: cancel,
	});
	return { selector, callback, selected: () => callback.mock.calls.length, cancelled: () => cancel.mock.calls.length };
}
describe("trust selector mouse", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	mouseContract(create, "Trust parent folder", "Current session", false);
	it("a missing static option does not close mouse admission", () => {
		const f = create();
		mouse(f.selector, "Do not trust", { type: "press" });
		// Trust options do not change in production; exercise the adapter's bounds guard.
		(f.selector as unknown as { trustOptions: ProjectTrustOption[] }).trustOptions.pop();
		mouse(f.selector, "Do not trust", { clickSource: "captured" });
		expect(f.selected()).toBe(0);
		mouse(f.selector, "Trust parent folder", { type: "press" });
		mouse(f.selector, "Trust parent folder", { clickSource: "captured" });
		expect(f.selected()).toBe(1);
	});
	it("click saves the selected trust decision", () => {
		const f = create();
		mouse(f.selector, "Trust parent folder", { type: "press" });
		mouse(f.selector, "Trust parent folder", { clickSource: "captured" });
		expect(f.callback).toHaveBeenCalledExactlyOnceWith({
			trusted: true,
			updates: [
				{ path: "/", decision: true },
				{ path: "/project", decision: null },
			],
		});
	});
});
