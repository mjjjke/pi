/**
 * Composition of extension tool renderer decorators (`pi.registerToolRenderer()`) with a tool's own
 * renderers.
 *
 * `ToolExecutionComponent` keeps the definition it was constructed with and calls its renderers on
 * every update, passing one `state` object and the last component it drew. Built-in renderers cast
 * `context.lastComponent` to their own component type and keep timers in `context.state`, so each
 * layer must see only what it produced itself. `composeToolRenderers()` therefore builds a new
 * definition per tool row whose closures track, per layer, its own state (shared by its call and
 * result renderers) and, per slot, the component that layer last returned. The tool's own renderer
 * keeps receiving the row state, so an undecorated render path is unchanged.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { ToolRenderers as RenderableTool } from "../../../modes/interactive/components/tool-execution.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ExtensionRunner } from "../../extensions/runner.ts";
import type {
	RegisteredToolRendererDecorator,
	ToolRenderContext,
	ToolRendererDecorator,
	ToolRendererSlot,
} from "../../extensions/types.ts";

export type ToolRendererErrorHandler = (
	error: unknown,
	layer: RegisteredToolRendererDecorator,
	slot: ToolRendererSlot,
) => void;

type RenderContext = ToolRenderContext<unknown, unknown>;
type RenderBase = (theme?: Theme) => Component | undefined;
type BaseRender = (theme: Theme, context: RenderContext) => Component | undefined;
type LayerRender = (
	decorator: ToolRendererDecorator,
	theme: Theme,
	context: RenderContext,
	base: RenderBase,
) => Component | undefined;
type SlotRender = (
	theme: Theme,
	context: RenderContext,
	renderBase: BaseRender | undefined,
	renderLayer: LayerRender,
) => Component | undefined;

interface Layer {
	entry: RegisteredToolRendererDecorator;
	/** Private to this layer for one row; shared by its call and result renderers. */
	state: unknown;
}

/**
 * Render one slot through its layers, innermost first in `layers`. Tracks the component each layer and
 * the base last returned, and bypasses a layer for the rest of the row after it throws.
 */
function createSlotRenderer(slot: ToolRendererSlot, layers: Layer[], onError: ToolRendererErrorHandler): SlotRender {
	let baseLastComponent: Component | undefined;
	const layerLastComponents: Array<Component | undefined> = layers.map(() => undefined);
	const bypassed = layers.map(() => false);
	let lastOutput: Component | undefined;

	return (theme, context, renderBase, renderLayer) => {
		if (context.lastComponent !== lastOutput) {
			// The row dropped our previous output, e.g. after the base renderer threw. Start fresh like it does.
			baseLastComponent = undefined;
			layerLastComponents.fill(undefined);
		}

		const render = (index: number, layerTheme: Theme): Component | undefined => {
			if (index < 0) {
				if (!renderBase) return undefined;
				try {
					baseLastComponent = renderBase(layerTheme, { ...context, lastComponent: baseLastComponent });
				} catch (error) {
					// Without decorators the row drops the component after a throw. Match that even when a layer
					// catches the error and draws its own component.
					baseLastComponent = undefined;
					throw error;
				}
				return baseLastComponent;
			}
			if (bypassed[index]) return render(index - 1, layerTheme);

			const layer = layers[index];
			const inner: { called: boolean; failed: boolean; error?: unknown; component?: Component } = {
				called: false,
				failed: false,
			};
			const base: RenderBase = (baseTheme) => {
				// Rendering twice would mutate the inner components twice; repeat calls replay the first result.
				if (inner.called) {
					if (inner.failed) throw inner.error;
					return inner.component;
				}
				inner.called = true;
				try {
					inner.component = render(index - 1, baseTheme ?? layerTheme);
					return inner.component;
				} catch (error) {
					inner.failed = true;
					inner.error = error;
					throw error;
				}
			};

			let component: Component | undefined;
			try {
				component = renderLayer(
					layer.entry.decorator,
					layerTheme,
					{ ...context, lastComponent: layerLastComponents[index], state: layer.state },
					base,
				);
			} catch (error) {
				// An error thrown by the base renderer propagates as it would without decorators.
				layerLastComponents[index] = undefined;
				if (!inner.failed || error !== inner.error) {
					bypassed[index] = true;
					onError(error, layer.entry, slot);
				}
				if (inner.failed) throw inner.error;
				return inner.called ? inner.component : render(index - 1, layerTheme);
			}
			layerLastComponents[index] = component;
			if (component !== undefined) return component;
			return inner.called ? inner.component : render(index - 1, layerTheme);
		};

		const output = render(layers.length - 1, theme);
		lastOutput = output;
		return output;
	};
}

/**
 * Wrap a tool's renderers with extension decorators for one tool row.
 *
 * Call once per `ToolExecutionComponent`: the returned definition holds that row's layer state.
 * Decorators are ordered innermost first, so the last one is the outermost layer. Returns
 * `definition` itself when there are no decorators, and `undefined` for an unknown tool.
 */
export function composeToolRenderers<TDefinition extends RenderableTool>(
	definition: TDefinition | undefined,
	decorators: readonly RegisteredToolRendererDecorator[],
	onError: ToolRendererErrorHandler,
): TDefinition | RenderableTool | undefined {
	if (!definition || decorators.length === 0) return definition;

	const layers: Layer[] = decorators.map((entry) => ({ entry, state: {} }));
	let renderShell = definition.renderShell;
	for (const { decorator } of decorators) {
		renderShell = decorator.renderShell ?? renderShell;
	}
	const composed: RenderableTool = { ...definition };
	if (renderShell !== undefined) composed.renderShell = renderShell;

	const callLayers = layers.filter((layer) => layer.entry.decorator.renderCall);
	if (callLayers.length > 0) {
		const baseRenderCall = definition.renderCall;
		const renderCall = createSlotRenderer("renderCall", callLayers, onError);
		composed.renderCall = (args, theme, context) =>
			renderCall(
				theme,
				context,
				baseRenderCall && ((baseTheme, baseContext) => baseRenderCall(args, baseTheme, baseContext)),
				(decorator, layerTheme, layerContext, base) => decorator.renderCall?.(args, layerTheme, layerContext, base),
			);
	}

	const resultLayers = layers.filter((layer) => layer.entry.decorator.renderResult);
	if (resultLayers.length > 0) {
		const baseRenderResult = definition.renderResult;
		const renderResult = createSlotRenderer("renderResult", resultLayers, onError);
		composed.renderResult = (result, options, theme, context) =>
			renderResult(
				theme,
				context,
				baseRenderResult && ((baseTheme, baseContext) => baseRenderResult(result, options, baseTheme, baseContext)),
				(decorator, layerTheme, layerContext, base) =>
					decorator.renderResult?.(result, options, layerTheme, layerContext, base),
			);
	}

	return composed;
}

/**
 * Apply an extension runner's decorators for `toolName`. Failures are reported through the runner as
 * `tool_renderer` extension errors, once per extension, tool, and slot for the runner's lifetime, so
 * rebuilding many historical rows does not repeat the same error. Each row still bypasses the layer.
 */
export function decorateToolRenderers<TDefinition extends RenderableTool>(
	toolName: string,
	definition: TDefinition | undefined,
	runner: Pick<ExtensionRunner, "getToolRendererDecorators" | "emitToolRendererError">,
): TDefinition | RenderableTool | undefined {
	return composeToolRenderers(definition, runner.getToolRendererDecorators(toolName), (error, layer, slot) =>
		runner.emitToolRendererError(layer.extensionPath, toolName, slot, error),
	);
}
