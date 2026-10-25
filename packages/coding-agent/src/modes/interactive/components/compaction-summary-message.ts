import {
	Box,
	Container,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	TruncatedText,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { formatTokens } from "./footer.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
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
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
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

		const tokenStr = this.message.tokensBefore.toLocaleString();
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		const date = new Date(this.message.timestamp);
		const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		content.addChild(new TruncatedText(`${label} ${theme.fg("dim", time)}`, 0, 0));
		const tokenChange = `${tokenStr}${this.tokensAfter === undefined ? "" : ` → ~${formatTokens(this.tokensAfter)}`}`;
		content.addChild(new Spacer(1));

		if (this.expanded) {
			const header = `**Compacted from ${tokenChange} tokens**\n\n`;
			content.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			content.addChild(
				new TruncatedText(
					theme.fg("customMessageText", `${tokenChange} tokens (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
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
