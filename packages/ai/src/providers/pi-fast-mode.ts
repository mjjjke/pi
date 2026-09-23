import type { Api, FastModeCapability, Model } from "../types.ts";

/** Anthropic enables fast responses via a top-level `speed: "fast"` body field. */
const ANTHROPIC_FAST_MODE: FastModeCapability = { provider: "anthropic", body: { speed: "fast" } };

/**
 * The OpenAI Codex backend enables priority (fast) responses via
 * `service_tier: "priority"` (Codex maps its `Fast` tier to this value).
 */
const CODEX_FAST_MODE: FastModeCapability = { provider: "openai-codex", body: { service_tier: "priority" } };

/**
 * Claude Code gates fast mode to Opus 4.6/4.7/4.8. Native model id (no
 * provider prefix); ignores `claude-opus-4` with no minor and other families.
 */
export function anthropicSupportsFastMode(id: string | undefined): boolean {
	if (!id) return false;
	const m = id.toLowerCase().match(/^claude-opus-4[.-](\d{1,2})(?![0-9])/);
	if (!m) return false;
	const minor = Number(m[1]);
	return minor >= 6 && minor <= 8;
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
