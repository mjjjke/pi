/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard and fullscreen mouse navigation.
 */

import { Container, getKeybindings, ListMouse, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

const MAX_VISIBLE_OPTIONS = 10;

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
	description?: string;
	/** Internal mouse arming delay; keyboard input remains immediate. */
	mouseDelayMs?: number;
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;
	private mouse: ListMouse<number>;
	private mouseReadyAt: number;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;
		this.mouseReadyAt = Date.now() + (opts?.mouseDelayMs ?? 0);
		this.mouse = new ListMouse<number>({
			isSelected: (index) => index === this.selectedIndex,
			select: (i) => {
				this.selectedIndex = i;
				this.updateList();
			},
			activate: (i) => {
				const option = this.options[i];
				if (!option) return false;
				this.onSelectCallback(option);
				return true;
			},
			step: (direction) => {
				const previousIndex = this.selectedIndex;
				this.selectedIndex = Math.max(0, Math.min(this.options.length - 1, this.selectedIndex + direction));
				if (this.selectedIndex !== previousIndex) this.updateList();
				return this.selectedIndex !== previousIndex;
			},
			ownsWheel: () => this.options.length > MAX_VISIBLE_OPTIONS,
			enabled: () => Date.now() >= this.mouseReadyAt,
		});

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(this.titleText);
		if (opts?.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("text", opts.description), 1, 0));
		}
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE_OPTIONS / 2), this.options.length - MAX_VISIBLE_OPTIONS),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE_OPTIONS, this.options.length);
		for (let i = startIndex; i < endIndex; i++) {
			const isSelected = i === this.selectedIndex;
			const text = isSelected
				? theme.fg("accent", "→ ") + theme.fg("accent", this.options[i])
				: `  ${theme.fg("text", this.options[i])}`;
			// Each region covers the entire wrapped option, not just its first row.
			this.listContainer.addChild(this.mouse.row(i, new Text(text, 1, 0)));
		}
		if (this.options.length > MAX_VISIBLE_OPTIONS) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.options.length})`), 1, 0),
			);
		}
		this.mouse.commitRows();
	}

	handleInput(keyData: string): void {
		this.mouse.clearHover();
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
