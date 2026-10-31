import { describe, expect, it, vi } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("interactive /continue", () => {
	it("is listed for built-in help and autocomplete", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "continue")).toBe(true);
	});

	it.each([true, false])("dispatches without submitting a prompt (continued=%s)", async (continued) => {
		const mode = {
			session: { continueInterrupted: vi.fn(async () => continued), prompt: vi.fn() },
			defaultEditor: { onSubmit: undefined as ((text: string) => Promise<void>) | undefined },
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
		Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler").call(mode);
		await mode.defaultEditor.onSubmit?.("/continue");
		expect(mode.session.continueInterrupted).toHaveBeenCalledOnce();
		expect(mode.session.prompt).not.toHaveBeenCalled();
		expect(mode.editor.setText).toHaveBeenCalledWith("");
		if (continued) expect(mode.showStatus).not.toHaveBeenCalled();
		else expect(mode.showStatus).toHaveBeenCalledWith("Nothing to continue.");
	});
});
