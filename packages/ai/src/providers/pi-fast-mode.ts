import type { Api, FastModeCapability, Model } from "../types.ts";
import { parseAnthropicModelId } from "./anthropic-model-id.ts";

/** Anthropic enables fast responses via a top-level `speed: "fast"` body field. */
const ANTHROPIC_FAST_MODE: FastModeCapability = { provider: "anthropic", body: { speed: "fast" } };

/**
 * The OpenAI Codex backend enables priority (fast) responses via
 * `service_tier: "priority"` (Codex maps its `Fast` tier to this value).
 */
const CODEX_FAST_MODE: FastModeCapability = { provider: "openai-codex", body: { service_tier: "priority" } };

/**
 * Models accepting `speed: "fast"`, per supportedModels frontmatter at
 * https://platform.claude.com/docs/en/build-with-claude/fast-mode
 * (checked 2026-11-12): Opus >= 4.8, Fable >= 5.2, Mythos >= 5.2.
 * Opus 4.7 errors and 4.6 silently runs at standard speed. Anthropic removes
 * Opus 4.8 fast on 2026-11-30 (requests then error); drop it from the rule after
 * that date. Update thresholds when a family is added or a newer model lacks fast.
 */
const FAST_MODE_MINIMUMS: Record<string, readonly [number, number]> = {
	opus: [4, 8],
	fable: [5, 2],
	mythos: [5, 2],
};

/**
 * Native Anthropic model id (no provider prefix), e.g. `claude-opus-5-5`,
 * `claude-opus-4.8` or a dated `claude-opus-5-20260101`.
 */
export function anthropicSupportsFastMode(id: string | undefined): boolean {
	const model = parseAnthropicModelId(id);
	const minimum = model && FAST_MODE_MINIMUMS[model.family];
	return !!(
		model &&
		minimum &&
		(model.major > minimum[0] || (model.major === minimum[0] && model.minor >= minimum[1]))
	);
}

/** The first-party OpenAI Codex backend advertises the `priority` service tier. */
export function codexSupportsFastMode(provider: Model<Api>["provider"], api: Api): boolean {
	return provider === "openai-codex" && api === "openai-codex-responses";
}

export function getAnthropicFastModeCapability(id: string | undefined): FastModeCapability | undefined {
	return anthropicSupportsFastMode(id) ? ANTHROPIC_FAST_MODE : undefined;
}

export function getCodexFastModeCapability(provider: Model<Api>["provider"], api: Api): FastModeCapability | undefined {
	return codexSupportsFastMode(provider, api) ? CODEX_FAST_MODE : undefined;
}
