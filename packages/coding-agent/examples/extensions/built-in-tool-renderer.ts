/**
 * Display-only tool rendering with both registerToolRenderer overloads.
 *
 * The resolver form chooses renderers in the TUI and HTML exports, including
 * tools not registered yet. `next()` preserves the remaining resolver chain.
 * The named decorator form wraps the resolved renderers in the TUI only, with
 * private state/lastComponent per layer and a memoized `base(theme?)`.
 * Neither form replaces execution or changes model-visible tool declarations.
 *
 * Usage: pi -e ./built-in-tool-renderer.ts
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
	// Supply a renderer for a resumed MCP tool before its server connects.
	// Registered renderers and other resolvers take precedence through next().
	pi.registerToolRenderer((toolName, next) => {
		const resolved = next();
		if (resolved || toolName !== "mcp_example_status") return resolved;
		return {
			renderCall: (_args, theme) => new Text(theme.fg("toolTitle", "MCP status"), 0, 0),
		};
	});

	// Decorators wrap any resolved renderer, including the resolver above.
	pi.registerToolRenderer("mcp_example_status", {
		renderCall: (_args, theme, _context, base) => {
			const container = new Container();
			container.addChild(new Text(theme.fg("muted", "remote"), 0, 0));
			const inner = base();
			if (inner) container.addChild(inner);
			return container;
		},
	});

	// Compact read results, retaining built-in expanded output and errors.
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

	pi.registerToolRenderer<Partial<BashToolInput>>("bash", {
		renderCall(_args, theme, _context, base) {
			// Always run the built-in call renderer: it starts the elapsed-time clock.
			const container = new Container();
			container.addChild(new Text(theme.fg("muted", "shell"), 0, 0));
			const inner = base();
			if (inner) container.addChild(inner);
			return container;
		},
		// Leave result rendering untouched so partial/final renders manage the timer.
	});

	pi.registerToolRenderer<Partial<EditToolInput>, EditToolDetails | undefined>("edit", {
		renderResult(result, { expanded, isPartial }, theme, context, base) {
			if (expanded || isPartial || context.isError || !result.details?.diff) return base();
			let additions = 0;
			let removals = 0;
			for (const line of result.details.diff.split("\n")) {
				if (line.startsWith("+") && !line.startsWith("+++")) additions++;
				if (line.startsWith("-") && !line.startsWith("---")) removals++;
			}
			return new Text(
				theme.fg("success", `+${additions}`) + theme.fg("dim", " / ") + theme.fg("error", `-${removals}`),
				0,
				0,
			);
		},
	});

	pi.registerToolRenderer<Partial<WriteToolInput>>("write", {
		renderCall(args, theme, context) {
			if (context.expanded) return undefined;
			let text = theme.fg("toolTitle", theme.bold("write ")) + theme.fg("accent", args.path ?? "...");
			if (args.content !== undefined) text += theme.fg("dim", ` (${args.content.split("\n").length} lines)`);
			return new Text(text, 0, 0);
		},
		renderResult(_result, { isPartial }, theme, context, base) {
			if (isPartial) return new Text(theme.fg("warning", "Writing..."), 0, 0);
			if (context.isError) return base();
			return new Text(theme.fg("success", "Written"), 0, 0);
		},
	});
}
