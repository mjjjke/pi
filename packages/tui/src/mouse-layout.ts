import type { Component, TuiMouseDispatchTarget } from "./tui.ts";

/** Child rectangles relative to their rendered parent, not live component state. */
const mouseLayouts = new WeakMap<Component, readonly TuiMouseDispatchTarget[]>();

export function recordMouseLayout(component: Component, children: readonly TuiMouseDispatchTarget[]): void {
	mouseLayouts.set(component, children);
}

/** Hit-test cached render geometry without invoking handlers or rendering components. */
export function getRenderedMouseTarget(
	target: TuiMouseDispatchTarget,
	x: number,
	y: number,
	owner?: Component,
): TuiMouseDispatchTarget {
	if (target.component === owner) return target;
	for (const child of mouseLayouts.get(target.component) ?? []) {
		const positioned = {
			...child,
			originX: target.originX + child.originX,
			originY: target.originY + child.originY,
		};
		if (
			x >= positioned.originX &&
			x < positioned.originX + positioned.width &&
			y >= positioned.originY &&
			y < positioned.originY + positioned.height
		)
			return getRenderedMouseTarget(positioned, x, y, owner);
	}
	return target;
}
