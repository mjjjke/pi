import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { refreshModelCatalogs } from "../src/modes/interactive/model-catalog-refresh.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { models, mouse, mouseContract } from "./helpers/selector-mouse.ts";

vi.mock("../src/modes/interactive/model-catalog-refresh.ts", () => ({
	refreshModelCatalogs: vi.fn(() => new Promise(() => {})),
}));
function createModelSelector(count: number) {
	const tui = { requestRender() {} } as unknown as TUI;
	const items = models(count);
	const selected = vi.fn();
	const cancel = vi.fn();
	const runtime = {
		getAvailableSnapshot: () => items,
		getModel: () => undefined,
		getError: () => undefined,
	} as unknown as ModelRuntime;
	const selector = new ModelSelectorComponent(tui, undefined, runtime, [], selected, cancel);
	return {
		selector,
		items,
		selected: () => selected.mock.calls.length,
		callback: selected,
		cancelled: () => cancel.mock.calls.length,
		dispose: () => selector.dispose(),
	};
}

describe("model selector mouse", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	mouseContract(createModelSelector);
	it("refresh reordering retains the press-time model identity", async () => {
		vi.mocked(refreshModelCatalogs).mockResolvedValueOnce({ aborted: false, errors: new Map() });
		const f = createModelSelector(3);
		const pressedModel = f.items[1];
		try {
			mouse(f.selector, "model-01", { type: "press" });
			f.items.reverse();
			await Promise.resolve();
			mouse(f.selector, "model-00", { clickSource: "captured" });
			expect(f.callback).toHaveBeenCalledExactlyOnceWith(pressedModel);
		} finally {
			f.dispose();
		}
	});
	it("invalidated press key does not close the list", () => {
		const f = createModelSelector(3);
		try {
			mouse(f.selector, "model-01", { type: "press" });
			f.selector.handleInput("2");
			mouse(f.selector, "model-02", { clickSource: "captured" });
			expect(f.selected()).toBe(0);
			mouse(f.selector, "model-02", { type: "press" });
			mouse(f.selector, "model-02", { clickSource: "captured" });
			expect(f.callback).toHaveBeenCalledExactlyOnceWith(models(3)[2]);
		} finally {
			f.dispose();
		}
	});
	it("wrapped row continuation clicks the same model", () => {
		const item = { ...models(1)[0], id: "a-long-model-id-with-a-wrapped- TARGET" };
		const callback = vi.fn();
		const selector = new ModelSelectorComponent(
			{ requestRender() {} } as unknown as TUI,
			undefined,
			{ getAvailableSnapshot: () => [item] } as unknown as ModelRuntime,
			[],
			callback,
			vi.fn(),
		);
		try {
			mouse(selector, "TARGET", { type: "press" }, 18);
			mouse(selector, "TARGET", { clickSource: "captured" }, 18);
			expect(callback).toHaveBeenCalledExactlyOnceWith(item);
		} finally {
			selector.dispose();
		}
	});
	it("keyboard selection disposes mouse while still mounted", () => {
		const f = createModelSelector(3);
		f.selector.handleInput("\r");
		expect(mouse(f.selector, "model-01", { type: "press" })).toBeUndefined();
		mouse(f.selector, "model-01");
		expect(f.selected()).toBe(1);
	});
});
