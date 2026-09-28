import type { Api, FastModeCapability, Model } from "../types.ts";

/** Anthropic enables fast responses via a top-level `speed: "fast"` body field. */
const ANTHROPIC_FAST_MODE: FastModeCapability = { provider: "anthropic", body: { speed: "fast" } };

/**
 * The OpenAI Codex backend enables priority (fast) responses via
 * `service_tier: "priority"` (Codex maps its `Fast` tier to this value).
 */
const CODEX_FAST_MODE: FastModeCapability = { provider: "openai-codex", body: { service_tier: "priority" } };

/**
 * Opus versions that accept `speed: "fast"`, per
 * https://platform.claude.com/docs/en/build-with-claude/fast-mode#supported-models
 * (checked 2026-09-28). Opus 4.7 rejects fast requests with an error and Opus
 * 4.6 silently runs them at standard speed, so neither is listed. The API has
 * no per-model fast-support flag; update this list when the docs change.
 */
const ANTHROPIC_FAST_MODE_VERSIONS = new Set(["4.8", "5", "5.5"]);

/**
 * Native Anthropic model id (no provider prefix), e.g. `claude-opus-5-5`,
 * `claude-opus-4.8` or a dated `claude-opus-5-20260101`.
 */
export function anthropicSupportsFastMode(id: string | undefined): boolean {
	if (!id) return false;
	const m = id.toLowerCase().match(/^claude-opus-(\d+)(?:[.-](\d{1,2})(?!\d))?/);
	if (!m) return false;
	const version = m[2] === undefined ? m[1] : `${m[1]}.${m[2]}`;
	return ANTHROPIC_FAST_MODE_VERSIONS.has(version);
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
