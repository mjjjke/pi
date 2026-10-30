import { renderComponent } from "../link-identity.ts";
import { recordMouseLayout } from "../mouse-layout.ts";
import { type Component, dispatchMouseEvent, type TuiMouseEvent, type TuiMouseEventResult } from "../tui.ts";
import { applyBackgroundSpan } from "../utils.ts";
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
	/** Selected rows keep their keyboard selection style; local zones still paint. */
	isSelected?(key: K): boolean;
}

let pointerHoverBackground: (() => string | undefined) | undefined;

/** Host-wide background SGR provider. Undefined disables paint, not hover tracking. */
export function setPointerHoverBackground(provider: (() => string | undefined) | undefined): void {
	pointerHoverBackground = provider;
}

export function getPointerHoverBackground(): string | undefined {
	return pointerHoverBackground?.();
}

interface ListMouseRow<K> {
	key: K;
	y: number;
	height: number;
	zones: readonly ListMouseZone[];
}

/** A cached row has mutable content, but retains its renderer dispatch identity. */
class ListMouseRegion extends MouseRegion {
	content: Component;
	zones: readonly ListMouseZone[];
	private readonly onEvent: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
	private readonly paint: (lines: string[], width: number) => string[];

	constructor(
		child: Component,
		zones: readonly ListMouseZone[],
		onEvent: (event: TuiMouseEvent) => TuiMouseEventResult | undefined,
		paint: (lines: string[], width: number) => string[],
	) {
		super(child, onEvent);
		this.content = child;
		this.zones = zones;
		this.onEvent = onEvent;
		this.paint = paint;
	}

	override render(width: number): string[] {
		const lines = renderComponent(this.content, width);
		recordMouseLayout(this, [{ component: this.content, originX: 0, originY: 0, width, height: lines.length }]);
		return this.paint(lines, width);
	}

	override handleMouse(event: TuiMouseEvent) {
		return dispatchMouseEvent(this.content, event) ?? this.onEvent(event);
	}

	override invalidate(): void {
		this.content.invalidate();
	}
}

/** Press-time row identity and click/wheel policy for manual lists or MouseRegion rows. */
export class ListMouse<K> {
	private readonly options: ListMouseOptions<K>;
	private isClosed = false;
	private pressed?: ListMouseHit<K> & { readonly gestureId?: number };
	private rows: ListMouseRow<K>[] = [];
	private readonly regions = new Map<K, ListMouseRegion>();
	private readonly pendingRegionKeys = new Set<K>();
	private hover?: ListMouseHit<K> & { x: number; y: number; region: boolean; episode: { valid: boolean } };
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
		this.clearHover();
	}

	/** End only hover, not the held press. Ended episode predicates never revive. */
	clearHover(): boolean {
		if (!this.hover) return false;
		this.hover.episode.valid = false;
		this.hover = undefined;
		return true;
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

	/** Validate manual identity on every render path, even without a provider or visible rows. */
	paintHover(lines: string[], width: number): string[] {
		if (!this.hover || this.hover.region) return lines;
		const hover = this.hover;
		const row = this.rows.find((row) => hover.y >= row.y && hover.y < row.y + row.height);
		return this.paintRows(lines, width, row, false);
	}

	private paintRows(lines: string[], width: number, row: ListMouseRow<K> | undefined, region: boolean): string[] {
		const hover = this.hover;
		if (!hover || hover.region !== region) return lines;
		const zone = row?.zones.find((zone) => hover.x >= zone.x && hover.x < zone.x + zone.width);
		if (
			this.isClosed ||
			this.options.enabled?.() === false ||
			width <= 0 ||
			hover.x < 0 ||
			hover.x >= width ||
			hover.y < 0 ||
			hover.y >= lines.length ||
			!row ||
			row.key !== hover.key ||
			zone?.name !== hover.zone
		) {
			this.clearHover();
			return lines;
		}
		const bg = getPointerHoverBackground();
		if (!bg || (!zone && this.options.isSelected?.(hover.key))) return lines;
		return lines.map((line, y) =>
			y >= row.y && y < row.y + row.height
				? applyBackgroundSpan(
						line,
						zone ? Math.max(0, zone.x) : 0,
						zone ? Math.min(width, zone.x + zone.width) : width,
						bg,
					)
				: line,
		);
	}

	/** Preserve row identity across rebuilds, including every wrapped child line. */
	row(key: K, child: Component, zones: readonly ListMouseZone[] = []): MouseRegion {
		this.pendingRegionKeys.add(key);
		let region = this.regions.get(key);
		if (!region) {
			const created: ListMouseRegion = new ListMouseRegion(
				child,
				zones,
				(event) => {
					// A new row's move is dispatched before the old row's leave notification.
					if (event.type === "leave" && this.hover && this.hover.key !== key)
						return { handled: true, render: false };
					const inside = event.x >= 0 && event.x < event.width && event.y >= 0 && event.y < event.height;
					const zone = created.zones.find((zone) => event.x >= zone.x && event.x < zone.x + zone.width);
					return this.handleHit(
						event,
						inside ? (zone ? { key, zone: zone.name } : { key }) : undefined,
						inside,
						true,
					);
				},
				(lines, width) =>
					this.hover?.key === key
						? this.paintRows(lines, width, { key, y: 0, height: lines.length, zones: created.zones }, true)
						: lines,
			);
			region = created;
			this.regions.set(key, region);
		}
		region.content = child;
		region.zones = zones;
		return region;
	}

	/** End a region-row build. Renderer capture retains removed objects independently. */
	commitRows(): void {
		for (const key of this.regions.keys()) if (!this.pendingRegionKeys.has(key)) this.regions.delete(key);
		if (this.hover?.region && !this.pendingRegionKeys.has(this.hover.key)) this.clearHover();
		this.pendingRegionKeys.clear();
	}

	private handleHit(
		event: TuiMouseEvent,
		hit: ListMouseHit<K> | undefined,
		inItemArea: boolean,
		region = false,
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
		if (this.isClosed || this.options.enabled?.() === false) {
			const render = this.clearHover();
			return render && (event.type === "move" || event.type === "leave") ? { handled: true, render } : undefined;
		}
		if (event.type === "leave") return { handled: true, render: this.clearHover() };
		if (event.type === "move") {
			if (!hit) return this.clearHover() ? { handled: true, render: true } : undefined;
			const changed =
				!this.hover || this.hover.key !== hit.key || this.hover.zone !== hit.zone || this.hover.region !== region;
			if (changed) {
				this.clearHover();
				this.hover = { ...hit, x: event.x, y: event.y, region, episode: { valid: true } };
			} else {
				this.hover!.x = event.x;
				this.hover!.y = event.y;
			}
			const episode = this.hover!.episode;
			return { handled: true, render: changed, hoverValid: () => episode.valid };
		}
		if (event.type === "wheel") {
			if (!event.wheelDelta || !this.options.step || this.options.ownsWheel?.() === false || !inItemArea)
				return undefined;
			const cleared = this.clearHover();
			return { handled: true, render: this.options.step(event.wheelDelta < 0 ? -1 : 1) || cleared };
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
