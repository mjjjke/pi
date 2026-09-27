import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Component, Container, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	ExtensionFactory,
	RegisteredToolRendererDecorator,
	ToolDefinition,
	ToolRendererDecorator,
} from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	composeToolRenderers,
	decorateToolRenderers,
	withBuiltInRenderers,
} from "../src/core/tools/renderers/index.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

type LayerState = { name?: string; base?: string };

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function createBaseToolDefinition(name = "custom_tool", overrides: Partial<ToolDefinition> = {}): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		...overrides,
	};
}

function layer<TState>(
	decorator: ToolRendererDecorator<unknown, unknown, TState>,
	extensionPath = "<test>",
): RegisteredToolRendererDecorator {
	return { extensionPath, decorator: decorator as ToolRendererDecorator };
}

function renderText(component: ToolExecutionComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

function createRow(
	toolName: string,
	args: unknown,
	definition: ConstructorParameters<typeof ToolExecutionComponent>[4],
) {
	return new ToolExecutionComponent(toolName, "tool-1", args, {}, definition, createFakeTui(), process.cwd());
}

function lines(...values: string[]): Component {
	return { render: () => values, invalidate: () => {} };
}

const noError = () => {
	throw new Error("unexpected tool renderer error");
};

describe("tool renderer decorators", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tool-renderer-test-"));
		sessionManager = SessionManager.inMemory();
		modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function createRunner(...factories: ExtensionFactory[]): Promise<ExtensionRunner> {
		const runtime = createExtensionRuntime();
		const extensions = [];
		for (const [index, factory] of factories.entries()) {
			extensions.push(await loadExtensionFromFactory(factory, tempDir, createEventBus(), runtime, `<ext-${index}>`));
		}
		return new ExtensionRunner(extensions, runtime, tempDir, sessionManager, modelRegistry);
	}

	test("returns the definition unchanged when there are no decorators", async () => {
		const definition = createBaseToolDefinition();
		expect(composeToolRenderers(definition, [], noError)).toBe(definition);
		const runner = await createRunner(() => {});
		expect(decorateToolRenderers("custom_tool", definition, runner)).toBe(definition);
		expect(composeToolRenderers(undefined, [layer({ renderCall: () => undefined })], noError)).toBeUndefined();
	});

	test("uses the base component when a decorator returns undefined and forwards base(theme)", () => {
		const seenThemes: Theme[] = [];
		const definition = createBaseToolDefinition("custom_tool", {
			renderCall: (_args, renderTheme) => {
				seenThemes.push(renderTheme);
				return new Text("base call", 0, 0);
			},
		});
		const passThrough = composeToolRenderers(definition, [layer({ renderCall: () => undefined })], noError);
		expect(renderText(createRow("custom_tool", {}, passThrough))).toContain("base call");
		expect(seenThemes.at(-1)).toBe(theme);

		const patchedTheme = Object.create(theme) as Theme;
		const patched = composeToolRenderers(
			definition,
			[layer({ renderCall: (_args, _theme, _context, base) => base(patchedTheme) })],
			noError,
		);
		expect(renderText(createRow("custom_tool", {}, patched))).toContain("base call");
		expect(seenThemes.at(-1)).toBe(patchedTheme);
	});

	test("keeps the base lastComponent isolated when a decorator wraps it", () => {
		const baseComponents: Array<Component | undefined> = [];
		const definition = composeToolRenderers(
			withBuiltInRenderers("read", undefined),
			[
				layer({
					renderCall: (_args, _theme, _context, base) => {
						const inner = base();
						baseComponents.push(inner);
						const wrapper = new Container();
						wrapper.addChild(new Text("[deco]", 0, 0));
						if (inner) wrapper.addChild(inner);
						return wrapper;
					},
				}),
			],
			noError,
		);
		const row = createRow("read", { path: "notes.txt" }, definition);
		row.updateArgs({ path: "notes.txt", offset: 1 });
		row.updateArgs({ path: "notes.txt", offset: 1, limit: 5 });

		const rendered = renderText(row);
		expect(rendered).toContain("[deco]");
		expect(rendered).toContain("read notes.txt:1-5");
		expect(baseComponents).toHaveLength(3);
		expect(baseComponents[0]).toBeInstanceOf(Text);
		expect(baseComponents[1]).toBe(baseComponents[0]);
		expect(baseComponents[2]).toBe(baseComponents[0]);
	});

	test("preserves component reuse when a decorator returns the base component", () => {
		const layerLastComponents: Array<Component | undefined> = [];
		const baseComponents: Component[] = [];
		const definition = composeToolRenderers(
			withBuiltInRenderers("read", undefined),
			[
				layer({
					renderCall: (_args, _theme, context, base) => {
						layerLastComponents.push(context.lastComponent);
						const inner = base();
						if (inner) baseComponents.push(inner);
						return inner;
					},
				}),
			],
			noError,
		);
		const row = createRow("read", { path: "notes.txt" }, definition);
		row.updateArgs({ path: "notes.txt", offset: 2 });

		expect(renderText(row)).toContain("read notes.txt:2");
		expect(baseComponents).toHaveLength(2);
		expect(baseComponents[1]).toBe(baseComponents[0]);
		expect(layerLastComponents).toEqual([undefined, baseComponents[0]]);
	});

	test("gives each layer its own state shared by its call and result slots", () => {
		const baseStates: object[] = [];
		const layerStates: Record<string, LayerState[]> = { A: [], B: [] };
		const definition = createBaseToolDefinition("custom_tool", {
			renderCall: (_args, _theme, context) => {
				context.state.base = "set";
				baseStates.push(context.state);
				return new Text("base call", 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				baseStates.push(context.state);
				return new Text(`base result ${context.state.base}`, 0, 0);
			},
		});
		const createLayer = (name: string) =>
			layer<LayerState>({
				renderCall: (_args, _theme, context) => {
					context.state.name = name;
					layerStates[name].push(context.state);
					return undefined;
				},
				renderResult: (_result, _options, _theme, context) => {
					layerStates[name].push(context.state);
					return undefined;
				},
			});
		const row = createRow(
			"custom_tool",
			{},
			composeToolRenderers(definition, [createLayer("A"), createLayer("B")], noError),
		);
		row.updateResult({ content: [{ type: "text", text: "done" }], isError: false });

		expect(renderText(row)).toContain("base result set");
		const [stateA] = layerStates.A;
		const [stateB] = layerStates.B;
		expect(layerStates.A.length).toBeGreaterThanOrEqual(2);
		expect(layerStates.A.every((state) => state === stateA)).toBe(true);
		expect(layerStates.B.every((state) => state === stateB)).toBe(true);
		expect(baseStates.every((state) => state === baseStates[0])).toBe(true);
		expect(stateA).not.toBe(stateB);
		expect(baseStates[0]).not.toBe(stateA);
		expect(baseStates[0]).not.toBe(stateB);
		expect(stateA).toEqual({ name: "A" });
		expect(stateB).toEqual({ name: "B" });
		expect(baseStates[0]).toEqual({ base: "set" });
	});

	test("orders layers by extension load order, then registration order", async () => {
		const wrapper = (label: string) => `(_args, _theme, _context, base) => {
		const inner = base();
		return { render: (width) => ["${label}(", ...(inner ? inner.render(width) : []), ")${label}"], invalidate() {} };
	}`;
		const firstPath = path.join(tempDir, "first.ts");
		const secondPath = path.join(tempDir, "second.ts");
		fs.writeFileSync(
			firstPath,
			`export default function (pi) {
	pi.registerToolRenderer("custom_tool", { renderCall: ${wrapper("first-1")} });
	pi.registerToolRenderer("custom_tool", { renderCall: ${wrapper("first-2")} });
}`,
		);
		fs.writeFileSync(
			secondPath,
			`export default function (pi) {
	pi.registerToolRenderer("custom_tool", { renderCall: ${wrapper("second-1")} });
}`,
		);
		const result = await loadExtensions([firstPath, secondPath], tempDir);
		expect(result.errors).toEqual([]);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);
		expect(runner.getToolRendererDecorators("custom_tool").map((entry) => entry.extensionPath)).toEqual([
			firstPath,
			firstPath,
			secondPath,
		]);
		expect(runner.getToolRendererDecorators("other_tool")).toEqual([]);

		const definition = createBaseToolDefinition("custom_tool", { renderCall: () => lines("base") });
		const rendered = renderText(
			createRow("custom_tool", {}, decorateToolRenderers("custom_tool", definition, runner)),
		);
		const order = ["second-1(", "first-2(", "first-1(", "base", ")first-1", ")first-2", ")second-1"].map((label) =>
			rendered.indexOf(label),
		);
		expect(order.every((position) => position >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test("bypasses a throwing layer and reports it once per row and slot", () => {
		const onError = vi.fn();
		const failing = layer({
			renderCall: () => {
				throw new Error("layer boom");
			},
		});
		const definition = createBaseToolDefinition("custom_tool", { renderCall: () => new Text("base call", 0, 0) });
		const row = createRow("custom_tool", {}, composeToolRenderers(definition, [failing], onError));
		row.updateArgs({ value: 1 });
		row.updateArgs({ value: 2 });

		expect(renderText(row)).toContain("base call");
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "layer boom" }), failing, "renderCall");
	});

	test("propagates base renderer errors without blaming the decorator", () => {
		const onError = vi.fn();
		const definition = createBaseToolDefinition("custom_tool", {
			renderCall: () => {
				throw new Error("base boom");
			},
		});
		const row = createRow(
			"custom_tool",
			{},
			composeToolRenderers(
				definition,
				[layer({ renderCall: (_args, _theme, _context, base) => base() ?? lines("layer only") })],
				onError,
			),
		);

		const rendered = renderText(row);
		expect(rendered).toContain("custom_tool");
		expect(rendered).not.toContain("layer only");
		expect(onError).not.toHaveBeenCalled();
	});

	test("falls back to component rendering when neither the decorator nor a base renderer draws", () => {
		const definition = createBaseToolDefinition("ext_tool");
		const composed = composeToolRenderers(
			definition,
			[layer({ renderCall: () => undefined, renderResult: () => undefined })],
			noError,
		);
		expect(composed?.renderCall).toBeTypeOf("function");
		expect(composed?.renderResult).toBeTypeOf("function");
		const row = createRow("ext_tool", {}, composed);
		row.updateResult({ content: [{ type: "text", text: "plain output" }], isError: false });

		const rendered = renderText(row);
		expect(rendered).toContain("ext_tool");
		expect(rendered).toContain("plain output");

		const callOnly = composeToolRenderers(definition, [layer({ renderCall: () => undefined })], noError);
		expect(callOnly?.renderResult).toBeUndefined();
	});

	test("applies the outermost defined renderShell", () => {
		const definition = createBaseToolDefinition("custom_tool", { renderCall: () => lines("base") });
		const selfShell = composeToolRenderers(definition, [layer({ renderShell: "self" })], noError);
		expect(selfShell?.renderShell).toBe("self");
		expect(createRow("custom_tool", {}, selfShell).render(120)).toEqual(["", "base"]);

		expect(
			composeToolRenderers(definition, [layer({ renderShell: "self" }), layer({ renderShell: "default" })], noError)
				?.renderShell,
		).toBe("default");
		expect(
			composeToolRenderers(
				definition,
				[layer({ renderShell: "self" }), layer({ renderCall: () => undefined })],
				noError,
			)?.renderShell,
		).toBe("self");
		expect(
			composeToolRenderers({ ...definition, renderShell: "self" }, [layer({ renderCall: () => undefined })], noError)
				?.renderShell,
		).toBe("self");

		const noShell = composeToolRenderers(definition, [layer({ renderCall: () => undefined })], noError);
		expect(noShell && Object.hasOwn(noShell, "renderShell")).toBe(false);
	});

	test("renders the inner layer once when base() is called twice", () => {
		const seenThemes: Theme[] = [];
		const returned: Array<Component | undefined> = [];
		const definition = createBaseToolDefinition("custom_tool", {
			renderCall: (_args, renderTheme) => {
				seenThemes.push(renderTheme);
				return new Text("base call", 0, 0);
			},
		});
		const otherTheme = Object.create(theme) as Theme;
		const row = createRow(
			"custom_tool",
			{},
			composeToolRenderers(
				definition,
				[
					layer({
						renderCall: (_args, _theme, _context, base) => {
							returned.push(base(), base(otherTheme));
							return undefined;
						},
					}),
				],
				noError,
			),
		);

		expect(renderText(row)).toContain("base call");
		expect(seenThemes).toEqual([theme]);
		expect(returned).toHaveLength(2);
		expect(returned[1]).toBe(returned[0]);
	});

	test("renders the base once when a layer throws after base() succeeded", () => {
		const onError = vi.fn();
		let baseRenders = 0;
		const definition = createBaseToolDefinition("custom_tool", {
			renderCall: () => {
				baseRenders++;
				return new Text("base call", 0, 0);
			},
		});
		const row = createRow(
			"custom_tool",
			{},
			composeToolRenderers(
				definition,
				[
					layer({
						renderCall: (_args, _theme, _context, base) => {
							base();
							throw new Error("after base");
						},
					}),
				],
				onError,
			),
		);

		expect(renderText(row)).toContain("base call");
		expect(baseRenders).toBe(1);
		expect(onError).toHaveBeenCalledTimes(1);
	});

	test("resets lastComponent in the base and layers after the row drops a failed render", () => {
		let render = 0;
		const baseSeen: Array<Component | undefined> = [];
		const layerSeen: Array<Component | undefined> = [];
		const definition = createBaseToolDefinition("custom_tool", {
			renderCall: (_args, _theme, context) => {
				baseSeen.push(context.lastComponent);
				if (++render === 2) throw new Error("base boom");
				return new Text("base call", 0, 0);
			},
		});
		const row = createRow(
			"custom_tool",
			{},
			composeToolRenderers(
				definition,
				[
					layer({
						renderCall: (_args, _theme, context, base) => {
							layerSeen.push(context.lastComponent);
							const wrapper = new Container();
							const inner = base();
							if (inner) wrapper.addChild(inner);
							return wrapper;
						},
					}),
				],
				noError,
			),
		);
		row.updateArgs({ value: 2 });
		row.updateArgs({ value: 3 });

		expect(renderText(row)).toContain("base call");
		expect(baseSeen).toHaveLength(3);
		expect(baseSeen[1]).toBeInstanceOf(Text);
		expect(baseSeen[2]).toBeUndefined();
		expect(layerSeen[1]).toBeInstanceOf(Container);
		expect(layerSeen[2]).toBeUndefined();
	});

	test("clears the base lastComponent when a layer recovers from a base error", () => {
		let render = 0;
		const baseSeen: Array<Component | undefined> = [];
		const definition = createBaseToolDefinition("custom_tool", {
			renderCall: (_args, _theme, context) => {
				baseSeen.push(context.lastComponent);
				if (++render === 2) throw new Error("base boom");
				return new Text("base call", 0, 0);
			},
		});
		const row = createRow(
			"custom_tool",
			{},
			composeToolRenderers(
				definition,
				[
					layer({
						renderCall: (_args, _theme, _context, base) => {
							try {
								return base();
							} catch {
								return lines("layer recovered");
							}
						},
					}),
				],
				noError,
			),
		);
		row.updateArgs({ value: 2 });
		expect(renderText(row)).toContain("layer recovered");
		row.updateArgs({ value: 3 });

		expect(renderText(row)).toContain("base call");
		expect(baseSeen).toHaveLength(3);
		expect(baseSeen[1]).toBeInstanceOf(Text);
		expect(baseSeen[2]).toBeUndefined();
	});

	test("forwards an outer layer's theme through a layer that calls base() without one", () => {
		const patchedTheme = Object.create(theme) as Theme;
		const seen: Record<string, Theme> = {};
		const definition = createBaseToolDefinition("custom_tool", {
			renderCall: (_args, renderTheme) => {
				seen.base = renderTheme;
				return new Text("base call", 0, 0);
			},
		});
		const inner = layer({
			renderCall: (_args, renderTheme, _context, base) => {
				seen.inner = renderTheme;
				return base();
			},
		});
		const outer = layer({
			renderCall: (_args, renderTheme, _context, base) => {
				seen.outer = renderTheme;
				return base(patchedTheme);
			},
		});
		const row = createRow("custom_tool", {}, composeToolRenderers(definition, [inner, outer], noError));

		expect(renderText(row)).toContain("base call");
		expect(seen.outer).toBe(theme);
		expect(seen.inner).toBe(patchedTheme);
		expect(seen.base).toBe(patchedTheme);
	});

	test("keeps running a layer's result renderer after its call renderer was bypassed", () => {
		const onError = vi.fn();
		const failingCall = layer({
			renderCall: () => {
				throw new Error("call boom");
			},
			renderResult: () => lines("[layer result]"),
		});
		const definition = createBaseToolDefinition("custom_tool", { renderCall: () => new Text("base call", 0, 0) });
		const row = createRow("custom_tool", {}, composeToolRenderers(definition, [failingCall], onError));
		row.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		row.updateArgs({ value: 2 });

		const rendered = renderText(row);
		expect(rendered).toContain("base call");
		expect(rendered).toContain("[layer result]");
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError).toHaveBeenCalledWith(expect.any(Error), failingCall, "renderCall");
	});

	test("reports a failing decorator once per runner across rows", async () => {
		const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
		const runner = await createRunner((pi) => {
			pi.registerToolRenderer("custom_tool", {
				renderCall: () => {
					throw new Error("call boom");
				},
				renderResult: () => {
					throw new Error("result boom");
				},
			});
		});
		runner.onError((error) => errors.push(error));
		const definition = createBaseToolDefinition("custom_tool", {
			renderCall: () => new Text("base call", 0, 0),
			renderResult: () => new Text("base result", 0, 0),
		});

		for (let index = 0; index < 3; index++) {
			const row = createRow("custom_tool", {}, decorateToolRenderers("custom_tool", definition, runner));
			row.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
			const rendered = renderText(row);
			expect(rendered).toContain("base call");
			expect(rendered).toContain("base result");
		}

		expect(errors.map((error) => error.error)).toEqual([
			expect.stringContaining("renderCall: call boom"),
			expect.stringContaining("renderResult: result boom"),
		]);
	});

	test("decorates built-in and extension tools through decorateToolRenderers with built-in fallback", async () => {
		const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
		const runner = await createRunner((pi) => {
			pi.registerToolRenderer("bash", {
				renderCall: (_args, _theme, _context, base) => {
					const wrapper = new Container();
					wrapper.addChild(new Text("[themed bash]", 0, 0));
					const inner = base();
					if (inner) wrapper.addChild(inner);
					return wrapper;
				},
			});
			pi.registerToolRenderer("ext_tool", { renderCall: () => new Text("[themed ext]", 0, 0) });
			pi.registerToolRenderer("ext_tool", {
				renderResult: () => {
					throw new Error("result boom");
				},
			});
		});
		runner.onError((error) => errors.push(error));

		const bash = createRow(
			"bash",
			{ command: "ls" },
			decorateToolRenderers("bash", withBuiltInRenderers("bash", undefined), runner),
		);
		const bashOutput = renderText(bash);
		expect(bashOutput).toContain("[themed bash]");
		expect(bashOutput).toContain("$ ls");

		const extTool = createRow(
			"ext_tool",
			{},
			decorateToolRenderers(
				"ext_tool",
				withBuiltInRenderers("ext_tool", createBaseToolDefinition("ext_tool")),
				runner,
			),
		);
		extTool.updateResult({ content: [{ type: "text", text: "ext output" }], isError: false });
		extTool.setExpanded(true);
		const extOutput = renderText(extTool);
		expect(extOutput).toContain("[themed ext]");
		expect(extOutput).toContain("ext output");
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ extensionPath: "<ext-0>", event: "tool_renderer" });
		expect(errors[0].error).toContain("result boom");
		expect(errors[0].error).toContain("ext_tool");
	});
});
