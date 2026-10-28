/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard and fullscreen mouse navigation.
 */

import { Container, getKeybindings, MouseRegion, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
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
		this.addChild(
			new MouseRegion(this.listContainer, (event) => {
				// Short lists leave the wheel to the surrounding chat viewport.
				if (event.type !== "wheel" || !event.wheelDelta || this.options.length <= MAX_VISIBLE_OPTIONS) {
					return undefined;
				}
				const previousIndex = this.selectedIndex;
				this.selectedIndex = Math.max(
					0,
					Math.min(this.options.length - 1, this.selectedIndex + (event.wheelDelta < 0 ? -1 : 1)),
				);
				if (this.selectedIndex !== previousIndex) this.updateList();
				return { handled: true, render: this.selectedIndex !== previousIndex };
			}),
		);
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
			this.listContainer.addChild(
				new MouseRegion(new Text(text, 1, 0), (event) => {
					// Like SelectList, hover does not move the centered visible range.
					if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
					this.selectedIndex = i;
					this.updateList();
					if (event.type === "click") {
						const selected = this.options[i];
						if (selected) this.onSelectCallback(selected);
					}
					return { handled: true, focus: event.type === "press" };
				}),
			);
		}
		if (this.options.length > MAX_VISIBLE_OPTIONS) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.options.length})`), 1, 0),
			);
		}
	}

	handleInput(keyData: string): void {
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
