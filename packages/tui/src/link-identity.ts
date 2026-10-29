import type { Component } from "./tui.ts";

/** Link identities belong to retained sources, never to render-call order or cache misses. */
export function renderComponent(component: Component, width: number): string[] {
	return component.render(width);
}
