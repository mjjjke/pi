import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import type { AssistantMessage, Message, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

class PayloadCaptured extends Error {}

interface Payload {
	system?: Array<{ type: string; text: string; cache_control?: unknown }>;
	tools?: Array<{ name: string; defer_loading?: boolean }>;
	messages: Array<{ role: string; content: unknown }>;
}

function model(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		capabilities: { midConversationInstructionMessages: true },
		compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
		...overrides,
	};
}

function tool(name: string): Tool {
	return { name, description: `${name} tool`, parameters: Type.Object({}) };
}

async function capture(messages: Message[], oauth = false, target = model()): Promise<Payload> {
	let payload: Payload | undefined;
	await streamAnthropic(target, normalizeContext({ messages }), {
		apiKey: oauth ? "sk-ant-oat-test" : "sk-ant-test",
		env: { PI_ANTHROPIC_CLAUDE_CODE_VERSION: "2.1.280" },
		onPayload: (params) => {
			payload = structuredClone(params) as Payload;
			throw new PayloadCaptured();
		},
	}).result();
	if (!payload) throw new Error("payload not captured");
	return payload;
}

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 5,
	};
}

const snapshot: Message = {
	role: "system",
	content: "",
	sections: { preamble: "You are pi." },
	toolsAdded: [tool("read")],
	timestamp: 1,
};
const mask: Message = { role: "developer", content: "<mode>Default</mode>", timestamp: 2 };
const handoff: Message = { role: "user", content: "Handoff", timestamp: 3 };
const prompt: Message = { role: "user", content: "Start", timestamp: 4 };

const texts = (payload: Payload) => payload.system?.map((block) => block.text) ?? [];

describe("Anthropic initial instruction fold", () => {
	it.each([false, true])("folds the initial developers into top-level system blocks (OAuth=%s)", async (oauth) => {
		const payload = await capture([snapshot, mask, handoff, prompt], oauth);
		const blocks = oauth ? texts(payload).slice(1) : texts(payload);
		if (oauth) expect(texts(payload)[0]).toMatch(/^x-anthropic-billing-header:/);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toContain("You are pi.");
		expect(blocks[1]).toBe("<mode>Default</mode>");
		expect(payload.system?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
		expect(payload.system?.slice(0, -1).some((block) => block.cache_control !== undefined)).toBe(false);
		expect(JSON.stringify(payload.messages)).not.toContain("<mode>");
		expect(payload.messages[0]?.role).toBe("user");
	});

	it.each([false, true])("keeps system and tools byte-identical after the reply (OAuth=%s)", async (oauth) => {
		const first = await capture([snapshot, mask, handoff, prompt], oauth);
		const second = await capture([snapshot, mask, handoff, prompt, reply("ok"), { ...prompt, timestamp: 6 }], oauth);
		const strip = (payload: Payload) =>
			JSON.stringify({ system: payload.system?.slice(oauth ? 1 : 0), tools: payload.tools });
		expect(strip(second)).toBe(strip(first));
	});

	it("places a later mode change after a user turn", async () => {
		const later: Message = { role: "developer", content: "<mode>Plan</mode>", timestamp: 7 };
		const payload = await capture([snapshot, mask, prompt, reply("ok"), { ...prompt, timestamp: 6 }, later]);
		expect(texts(payload)).not.toContain("<mode>Plan</mode>");
		expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "system"]);
		expect(JSON.stringify(payload.messages.at(-1))).toContain("<mode>Plan</mode>");
	});

	it("leaves the output unchanged without initial developers", async () => {
		const payload = await capture([snapshot, prompt]);
		expect(payload.system).toEqual([{ type: "text", text: "You are pi.", cache_control: { type: "ephemeral" } }]);
	});

	it.each([false, true])(
		"folds a compaction epoch's carried values after the checkpoint (OAuth=%s)",
		async (oauth) => {
			const checkpoint: Message = { ...snapshot, sections: { preamble: "Checkpoint." } };
			const carried: Message = { role: "developer", content: "<mode>Plan</mode>", timestamp: 8 };
			const summary: Message = { role: "user", content: "Summary of earlier work", timestamp: 8 };
			const payload = await capture([checkpoint, carried, summary, prompt], oauth);
			const blocks = oauth ? texts(payload).slice(1) : texts(payload);
			expect(blocks).toHaveLength(2);
			expect(blocks[0]).toContain("Checkpoint.");
			expect(blocks[1]).toBe("<mode>Plan</mode>");
			expect(JSON.stringify(payload.messages[0])).toContain("Summary of earlier work");
		},
	);

	it("folds nothing and drops developers on a model without the developer capability", async () => {
		const target = model({ capabilities: undefined });
		const folded = await capture([snapshot, mask, prompt], false, target);
		const plain = await capture([snapshot, prompt], false, target);
		expect(folded).toEqual(plain);
	});

	it("lets the next developer join the fold when the prefix-closing user message is removed", async () => {
		const later: Message = { role: "developer", content: "<mode>Plan</mode>", timestamp: 7 };
		const before = await capture([snapshot, mask, handoff, later, prompt]);
		expect(texts(before)).toHaveLength(2);
		const after = await capture([snapshot, mask, later, prompt]);
		expect(texts(after).slice(1)).toEqual(["<mode>Default</mode>", "<mode>Plan</mode>"]);
		expect(after.messages.map((message) => message.role)).toEqual(["user"]);
		expect(JSON.stringify(after.messages[0])).toContain("Start");
	});

	it("sends the current top-level tool list after a tool change when the session started with no tools", async () => {
		const bare: Message = { role: "system", content: "", sections: { preamble: "You are pi." }, timestamp: 1 };
		const delta: Message = { role: "system", content: "", toolsAdded: [tool("late")], timestamp: 7 };
		const payload = await capture([bare, mask, prompt, reply("ok"), { ...prompt, timestamp: 6 }, delta]);
		expect(payload.tools?.map((value) => value.name)).toEqual(["late"]);
		expect(payload.tools?.some((value) => value.defer_loading)).toBe(false);
	});
});
