import { describe, expect, it } from "vitest";
import { getModels } from "../src/compat.ts";
import {
	anthropicSupportsFastMode,
	codexSupportsFastMode,
	getAnthropicFastModeCapability,
	getCodexFastModeCapability,
} from "../src/providers/pi-fast-mode.ts";
import type { Api, KnownProvider, Model } from "../src/types.ts";

function generatedModel(provider: KnownProvider, id: string): Model<Api> {
	const model = (getModels(provider) as Model<Api>[]).find((candidate) => candidate.id === id);
	if (!model) throw new Error(`Missing generated model ${provider}/${id}`);
	return model;
}

describe("pi-fast-mode capability detection", () => {
	it("gates Anthropic fast mode to Opus 4.6/4.7/4.8", () => {
		expect(anthropicSupportsFastMode("claude-opus-4-6")).toBe(true);
		expect(anthropicSupportsFastMode("claude-opus-4.7")).toBe(true);
		expect(anthropicSupportsFastMode("claude-opus-4-8")).toBe(true);
		expect(anthropicSupportsFastMode("claude-opus-4-5")).toBe(false);
		expect(anthropicSupportsFastMode("claude-opus-4")).toBe(false);
		expect(anthropicSupportsFastMode("claude-sonnet-4-6")).toBe(false);
		expect(anthropicSupportsFastMode(undefined)).toBe(false);
	});

	it("gates Codex fast mode to the first-party Codex backend", () => {
		expect(codexSupportsFastMode("openai-codex", "openai-codex-responses")).toBe(true);
		expect(codexSupportsFastMode("openai", "openai-responses")).toBe(false);
		expect(codexSupportsFastMode("openai-codex", "openai-responses")).toBe(false);
	});

	it("shapes the provider-specific wire mutation", () => {
		expect(getAnthropicFastModeCapability("claude-opus-4-8")).toEqual({
			provider: "anthropic",
			body: { speed: "fast" },
		});
		expect(getAnthropicFastModeCapability("claude-sonnet-4-6")).toBeUndefined();
		expect(getCodexFastModeCapability("openai-codex", "openai-codex-responses")).toEqual({
			provider: "openai-codex",
			body: { service_tier: "priority" },
		});
		expect(getCodexFastModeCapability("openai", "openai-responses")).toBeUndefined();
	});

	it("marks supported built-in models in generated metadata", () => {
		expect(generatedModel("anthropic", "claude-opus-4-8").capabilities?.fastMode).toEqual({
			provider: "anthropic",
			body: { speed: "fast" },
		});
		expect(generatedModel("anthropic", "claude-opus-4-6").capabilities?.fastMode).toEqual({
			provider: "anthropic",
			body: { speed: "fast" },
		});
		expect(generatedModel("openai-codex", "gpt-5.4").capabilities?.fastMode).toEqual({
			provider: "openai-codex",
			body: { service_tier: "priority" },
		});
	});

	it("does not mark non-first-party providers", () => {
		expect(generatedModel("openrouter", "anthropic/claude-opus-4.8").capabilities?.fastMode).toBeUndefined();
	});
});
