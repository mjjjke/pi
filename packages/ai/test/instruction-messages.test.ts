import { describe, expect, it } from "vitest";
import { convertMessages as convertAnthropicMessages } from "../src/api/anthropic-messages.ts";
import { convertMessages as convertOpenAICompletionsMessages } from "../src/api/openai-completions.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModels } from "../src/compat.ts";
import {
	anthropicSupportsMidConversationInstructions,
	openAiSupportsMidConversationInstructions,
	supportsMidConversationInstructionMessages,
} from "../src/providers/instruction-messages.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	KnownProvider,
	Message,
	Model,
	OpenAICompletionsCompat,
	Usage,
} from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const openAICompletionsCompat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

function openAICompletionsModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "gpt-5.5",
		name: "GPT 5.5",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		capabilities: { midConversationInstructionMessages: true },
		compat: openAICompletionsCompat,
		...overrides,
	};
}

function openAIResponsesModel(overrides: Partial<Model<"openai-responses">> = {}): Model<"openai-responses"> {
	return {
		id: "gpt-5.5",
		name: "GPT 5.5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		capabilities: { midConversationInstructionMessages: true },
		...overrides,
	};
}

function anthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		capabilities: { midConversationInstructionMessages: true },
		...overrides,
	};
}

function assistant(api: AssistantMessage["api"], model: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Done." }],
		api,
		provider: "test",
		model,
		usage,
		stopReason: "stop",
		timestamp: 3,
	};
}

function generatedModel(provider: KnownProvider, id: string): Model<Api> {
	const model = (getModels(provider) as Model<Api>[]).find((candidate) => candidate.id === id);
	if (!model) throw new Error(`Missing generated model ${provider}/${id}`);
	return model;
}

