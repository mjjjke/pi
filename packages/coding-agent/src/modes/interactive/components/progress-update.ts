import { type AssistantMessage, anthropicSupportsProgressUpdates } from "@earendil-works/pi-ai";
import { type Component, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const BULLET = "• ";

function isCommentaryText(textSignature: string | undefined): boolean {
	if (!textSignature?.startsWith("{")) return false;
	try {
		return (JSON.parse(textSignature) as { phase?: unknown }).phase === "commentary";
	} catch {
		return false;
	}
}

/**
 * Content indices of an assistant message that render as progress updates:
 * - thinking blocks marked `progressUpdate` (Anthropic display "updates");
 * - OpenAI text with phase "commentary" (known once the item is done);
 * - summarized Anthropic messages from models with progress updates: in a run of
 *   two or more thinking blocks directly followed by a tool call, the last block.
 *   The API does not mark updates under "summarized", so this is a render-time
 *   heuristic that never changes the stored message.
 */
export function getProgressUpdateIndices(message: AssistantMessage): Set<number> {
	const indices = new Set<number>();
	const { content } = message;
	let hasMarkedUpdates = false;
	for (let i = 0; i < content.length; i++) {
		const block = content[i];
		if (block.type === "thinking" && block.progressUpdate) {
			indices.add(i);
			hasMarkedUpdates = true;
		} else if (block.type === "text" && isCommentaryText(block.textSignature)) {
			indices.add(i);
		}
	}

	const nativeModelId = message.model.split("/").at(-1);
	if (hasMarkedUpdates || message.api !== "anthropic-messages" || !anthropicSupportsProgressUpdates(nativeModelId)) {
		return indices;
	}
	let runStart = -1;
	for (let i = 0; i <= content.length; i++) {
		const block = content[i];
		if (block?.type === "thinking") {
			if (runStart === -1) runStart = i;
			continue;
		}
		const last = content[i - 1];
		if (
			runStart !== -1 &&
			i - runStart >= 2 &&
			block?.type === "toolCall" &&
			last?.type === "thinking" &&
			!last.redacted &&
			last.thinking.trim()
		) {
			indices.add(i - 1);
		}
		runStart = -1;
	}
	return indices;
}

/** A progress update: muted bullet plus regular (non-italic) Markdown with a hanging indent. */
export class ProgressUpdateComponent implements Component {
	private markdown: Markdown;
	private outputPad: number;

	constructor(
		text: string,
		outputPad: number,
		markdownTheme: MarkdownTheme,
		transform?: (markdown: string, availableWidth: number) => string,
	) {
		this.outputPad = outputPad;
		this.markdown = new Markdown(text, 0, 0, markdownTheme, undefined, transform ? { transform } : undefined);
	}

	render(width: number): string[] {
		const margin = " ".repeat(this.outputPad);
		const contentWidth = Math.max(1, width - this.outputPad * 2 - BULLET.length);
		return this.markdown
			.render(contentWidth)
			.map((line, index) => margin + (index === 0 ? theme.fg("muted", BULLET) : " ".repeat(BULLET.length)) + line);
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}
