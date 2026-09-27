/**
 * Built-in Tool Renderer Example - Custom rendering for built-in tools
 *
 * Demonstrates how to change the rendering of built-in tools (read, bash,
 * edit, write) without touching their behavior. `pi.registerToolRenderer()`
 * decorates a tool's renderers in the interactive TUI only: the tool registry,
 * execution, and everything the model sees stay unchanged, so this composes
 * with other extensions that override the same tools' behavior.
 *
 * How it works:
 * - Each decorator receives `base`, which renders the next inner layer
 *   (another decorator or the tool's own renderer). The inner layer renders
 *   at most once per invocation; repeat calls return the first result.
 * - Skipping `base()` is fine per render for stateless renderers (read, edit,
 *   write). The bash result renderer runs an elapsed-time timer while output is
 *   partial, so this example leaves bash results to the built-in renderer.
 * - Return a component to replace the output, wrap `base()` to decorate it,
 *   or return `undefined` to keep the inner output unchanged.
 * - `context.state` and `context.lastComponent` belong to this decorator; the
 *   built-in renderer keeps its own, so wrapping its component is safe.
 * - Arguments may be incomplete while the call is streaming, hence `Partial`.
 * - To replace behavior (logging, access control, remote execution), re-register
 *   the tool instead; see tool-override.ts.
 *
 * Usage:
 *   pi -e ./built-in-tool-renderer.ts
 */

import type {
	BashToolInput,
	EditToolDetails,
	EditToolInput,
	ExtensionAPI,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	// --- Read: compact call line, line count instead of an empty collapsed result ---
	pi.registerToolRenderer<Partial<ReadToolInput>, ReadToolDetails | undefined>("read", {
		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("read ")) + theme.fg("accent", args.path ?? "...");
			if (args.offset || args.limit) {
				const parts: string[] = [];
				if (args.offset) parts.push(`offset=${args.offset}`);
				if (args.limit) parts.push(`limit=${args.limit}`);
				text += theme.fg("dim", ` (${parts.join(", ")})`);
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context, base) {
			// Expanded output and errors keep the built-in rendering (syntax highlighting, truncation notes).
			if (expanded || context.isError) return base();
			if (isPartial) return new Text(theme.fg("warning", "Reading..."), 0, 0);

			const content = result.content[0];
			if (content?.type === "image") return new Text(theme.fg("success", "Image loaded"), 0, 0);
			if (content?.type !== "text") return new Text(theme.fg("error", "No content"), 0, 0);

			let text = theme.fg("success", `${content.text.split("\n").length} lines`);
			if (result.details?.truncation?.truncated) {
				text += theme.fg("warning", ` (truncated from ${result.details.truncation.totalLines})`);
			}
			return new Text(text, 0, 0);
		},
	});

	// --- Bash: keep the built-in output, prefix the call with a label ---
	pi.registerToolRenderer<Partial<BashToolInput>>("bash", {
		renderCall(_args, theme, _context, base) {
			// The built-in call renderer also starts the elapsed-time clock, so always call base() here.
			const container = new Container();
			container.addChild(new Text(theme.fg("muted", "shell"), 0, 0));
			const inner = base();
			if (inner) container.addChild(inner);
			return container;
		},
		// No renderResult: the built-in result renderer (preview, timer, truncation notes) runs unchanged.
	});

	// --- Edit: diff stats when collapsed, the built-in diff when expanded ---
	pi.registerToolRenderer<Partial<EditToolInput>, EditToolDetails | undefined>("edit", {
		renderResult(result, { expanded, isPartial }, theme, context, base) {
			if (expanded || isPartial || context.isError || !result.details?.diff) return base();

			let additions = 0;
			let removals = 0;
			for (const line of result.details.diff.split("\n")) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}
			const text = theme.fg("success", `+${additions}`) + theme.fg("dim", " / ") + theme.fg("error", `-${removals}`);
			return new Text(text, 0, 0);
		},
	});

	// --- Write: path and line count instead of the content preview ---
	pi.registerToolRenderer<Partial<WriteToolInput>>("write", {
		renderCall(args, theme, context) {
			if (context.expanded) return undefined; // keep the built-in call rendering
			let text = theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", args.path ?? "...");
			if (args.content !== undefined) {
				text += theme.fg("dim", ` (${args.content.split("\n").length} lines)`);
			}
			return new Text(text, 0, 0);
		},
		renderResult(_result, { isPartial }, theme, context, base) {
			if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);
			if (context.isError) return base();
			return new Text(theme.fg("success", "Written"), 0, 0);
		},
	});
}