describe("mid-conversation instruction messages", () => {
	it("detects model support by provider and model id", () => {
		expect(openAiSupportsMidConversationInstructions("gpt-5.4")).toBe(true);
		expect(openAiSupportsMidConversationInstructions("gpt-5.3")).toBe(false);
		expect(openAiSupportsMidConversationInstructions("gpt-6")).toBe(true);
		expect(anthropicSupportsMidConversationInstructions("claude-opus-4-8")).toBe(true);
		expect(anthropicSupportsMidConversationInstructions("claude-sonnet-4.6")).toBe(false);
		expect(supportsMidConversationInstructionMessages(openAIResponsesModel())).toBe(true);
		expect(
			supportsMidConversationInstructionMessages(
				openAIResponsesModel({ capabilities: { midConversationInstructionMessages: false } }),
			),
		).toBe(false);
	});

	it("generates instruction capabilities only for first-party supported model metadata", () => {
		expect(generatedModel("anthropic", "claude-opus-4-8").capabilities?.midConversationInstructionMessages).toBe(
			true,
		);
		expect(generatedModel("openai", "gpt-5.4").capabilities?.midConversationInstructionMessages).toBe(true);
		expect(
			generatedModel("openrouter", "anthropic/claude-opus-4.8").capabilities?.midConversationInstructionMessages,
		).toBeUndefined();
		expect(
			generatedModel("vercel-ai-gateway", "anthropic/claude-opus-4.8").capabilities
				?.midConversationInstructionMessages,
		).toBeUndefined();
		expect(
			generatedModel("openrouter", "openai/gpt-5.4").capabilities?.midConversationInstructionMessages,
		).toBeUndefined();
	});

	it("serializes developer messages for OpenAI Chat Completions", () => {
		const model = openAICompletionsModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "Implement this", timestamp: 1 },
				{ role: "developer", content: "Prefer minimal diffs.", timestamp: 2 },
				assistant(model.api, model.id),
			],
		};

		const messages = convertOpenAICompletionsMessages(model, context, openAICompletionsCompat);
		expect(messages.map((message) => message.role)).toEqual(["user", "developer", "assistant"]);
		expect(messages[1]).toMatchObject({ role: "developer", content: "Prefer minimal diffs." });
	});

	it("skips blank instruction messages for OpenAI Chat Completions", () => {
		const model = openAICompletionsModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "Implement this", timestamp: 1 },
				{ role: "developer", content: "   ", timestamp: 2 },
				assistant(model.api, model.id),
			],
		};

		const messages = convertOpenAICompletionsMessages(model, context, openAICompletionsCompat);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("drops instruction messages when OpenAI Chat Completions model support is absent", () => {
		const model = openAICompletionsModel({
			id: "gpt-5.3",
			capabilities: { midConversationInstructionMessages: false },
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "Implement this", timestamp: 1 },
				{ role: "developer", content: "Prefer minimal diffs.", timestamp: 2 },
				assistant(model.api, model.id),
			],
		};

		const messages = convertOpenAICompletionsMessages(model, context, openAICompletionsCompat);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("drops instruction messages when Anthropic model support is absent", () => {
		const model = anthropicModel({
			id: "claude-sonnet-4.6",
			capabilities: { midConversationInstructionMessages: false },
		});
		const messages: Message[] = [
			{ role: "user", content: "Implement this", timestamp: 1 },
			{ role: "developer", content: "Keep changes reversible.", timestamp: 2 },
			assistant(model.api, model.id),
		];

		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("serializes instruction messages into OpenAI Responses input", () => {
		const model = openAIResponsesModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "Implement this", timestamp: 1 },
				{ role: "system", content: [{ type: "text", text: "Stay in plan mode." }], timestamp: 2 },
				assistant(model.api, model.id),
			],
		};

		const input = convertResponsesMessages(model, context, new Set());
		expect(input.map((item) => ("role" in item ? item.role : item.type))).toEqual(["user", "system", "assistant"]);
		expect(input[1]).toMatchObject({
			role: "system",
			content: [{ type: "input_text", text: "Stay in plan mode." }],
		});
	});

	it("keeps OpenAI Responses instruction message order", () => {
		const model = openAIResponsesModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "Previous turn", timestamp: 1 },
				{ role: "developer", content: "Use the new mode.", timestamp: 2 },
				{ role: "user", content: "Kickoff", timestamp: 3 },
			],
		};

		const input = convertResponsesMessages(model, context, new Set());
		expect(input.map((item) => ("role" in item ? item.role : item.type))).toEqual(["user", "developer", "user"]);
	});

	it("skips blank instruction messages for OpenAI Responses", () => {
		const model = openAIResponsesModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "Implement this", timestamp: 1 },
				{ role: "system", content: [{ type: "text", text: "   " }], timestamp: 2 },
				assistant(model.api, model.id),
			],
		};

		const input = convertResponsesMessages(model, context, new Set());
		expect(input.map((item) => ("role" in item ? item.role : item.type))).toEqual(["user", "assistant"]);
	});

	it("downgrades developer to system for OpenAI-compatible providers that lack developer role support", () => {
		const model = openAIResponsesModel({
			compat: { supportsDeveloperRole: false },
		});
		const context: Context = {
			messages: [
				{ role: "user", content: "Implement this", timestamp: 1 },
				{ role: "developer", content: "Use system instead.", timestamp: 2 },
			],
		};

		const input = convertResponsesMessages(model, context, new Set());
		expect(input[1]).toMatchObject({ role: "system" });
	});

	it("serializes supported Anthropic instruction placement as message-level system", () => {
		const model = anthropicModel();
		const messages: Message[] = [
			{ role: "user", content: "Implement this", timestamp: 1 },
			{ role: "developer", content: "Keep changes reversible.", timestamp: 2 },
			assistant(model.api, model.id),
		];

		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map((message) => message.role)).toEqual(["user", "system", "assistant"]);
		expect(params[1]).toMatchObject({
			role: "system",
			content: [{ type: "text", text: "Keep changes reversible." }],
		});
	});

	it("normalizes Anthropic instructions after the next user-like anchor", () => {
		const model = anthropicModel();
		const messages: Message[] = [
			{ role: "user", content: "Previous turn", timestamp: 1 },
			{ role: "developer", content: "Use the new mode.", timestamp: 2 },
			{ role: "user", content: "Kickoff", timestamp: 3 },
			assistant(model.api, model.id),
		];

		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map((message) => message.role)).toEqual(["user", "user", "system", "assistant"]);
		expect(params[2]).toMatchObject({
			role: "system",
			content: [{ type: "text", text: "Use the new mode." }],
		});
	});

	it("drops Anthropic instruction messages outside valid placement instead of throwing", () => {
		const model = anthropicModel();
		const messages: Message[] = [
			{ role: "user", content: "Implement this", timestamp: 1 },
			assistant(model.api, model.id),
			{ role: "system", content: "Too late.", timestamp: 4 },
		];

		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("does not move Anthropic prompt cache control to an earlier user when conversation ends with assistant", () => {
		const model = anthropicModel();
		const messages: Message[] = [
			{ role: "user", content: "Implement this", timestamp: 1 },
			assistant(model.api, model.id),
		];

		const params = convertAnthropicMessages(messages, model, false, { type: "ephemeral" });
		expect(params[0]).toMatchObject({ role: "user", content: "Implement this" });
	});

	it("keeps Anthropic prompt cache control on the last user message when an instruction follows it", () => {
		const model = anthropicModel();
		const messages: Message[] = [
			{ role: "user", content: "Implement this", timestamp: 1 },
			{ role: "developer", content: "Cache should stay on user.", timestamp: 2 },
		];

		const params = convertAnthropicMessages(messages, model, false, { type: "ephemeral" });
		expect(params[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "Implement this", cache_control: { type: "ephemeral" } }],
		});
	});
});
