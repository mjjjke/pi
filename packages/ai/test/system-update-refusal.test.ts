import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { lazyApi } from "../src/api/lazy.ts";
import { getModel, streamSimple } from "../src/compat.ts";
import {
	assertSystemUpdatesSupported,
	supportsMidConversationSystemMessages,
} from "../src/providers/instruction-messages.ts";
import type { Api, AssistantMessage, Message, Model, ProviderStreams, Tool } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function tool(name: string): Tool {
	return { name, description: `${name} tool`, parameters: Type.Object({}) };
}

function model<TApi extends Api>(api: TApi, overrides: Partial<Model<TApi>> = {}): Model<TApi> {
	return {
		id: "test-model",
		name: "Test model",
		api,
		provider: "test",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 1000,
		...overrides,
	} as Model<TApi>;
}

function reply(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 3,
	};
}

const initial: Message = { role: "system", content: "base", toolsAdded: [tool("read")], timestamp: 1 };
const user: Message = { role: "user", content: "hi", timestamp: 2 };
const patch: Message = { role: "system", content: "", sections: { rules: "new" }, timestamp: 4 };
const toolDelta: Message = { role: "system", content: "", toolsAdded: [tool("late")], timestamp: 4 };
const withPatch = [initial, user, reply(), patch, { ...user, timestamp: 5 }];
const withToolDelta = [initial, user, reply(), toolDelta, { ...user, timestamp: 5 }];

describe("supportsMidConversationSystemMessages", () => {
	it.each(["google-generative-ai", "google-vertex", "bedrock-converse-stream"] as const)(
		"is false for %s whatever compat says",
		(api) => {
			expect(
				supportsMidConversationSystemMessages(
					model(api, { compat: { supportsMidConvoSystemMessages: true } } as Partial<Model<typeof api>>),
				),
			).toBe(false);
		},
	);

	it("is true for pi-messages", () => {
		expect(supportsMidConversationSystemMessages(model("pi-messages"))).toBe(true);
	});

	it.each([
		"anthropic-messages",
		"openai-completions",
		"openai-responses",
		"openai-codex-responses",
		"azure-openai-responses",
		"mistral-conversations",
	] as const)("follows compat.supportsMidConvoSystemMessages for %s", (api) => {
		expect(supportsMidConversationSystemMessages(model(api))).toBe(false);
		expect(
			supportsMidConversationSystemMessages(
				model(api, { compat: { supportsMidConvoSystemMessages: false } } as Partial<Model<typeof api>>),
			),
		).toBe(false);
		expect(
			supportsMidConversationSystemMessages(
				model(api, { compat: { supportsMidConvoSystemMessages: true } } as Partial<Model<typeof api>>),
			),
		).toBe(true);
	});
});

describe("assertSystemUpdatesSupported", () => {
	const refusing = model("openai-completions");

	it("allows the first run, a compaction epoch and systems emptied by hidden declarations", () => {
		const developer: Message = { role: "developer", content: "mask", timestamp: 1 };
		expect(() => assertSystemUpdatesSupported(refusing, { messages: [initial, developer, user] })).not.toThrow();
		expect(() =>
			assertSystemUpdatesSupported(refusing, {
				messages: [initial, developer, { role: "user", content: "summary", timestamp: 1 }, user, reply()],
			}),
		).not.toThrow();
		const emptied: Message = {
			role: "system",
			content: "",
			sections: {},
			toolsAdded: [],
			toolsRemoved: [],
			timestamp: 4,
		};
		expect(() =>
			assertSystemUpdatesSupported(refusing, { messages: [initial, user, reply(), emptied] }),
		).not.toThrow();
	});

	it("throws for a later section patch, text update or tool delta", () => {
		const text: Message = { role: "system", content: "later", timestamp: 4 };
		for (const update of [patch, toolDelta, text]) {
			expect(() => assertSystemUpdatesSupported(refusing, { messages: [initial, user, update] })).toThrow(
				"Model test/test-model does not support mid-conversation system messages, and this conversation changed its system prompt or tools after it started. Switch to a model that supports them, compact the conversation, or start a new one.",
			);
		}
	});

	it("leaves capable models and pi-messages untouched", () => {
		const capable = model("openai-completions", { compat: { supportsMidConvoSystemMessages: true } });
		expect(() => assertSystemUpdatesSupported(capable, { messages: withPatch })).not.toThrow();
		expect(() => assertSystemUpdatesSupported(model("pi-messages"), { messages: withPatch })).not.toThrow();
	});
});

describe("lazyApi refusal", () => {
	it("refuses before the API module loads", async () => {
		const load = vi.fn(async (): Promise<ProviderStreams> => {
			throw new Error("module must not load");
		});
		const api = lazyApi(load);
		const target = model("openai-completions");
		for (const call of [api.stream, api.streamSimple]) {
			const events: string[] = [];
			const stream = call(target, normalizeContext({ messages: withPatch }), {});
			for await (const event of stream) events.push(event.type);
			const result = await stream.result();
			expect(events).toEqual(["error"]);
			expect(result.errorMessage).toMatch(/does not support mid-conversation system messages/);
			expect(isRetryableAssistantError(result)).toBe(false);
			expect(isContextOverflow(result, target.contextWindow)).toBe(false);
		}
		expect(load).not.toHaveBeenCalled();
	});

	const refusingModels: Array<[string, () => Model<Api>]> = [
		["Google", () => model("google-generative-ai")],
		["Bedrock", () => model("bedrock-converse-stream")],
		["Mistral", () => model("mistral-conversations")],
		["Chat Completions", () => model("openai-completions")],
		["Responses", () => model("openai-responses")],
		["openai-codex/gpt-5.3-codex-spark", () => getModel("openai-codex", "gpt-5.3-codex-spark") as Model<Api>],
		["anthropic/claude-haiku-4-5", () => getModel("anthropic", "claude-haiku-4-5") as Model<Api>],
	];

	it.each(refusingModels)("refuses a patch and a tool delta through streamSimple for %s", async (_name, make) => {
		const target = make();
		expect(target).toBeDefined();
		for (const messages of [withPatch, withToolDelta]) {
			const onPayload = vi.fn();
			const events: string[] = [];
			const stream = streamSimple(target, { messages }, { apiKey: "test-key", onPayload });
			for await (const event of stream) events.push(event.type);
			const result = await stream.result();
			expect(events).toEqual(["error"]);
			expect(result.errorMessage).toMatch(/does not support mid-conversation system messages/);
			expect(onPayload).not.toHaveBeenCalled();
		}
	});
});
