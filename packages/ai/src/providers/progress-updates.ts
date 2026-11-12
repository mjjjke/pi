import type { Api, Model } from "../types.ts";
import { parseAnthropicModelId } from "./anthropic-model-id.ts";

/** Beta header required for Anthropic `thinking.display: "updates"`. */
export const THINKING_DISPLAY_UPDATES_BETA = "thinking-display-updates-2026-08-18";

/**
 * Models that write user-facing progress updates between tool calls, per
 * https://platform.claude.com/docs/en/build-with-claude/thinking#progress-updates-between-tool-calls
 * (checked 2026-11-12): Fable >= 5, Mythos >= 5.1, Opus >= 5.5, Sonnet >= 5.5.
 * The API has no per-model flag; update the thresholds when a family is added
 * or a newer model lacks the feature.
 */
const PROGRESS_UPDATE_MINIMUMS: Record<string, readonly [number, number]> = {
	fable: [5, 0],
	mythos: [5, 1],
	opus: [5, 5],
	sonnet: [5, 5],
};

/** Native Anthropic model id (no provider prefix), e.g. `claude-opus-5-5` or a dated variant. */
export function anthropicSupportsProgressUpdates(id: string | undefined): boolean {
	const model = parseAnthropicModelId(id);
	const minimum = model && PROGRESS_UPDATE_MINIMUMS[model.family];
	return !!(
		model &&
		minimum &&
		(model.major > minimum[0] || (model.major === minimum[0] && model.minor >= minimum[1]))
	);
}

/** Whether the model accepts `thinking.display: "updates"` and writes progress updates. */
export function supportsProgressUpdates(model: Model<Api>): boolean {
	return (
		model.capabilities?.progressUpdates ??
		(model.api === "anthropic-messages" &&
			model.provider === "anthropic" &&
			anthropicSupportsProgressUpdates(model.id.split("/").at(-1)))
	);
}
