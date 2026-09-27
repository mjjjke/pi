import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

describe("fork API factory lifecycle", () => {
	it("revokes retained instruction and display APIs after a factory fails", async () => {
		const runtime = createExtensionRuntime();
		let retained: ExtensionAPI | undefined;
		await expect(
			loadExtensionFromFactory(
				(pi) => {
					retained = pi;
					throw new Error("factory failure");
				},
				process.cwd(),
				createEventBus(),
				runtime,
			),
		).rejects.toThrow("factory failure");
		const append = vi.fn();
		runtime.appendDeveloperMessage = append;
		expect(retained).toBeDefined();
		expect(() => retained!.appendDeveloperMessage("late instruction")).toThrow("failed to load");
		expect(() => retained!.registerAssistantMessageDisplayTransform("late", () => undefined)).toThrow(
			"failed to load",
		);
		expect(() => retained!.registerToolRenderer("bash", {})).toThrow("failed to load");
		expect(append).not.toHaveBeenCalled();
	});

	it("allows the same APIs from a successful factory and revokes them on runtime invalidation", async () => {
		const runtime = createExtensionRuntime();
		let retained: ExtensionAPI | undefined;
		const extension = await loadExtensionFromFactory(
			(pi) => {
				retained = pi;
				pi.registerAssistantMessageDisplayTransform("active", () => undefined);
			},
			process.cwd(),
			createEventBus(),
			runtime,
		);
		const append = vi.fn();
		runtime.appendDeveloperMessage = append;
		retained!.appendDeveloperMessage("instruction");
		expect(append).toHaveBeenCalledWith("instruction");
		expect(extension.assistantMessageDisplayTransforms.has("active")).toBe(true);
		runtime.invalidate();
		expect(() => retained!.appendDeveloperMessage("late")).toThrow();
	});

	it("records tool renderer decorators in registration order and rejects them after runtime invalidation", async () => {
		const runtime = createExtensionRuntime();
		let retained: ExtensionAPI | undefined;
		const first = { renderCall: () => undefined };
		const second = { renderResult: () => undefined };
		const extension = await loadExtensionFromFactory(
			(pi) => {
				retained = pi;
				pi.registerToolRenderer("bash", first);
			},
			process.cwd(),
			createEventBus(),
			runtime,
		);
		retained!.registerToolRenderer("bash", second);
		expect(extension.toolRenderers?.get("bash")).toEqual([first, second]);
		runtime.invalidate();
		expect(() => retained!.registerToolRenderer("bash", {})).toThrow();
		expect(extension.toolRenderers?.get("bash")).toHaveLength(2);
	});
});
