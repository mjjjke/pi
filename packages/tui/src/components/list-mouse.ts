import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { MouseRegion } from "./mouse-region.ts";

export interface ListMouseZone {
	readonly name: string;
	readonly x: number;
	readonly width: number;
}

export interface ListMouseHit<K> {
	readonly key: K;
	readonly zone?: string;
}

export interface ListMouseOptions<K> {
	/** Move the highlight on press (may rebuild rows). Never activates. */
	select(key: K): void;
	/** Revalidate the key against the current list and return whether its Enter action ran. */
	activate(key: K): boolean;
	/** Revalidate the key/zone and act instead of activate. Zone clicks never close the helper. */
	zoneClick?(key: K, zone: string): void;
	/** One clamped step; return whether anything visible changed. Omit to leave wheel unhandled. */
	step?(direction: -1 | 1): boolean;
	/** Wheel navigates only while clipped. Defaults to true when step is provided. */
	ownsWheel?(): boolean;
	/** Every event is unhandled while false. Defaults to true. */
	enabled?(): boolean;
	/** Close after an activation that acted. Defaults to true; use false for toggles. */
	closeOnActivate?: boolean;
}

/** Press-time row identity and click/wheel policy for manual lists or MouseRegion rows. */
export class ListMouse<K> {
	private readonly options: ListMouseOptions<K>;
	private isClosed = false;
	private pressed?: ListMouseHit<K> & { readonly gestureId?: number };
	private rows: Array<{ key: K; y: number; height: number; zones: readonly ListMouseZone[] }> = [];
	private itemTop = Infinity;
	private itemBottom = -Infinity;

	constructor(options: ListMouseOptions<K>) {
		this.options = options;
	}

	get closed(): boolean {
		return this.isClosed;
	}

	/** Permanent and idempotent, for a finished surface that may remain mounted. */
	close(): void {
		this.isClosed = true;
		this.pressed = undefined;
	}

	/** Reset manual hit geometry at the start of rendering, not the held press's identity. */
	beginRows(): void {
		this.rows = [];
		this.itemTop = Infinity;
		this.itemBottom = -Infinity;
	}

	addRow(key: K, y: number, height = 1, zones: readonly ListMouseZone[] = []): void {
		if (height <= 0) return;
		this.rows.push({ key, y, height, zones });
		this.itemTop = Math.min(this.itemTop, y);
		this.itemBottom = Math.max(this.itemBottom, y + height);
	}

	hitTest(x: number, y: number): ListMouseHit<K> | undefined {
		const row = this.rows.find((row) => y >= row.y && y < row.y + row.height);
		if (!row) return undefined;
		const zone = row.zones.find((zone) => x >= zone.x && x < zone.x + zone.width);
		return zone ? { key: row.key, zone: zone.name } : { key: row.key };
	}

	handle(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const inWidth = event.x >= 0 && event.x < event.width;
		return this.handleHit(
			event,
			inWidth ? this.hitTest(event.x, event.y) : undefined,
			inWidth && event.y >= this.itemTop && event.y < this.itemBottom,
		);
	}

	/** Preserve the child's rendering, including every wrapped line of a row. */
	row(key: K, child: Component, zones: readonly ListMouseZone[] = []): MouseRegion {
		return new MouseRegion(child, (event) => {
			const inside = event.x >= 0 && event.x < event.width && event.y >= 0 && event.y < event.height;
			const zone = zones.find((zone) => event.x >= zone.x && event.x < zone.x + zone.width);
			return this.handleHit(event, inside ? (zone ? { key, zone: zone.name } : { key }) : undefined, inside);
		});
	}

	private handleHit(
		event: TuiMouseEvent,
		hit: ListMouseHit<K> | undefined,
		inItemArea: boolean,
	): TuiMouseEventResult | undefined {
		// Capture identifies the dispatch target, not which nested control accepted the press.
		// Reject another gesture's click even if its press bypassed this helper (e.g. search).
		// Clear stale identity even when disabled or closed, before all other gates.
		if (
			event.type === "click" &&
			(event.clickSource === "fallback" ||
				(event.gestureId !== undefined && event.gestureId !== this.pressed?.gestureId))
		) {
			this.pressed = undefined;
			return undefined;
		}
		if (this.isClosed || this.options.enabled?.() === false) return undefined;
		if (event.type === "wheel") {
			if (!event.wheelDelta || !this.options.step || this.options.ownsWheel?.() === false || !inItemArea)
				return undefined;
			return { handled: true, render: this.options.step(event.wheelDelta < 0 ? -1 : 1) };
		}
		if (event.button !== "left") return undefined;
		if (event.type === "press") {
			this.pressed = hit ? { ...hit, gestureId: event.gestureId } : undefined;
			if (!hit) return undefined;
			this.options.select(hit.key);
			return { handled: true, focus: true };
		}
		if (event.type !== "click") return undefined;
		const target = this.pressed ?? (event.clickSource === undefined ? hit : undefined);
		const hadPress = this.pressed !== undefined;
		this.pressed = undefined;
		if (!target) return undefined;
		// Undefined provenance is the trusted direct-event exception, including idle test clicks.
		if (!hadPress) this.options.select(target.key);
		if (target.zone !== undefined) this.options.zoneClick?.(target.key, target.zone);
		else if (this.options.activate(target.key) && this.options.closeOnActivate !== false) this.close();
		return { handled: true };
	}
}
