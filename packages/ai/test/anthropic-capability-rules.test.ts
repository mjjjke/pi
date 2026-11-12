import { describe, expect, it } from "vitest";
import { anthropicSupportsFastMode } from "../src/providers/pi-fast-mode.ts";
import { anthropicSupportsProgressUpdates } from "../src/providers/progress-updates.ts";

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
