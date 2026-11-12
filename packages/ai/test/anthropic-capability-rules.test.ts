import { describe, expect, it } from "vitest";
import { supportsMidConversationInstructionMessages } from "../src/providers/instruction-messages.ts";
import { anthropicSupportsFastMode, getFastModeCapability } from "../src/providers/pi-fast-mode.ts";
import { anthropicSupportsProgressUpdates, supportsProgressUpdates } from "../src/providers/progress-updates.ts";
import type { Model } from "../src/types.ts";

describe("capability accessors resolve raw models", () => {
	it.each(["claude-fable-6", "claude-fable-5-2", "anthropic/claude-fable-5-2"])(
		"%s falls back without mutating",
		(id) => {
			const model: Model<"anthropic-messages"> = {
				id,
				provider: "anthropic",
				api: "anthropic-messages",
				name: id,
				baseUrl: "https://example.test",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 64000,
			};
			expect(supportsProgressUpdates(model)).toBe(true);
			expect(supportsMidConversationInstructionMessages(model)).toBe(true);
			expect(getFastModeCapability(model)).toEqual({ provider: "anthropic", body: { speed: "fast" } });
			expect(model.capabilities).toBeUndefined();
			const explicit: Model<"anthropic-messages"> & {
				capabilities: NonNullable<Model<"anthropic-messages">["capabilities"]>;
			} = {
				...model,
				capabilities: {
					progressUpdates: false,
					midConversationInstructionMessages: false,
					fastMode: { provider: "anthropic", body: { speed: "custom" } },
				},
			};
			expect(supportsProgressUpdates(explicit)).toBe(false);
			expect(supportsMidConversationInstructionMessages(explicit)).toBe(false);
			expect(getFastModeCapability(explicit)).toBe(explicit.capabilities.fastMode);
			for (const provider of ["openrouter", "amazon-bedrock", "proxy"]) {
				const thirdParty = { ...model, provider };
				expect(supportsProgressUpdates(thirdParty)).toBe(false);
				expect(supportsMidConversationInstructionMessages(thirdParty)).toBe(false);
				expect(getFastModeCapability(thirdParty)).toBeUndefined();
			}
			const wrongApi = { ...model, api: "bedrock-converse-stream" as const };
			expect(supportsProgressUpdates(wrongApi)).toBe(false);
			expect(supportsMidConversationInstructionMessages(wrongApi)).toBe(false);
			expect(getFastModeCapability(wrongApi)).toBeUndefined();
		},
	);
});

describe("Anthropic family minimum-version rules", () => {
	it.each([
		["claude-fable-5", true, false],
		["claude-fable-5-1", true, false],
		["claude-fable-5-2", true, true],
		["claude-fable-5.2-20261112", true, true],
		["claude-fable-5-10", true, true],
		["claude-fable-6", true, true],
		["claude-fable-4-99", false, false],
		["claude-mythos-5", false, false],
		["claude-mythos-5.1", true, false],
		["claude-mythos-5-2", true, true],
		["claude-mythos-5-2-20261112", true, true],
		["claude-mythos-6", true, true],
		["claude-opus-4-6", false, false],
		["claude-opus-4-7", false, false],
		["claude-opus-4.8", false, true],
		["claude-opus-4-8-20261112", false, true],
		["claude-opus-4-80", false, true],
		["claude-opus-5", false, true],
		["claude-opus-5-1", false, true],
		["claude-opus-5.4", false, true],
		["claude-opus-5-5", true, true],
		["claude-opus-6", true, true],
		["claude-sonnet-5", false, false],
		["claude-sonnet-5-4", false, false],
		["claude-sonnet-5.5", true, false],
		["claude-sonnet-6-20261112", true, false],
		["claude-haiku-5-5", false, false],
		["claude-unknown-6", false, false],
		["claude-mythos-preview", false, false],
		["claude-fable-5-100", false, false],
		["claude-fable-5-2-extra", false, false],
		["claude-fable-5-2026111", false, false],
		["claude-fable-5-2@20261112", false, false],
		["anthropic/claude-fable-5-2", false, false],
		["CLAUDE-FABLE-5.2", true, true],
		[undefined, false, false],
	] as const)("%s: updates=%s, fast=%s", (id, updates, fast) => {
		expect(anthropicSupportsProgressUpdates(id)).toBe(updates);
		expect(anthropicSupportsFastMode(id)).toBe(fast);
	});
});
