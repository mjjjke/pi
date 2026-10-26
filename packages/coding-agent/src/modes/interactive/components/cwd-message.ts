import { homedir } from "node:os";
import { sliceByColumn, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";

/** Core-owned observation row: no box, and expansion is exactly the model-visible text. */
export const renderCwdMessage: MessageRenderer = (message, options, theme) => {
	const details = message.details as { kind?: string; from?: string; to?: string; cause?: string } | undefined;
	const displayPath = (path: string) =>
		path === homedir() || path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path;
	return {
		invalidate() {},
		render(width) {
			if (options.expanded) {
				const content =
					typeof message.content === "string"
						? message.content
						: message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n");
				return new Text(content, options.outputPad, 0).render(width);
			}
			const kind = details?.kind;
			const icon = theme.fg(
				kind === "applied" ? "success" : kind === "failed" ? "error" : "warning",
				kind === "applied" ? "✓" : kind === "failed" ? "✗" : "■",
			);
			const prefix = `${" ".repeat(options.outputPad)}${icon} ${theme.fg("accent", "cd")}  `;
			let target = displayPath(details?.to ?? "");
			let suffix =
				kind === "applied"
					? `  ${theme.fg("dim", "from")} ${theme.fg("muted", displayPath(details?.from ?? ""))}`
					: `  ${theme.fg("dim", kind === "failed" ? "failed:" : "not applied:")} ${theme.fg("muted", details?.cause ?? "")}`;
			let time = `  ${theme.fg("dim", new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }))}`;
			if (visibleWidth(prefix + target + suffix + time) > width) time = "";
			if (visibleWidth(prefix + target + suffix) > width) suffix = "";
			const available = width - visibleWidth(prefix);
			if (visibleWidth(target) > available)
				target =
					available >= 7 ? `…${sliceByColumn(target, visibleWidth(target) - available + 1, available - 1)}` : "";
			return [truncateToWidth(prefix + target + suffix + time, width)];
		},
	};
};
