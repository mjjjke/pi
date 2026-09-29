import type { Api, Model } from "../types.ts";

/** Beta header required for Anthropic `thinking.display: "updates"`. */
export const THINKING_DISPLAY_UPDATES_BETA = "thinking-display-updates-2026-08-18";

/**
 * Models that write user-facing progress updates between tool calls, per
 * https://platform.claude.com/docs/en/build-with-claude/thinking#progress-updates-between-tool-calls
 * (checked 2026-10-01): Claude Fable 5.1, Mythos 5.1, Opus 5.5, Sonnet 5.5 and
 * Fable 5. The API has no per-model flag; update this list when the docs change.
 */
const ANTHROPIC_PROGRESS_UPDATE_MODELS =
	/^claude-(?:fable-5(?:[.-]1)?|mythos-5[.-]1|opus-5[.-]5|sonnet-5[.-]5)(?:-\d{8})?$/;

/** Native Anthropic model id (no provider prefix), e.g. `claude-opus-5-5` or a dated variant. */
export function anthropicSupportsProgressUpdates(id: string | undefined): boolean {
	return id !== undefined && ANTHROPIC_PROGRESS_UPDATE_MODELS.test(id.toLowerCase());
}

/** Whether the model accepts `thinking.display: "updates"` and writes progress updates. */
export function supportsProgressUpdates(model: Model<Api>): boolean {
	return model.capabilities?.progressUpdates === true;
}
