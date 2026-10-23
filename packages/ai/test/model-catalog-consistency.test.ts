import { describe, expect, it } from "vitest";
import { getModels } from "../src/compat.ts";
import {
	supportsMidConversationInstructionMessages,
	supportsMidConversationSystemMessages,
} from "../src/providers/instruction-messages.ts";
import type { Api, Model } from "../src/types.ts";

const FIRST_PARTY = ["openai", "openai-codex", "azure", "anthropic"] as const;

describe("model catalog consistency", () => {
	it("first-party models with developer messages also accept mid-conversation system messages", () => {
		const mismatched: string[] = [];
		let checked = 0;
		for (const provider of FIRST_PARTY) {
			for (const model of getModels(provider) as Model<Api>[]) {
				if (!supportsMidConversationInstructionMessages(model)) continue;
				checked++;
				if (!supportsMidConversationSystemMessages(model)) mismatched.push(`${model.provider}/${model.id}`);
			}
		}
		expect(checked).toBeGreaterThan(0);
		expect(mismatched).toEqual([]);
	});
});
