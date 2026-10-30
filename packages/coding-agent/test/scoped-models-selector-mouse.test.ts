import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { models, mouse, mouseContract } from "./helpers/selector-mouse.ts";

function create(count: number) {
	const onChange = vi.fn();
	const cancel = vi.fn();
	const selector = new ScopedModelsSelectorComponent(
		{ allModels: models(count), enabledModelIds: null },
		{ onChange, onPersist: vi.fn(), onCancel: cancel },
	);
	return { selector, selected: () => onChange.mock.calls.length, cancelled: () => cancel.mock.calls.length, onChange };
}
describe("scoped selector mouse", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	mouseContract(create);
	it("toggle keeps the row index after reordering, and save is not terminal", () => {
		const f = create(3);
		mouse(f.selector, "model-01", { type: "press" });
		mouse(f.selector, "model-01", { clickSource: "captured" });
		expect(f.onChange).toHaveBeenLastCalledWith(["fake/model-00", "fake/model-02"]);
		expect(stripAnsi(f.selector.render(80).join("\n"))).toContain("→ ✓ model-02");
		f.selector.handleInput("\x13");
		mouse(f.selector, "model-02", { type: "press" });
		mouse(f.selector, "model-02", { clickSource: "captured" });
		expect(f.selected()).toBe(2);
	});
	it("invalidated key leaves the list usable", () => {
		const f = create(3);
		mouse(f.selector, "model-01", { type: "press" });
		f.selector.updateModels([models(3)[2]]);
		mouse(f.selector, "model-02", { clickSource: "captured" });
		expect(f.selected()).toBe(0);
		mouse(f.selector, "model-02", { type: "press" });
		mouse(f.selector, "model-02", { clickSource: "captured" });
		expect(f.selected()).toBe(1);
	});
});
