import type { Component } from "./tui.ts";

const ownerIds = new WeakMap<Component, string>();
let nextOwnerId = 0;
let activeOwner: { component: Component; source: number } | undefined;

/** Give uncached wrapping callers the same owner namespace on every render. */
export function renderComponent(component: Component, width: number): string[] {
	const previous = activeOwner;
	activeOwner = { component, source: 0 };
	try {
		return component.render(width);
	} finally {
		activeOwner = previous;
	}
}

/** Outside framework rendering, the caller can supply an explicit source-owner prefix. */
export function getDefaultWrapLinkPrefix(): string {
	if (!activeOwner) return "pi-wrap";
	let prefix = ownerIds.get(activeOwner.component);
	if (!prefix) {
		prefix = `pi-owner-${++nextOwnerId}`;
		ownerIds.set(activeOwner.component, prefix);
	}
	return `${prefix}-${activeOwner.source++}`;
}
