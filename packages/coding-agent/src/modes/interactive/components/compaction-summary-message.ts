import {
	Box,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";
import { keyText } from "./keybinding-hints.ts";

/** Display-only compaction receipt; expansion reveals the summary without adding panel chrome. */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;
	private tokensAfter: number | undefined;

	constructor(
		message: CompactionSummaryMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		tokensAfter?: number,
	) {
		super(outputPad, 0);
		this.message = message;
		this.tokensAfter = tokensAfter;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	override render(width: number): string[] {
		return super.render(width).map((line) => truncateToWidth(line, width));
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const content = new Container();
		content.addChild({
			invalidate() {},
			render: (width) => {
				const format = this.expanded ? (count: number) => count.toLocaleString() : formatTokens;
				const change = `${format(this.message.tokensBefore)}${this.tokensAfter === undefined ? "" : ` → ~${format(this.tokensAfter)}`} tokens`;
				const label = `${theme.fg("success", "✓")} ${theme.fg("accent", "compaction")}`;
				const date = new Date(this.message.timestamp);
				const time = theme.fg(
					"dim",
					`${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
				);
				const tokens = theme.fg("muted", change);
				const hint = this.expanded ? "" : `  ${theme.fg("dim", `(${keyText("app.tools.expand")} to expand)`)}`;
				let header = `${label}  ${time}  ${tokens}${hint}`;
				if (visibleWidth(header) > width) header = `${label}  ${time}  ${tokens}`;
				if (visibleWidth(header) > width) header = `${label}  ${tokens}`;
				return [truncateToWidth(header, width)];
			},
		});
		if (this.expanded) {
			content.addChild(new Spacer(1));
			content.addChild(
				new Markdown(this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		}
		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
