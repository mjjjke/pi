import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { describe, expect, it } from "vitest";
import {
	convertMessages as convertAnthropicMessagesRaw,
	stream as streamAnthropic,
} from "../src/api/anthropic-messages.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import { convertMessages as convertOpenAICompletionsMessages } from "../src/api/openai-completions.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import { getModels, normalizeContext } from "../src/compat.ts";
import type { BuiltinProvider } from "../src/providers/all.ts";
import {
	anthropicSupportsMidConversationInstructions,
	openAiSupportsMidConversationInstructions,
	supportsMidConversationInstructionMessages,
} from "../src/providers/instruction-messages.ts";
import type { Api, AssistantMessage, Context, Message, Model, OpenAICompletionsCompat, Usage } from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const openAICompletionsCompat: Omit<Required<OpenAICompletionsCompat>, "thinkingTokenBudgetField" | "vllmPriority"> & {
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
} = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsThinkingTokenBudget: false,
	thinkingTokenBudgetField: undefined,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: true,
	supportsMidConvoToolAdditions: false,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
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

async function captureAnthropicPayload(messages: Message[]): Promise<MessageCreateParamsStreaming> {
	let payload: MessageCreateParamsStreaming | undefined;
	for await (const _ of streamAnthropic(
		anthropicModel({ compat: { supportsMidConvoSystemMessages: true } }),
		normalizeContext({ messages }),
		{
			apiKey: "test-key",
			onPayload: (params) => {
				payload = params as MessageCreateParamsStreaming;
				throw new Error("payload captured before network request");
			},
		},
	)) {
		// The expected payload-capture error terminates the local stream without a network call.
	}
	if (!payload) throw new Error("Anthropic payload was not captured");
	return payload;
}

function convertAnthropicMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	cacheControl?: Parameters<typeof convertAnthropicMessagesRaw>[2],
) {
	return convertAnthropicMessagesRaw(transformMessages(messages, model), isOAuthToken, cacheControl).messages;
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

type AnthropicParam = ReturnType<typeof convertAnthropicMessages>[number];

function anthropicAssistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	const model = anthropicModel();
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason,
		timestamp: 3,
	};
}

/**
 * Mid-conversation system placement rule: a content-carrying system group must immediately
 * follow a user turn (tool_result users included) and precede an assistant turn or end the array.
 */
function expectValidAnthropicSystemPlacement(params: AnthropicParam[], label = ""): void {
	// Without any turn the request is invalid anyway; its system messages are still sent.
	if (params.every((param) => param.role === "system")) return;
	for (let i = 0; i < params.length; i++) {
		if (params[i].role !== "system") continue;
		let start = i;
		while (start > 0 && params[start - 1].role === "system") start--;
		let end = i;
		while (end + 1 < params.length && params[end + 1].role === "system") end++;
		expect(params[start - 1]?.role, `${label} system at ${i} must follow a user turn`).toBe("user");
		if (end + 1 < params.length) {
			expect(params[end + 1].role, `${label} system at ${i} must precede an assistant turn`).toBe("assistant");
		}
	}
}

function systemTexts(params: AnthropicParam[]): string[] {
	return params.flatMap((param) =>
		param.role === "system" && Array.isArray(param.content)
			? param.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
			: [],
	);
}

/**
 * Transcript tokens: U user, D developer, S native system update, A assistant with signed
 * thinking, T assistant tool call + tool result, M tool call with a developer message
 * between the call and its result, E empty assistant, X aborted assistant.
 */
type Token = "U" | "D" | "S" | "A" | "T" | "M" | "E" | "X";
const TOKENS: Token[] = ["U", "D", "S", "A", "T", "M", "E", "X"];

function buildTranscript(tokens: Token[]): { messages: Message[]; instructionTexts: string[] } {
	const messages: Message[] = [];
	const instructionTexts: string[] = [];
	const signedThinking = (n: number) => ({
		type: "thinking" as const,
		thinking: `think-${n}`,
		thinkingSignature: `sig-${n}`,
	});
	tokens.forEach((token, n) => {
		switch (token) {
			case "U":
				messages.push({ role: "user", content: `user-${n}`, timestamp: n });
				break;
			case "D":
				instructionTexts.push(`dev-${n}`);
				messages.push({ role: "developer", content: `dev-${n}`, timestamp: n });
				break;
			case "S":
				instructionTexts.push(`sys-${n}`);
				messages.push({ role: "system", content: `sys-${n}`, timestamp: n });
				break;
			case "A":
				messages.push(anthropicAssistant([signedThinking(n), { type: "text", text: `answer-${n}` }]));
				break;
			case "T":
			case "M": {
				const id = `call_${n}`;
				messages.push(
					anthropicAssistant(
						[signedThinking(n), { type: "toolCall", id, name: "read", arguments: { path: `f${n}` } }],
						"toolUse",
					),
				);
				if (token === "M") {
					instructionTexts.push(`dev-${n}`);
					messages.push({ role: "developer", content: `dev-${n}`, timestamp: n });
				}
				messages.push({
					role: "toolResult",
					toolCallId: id,
					toolName: "read",
					content: [{ type: "text", text: `result-${n}` }],
					isError: false,
					timestamp: n,
				});
				break;
			}
			case "E":
				messages.push(anthropicAssistant([{ type: "text", text: "  " }]));
				break;
			case "X":
				messages.push(anthropicAssistant([{ type: "text", text: `partial-${n}` }], "aborted"));
				break;
		}
	});
	return { messages, instructionTexts };
}

/** Instructions that must be on the wire: those followed by a flush point (next emitted assistant or end) right after a user turn. */
function expectedEmittedInstructions(tokens: Token[]): string[] {
	const emitted: string[] = [];
	const pending: string[] = [];
	let lastIsUser = false;
	const flush = () => {
		if (lastIsUser) emitted.push(...pending.splice(0));
	};
	tokens.forEach((token, n) => {
		if (token === "U") lastIsUser = true;
		else if (token === "D") pending.push(`dev-${n}`);
		else if (token === "S") pending.push(`sys-${n}`);
		else if (token === "A" || token === "T" || token === "M") {
			flush();
			if (token === "M") pending.push(`dev-${n}`);
			lastIsUser = token !== "A";
		}
	});
	if (!tokens.some((token) => ["U", "A", "T", "M"].includes(token))) lastIsUser = true;
	flush();
	return emitted;
}

function allTokenSequences(maxLength: number): Token[][] {
	const result: Token[][] = [[]];
	let frontier: Token[][] = [[]];
	for (let length = 1; length <= maxLength; length++) {
		frontier = frontier.flatMap((sequence) => TOKENS.map((token) => [...sequence, token]));
		result.push(...frontier);
	}
	return result;
}

function generatedModel(provider: BuiltinProvider, id: string): Model<Api> {
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

	it("excludes Claude Sonnet 5 but keeps Sonnet 5.5 and other documented Anthropic models", () => {
		// https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages:
		// not available on Claude Sonnet 5.
		for (const id of [
			"claude-sonnet-5",
			"claude-sonnet-5-20260101",
			"claude-sonnet-5@20260101",
			"claude-sonnet-5-0",
			"anthropic.claude-sonnet-5",
			"us.anthropic.claude-sonnet-5",
			"anthropic/claude-sonnet-5",
			"claude-sonnet-4-6",
			"claude-haiku-4-5",
			"claude-opus-4-7",
			"claude-3-7-sonnet-20250219",
			"arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-5-5",
			"my-custom-model",
			"opus-5-5",
			"gpt-5.5",
			"",
		]) {
			expect(anthropicSupportsMidConversationInstructions(id), id).toBe(false);
		}
		for (const id of [
			"claude-sonnet-5-5",
			"claude-sonnet-5.5",
			"claude-sonnet-5-5-20260101",
			"global.anthropic.claude-sonnet-5-5",
			"claude-fable-5-1",
			"claude-fable-5",
			"claude-mythos-5-1",
			"claude-mythos-5",
			"claude-opus-5-5",
			"claude-opus-5",
			"claude-opus-4-8",
			"us.anthropic.claude-opus-5-5",
		]) {
			expect(anthropicSupportsMidConversationInstructions(id), id).toBe(true);
		}
	});

	it("does not advertise mid-conversation instructions for the pinned Claude Sonnet 5 model", () => {
		const sonnet5 = generatedModel("anthropic", "claude-sonnet-5");
		expect(sonnet5.capabilities?.midConversationInstructionMessages).toBeUndefined();
		expect(
			(sonnet5.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)?.supportsMidConvoSystemMessages,
		).not.toBe(true);
		expect(generatedModel("anthropic", "claude-opus-5-5").capabilities?.midConversationInstructionMessages).toBe(
			true,
		);
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

		const messages = convertOpenAICompletionsMessages(model, normalizeContext(context), openAICompletionsCompat);
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

		const messages = convertOpenAICompletionsMessages(model, normalizeContext(context), openAICompletionsCompat);
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

		const messages = convertOpenAICompletionsMessages(model, normalizeContext(context), openAICompletionsCompat);
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

	it("serializes developer messages into OpenAI Responses input", () => {
		const model = openAIResponsesModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "Implement this", timestamp: 1 },
				{ role: "developer", content: [{ type: "text", text: "Stay in plan mode." }], timestamp: 2 },
				assistant(model.api, model.id),
			],
		};

		const input = convertResponsesMessages(model, normalizeContext(context), new Set());
		expect(input.map((item) => ("role" in item ? item.role : item.type))).toEqual(["user", "developer", "assistant"]);
		expect(input[1]).toMatchObject({
			role: "developer",
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

		const input = convertResponsesMessages(model, normalizeContext(context), new Set());
		expect(input.map((item) => ("role" in item ? item.role : item.type))).toEqual(["user", "developer", "user"]);
	});

	it("excludes only the first occurrence when a system snapshot object is reused", () => {
		const model = openAIResponsesModel();
		const snapshot: Message = { role: "system", content: "", sections: { rules: "Base rules" }, timestamp: 1 };
		const input = convertResponsesMessages(
			model,
			normalizeContext({ messages: [snapshot, { role: "user", content: "First", timestamp: 2 }, snapshot] }),
			new Set(),
			{ includeSystemPrompt: false, supportsMidConvoSystemMessages: true },
		);
		expect(input.map((item) => ("role" in item ? item.role : item.type))).toEqual(["user", "developer"]);
		expect(input[1]).toMatchObject({ content: 'Updated system prompt section "rules":\n\nBase rules' });
	});

	it.each(["null", "omitted"] as const)("tracks the initial sections snapshot with %s content", (kind) => {
		const model = openAIResponsesModel();
		const snapshot = {
			role: "system",
			...(kind === "null" ? { content: null } : {}),
			sections: { rules: "Base rules" },
			timestamp: 1,
		} as unknown as Message;
		const context = normalizeContext({
			messages: [
				{ role: "developer", content: "Plan boundary", timestamp: 0 },
				snapshot,
				{ role: "user", content: "First", timestamp: 2 },
			],
		});
		const options = { supportsMidConvoSystemMessages: true };
		const withPrompt = convertResponsesMessages(model, context, new Set(), options);
		expect(withPrompt.map((item) => ("role" in item ? item.role : item.type))).toEqual([
			"developer",
			"developer",
			"user",
		]);
		expect(withPrompt[0]).toMatchObject({ content: [{ type: "input_text", text: "Plan boundary" }] });
		expect(withPrompt[1]).toMatchObject({ content: "Base rules" });
		const withoutPrompt = convertResponsesMessages(model, context, new Set(), {
			...options,
			includeSystemPrompt: false,
		});
		expect(withoutPrompt.map((item) => ("role" in item ? item.role : item.type))).toEqual(["developer", "user"]);
	});

	it("does not promote a later system update when an aborted assistant is filtered", () => {
		const model = openAIResponsesModel();
		const input = convertResponsesMessages(
			model,
			normalizeContext({
				messages: [
					{ role: "developer", content: "Plan boundary", timestamp: 0 },
					{ ...assistant(model.api, model.id), stopReason: "aborted" },
					{ role: "system", content: "Later update", timestamp: 1 },
					{ role: "user", content: "Next", timestamp: 2 },
				],
			}),
			new Set(),
			{ includeSystemPrompt: false, supportsMidConvoSystemMessages: true },
		);
		expect(input.map((item) => ("role" in item ? item.role : item.type))).toEqual(["developer", "developer", "user"]);
		expect(input[1]).toMatchObject({ content: "Later update" });
	});

	it("keeps a leading snapshot out of Codex input when preceded by developers", () => {
		const model = openAIResponsesModel();
		const context = normalizeContext({
			messages: [
				{ role: "developer", content: "Plan boundary", timestamp: 1 },
				{ role: "system", content: "Base prompt", timestamp: 2 },
				{ role: "user", content: "First", timestamp: 3 },
				assistant(model.api, model.id),
				{ role: "system", content: "Later update", timestamp: 4 },
			],
		});
		const input = convertResponsesMessages(model, context, new Set(), {
			includeSystemPrompt: false,
			supportsMidConvoSystemMessages: true,
		});
		expect(input.map((item) => ("role" in item ? item.role : item.type))).toEqual([
			"developer",
			"user",
			"assistant",
			"developer",
		]);
		expect(input[3]).toMatchObject({ content: "Later update" });
	});

	it("sends the initial snapshot as Codex instructions without duplicating it in input", async () => {
		const model: Model<"openai-codex-responses"> = {
			...openAIResponsesModel(),
			api: "openai-codex-responses",
			provider: "openai-codex",
			compat: { supportsMidConvoSystemMessages: true },
		};
		const context = normalizeContext({
			messages: [
				{ role: "developer", content: "Plan boundary", timestamp: 1 },
				{ role: "developer", content: "No edits", timestamp: 2 },
				{ role: "system", content: "", sections: { rules: "Base rules" }, timestamp: 3 },
				{ role: "user", content: "First", timestamp: 4 },
				{ role: "system", content: "Later update", timestamp: 5 },
			],
		});
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } }),
		).toString("base64");
		let payload: { instructions?: string; input?: Array<{ role?: string; content?: unknown }> } | undefined;
		await streamCodex(model, context, {
			apiKey: `aaa.${tokenPayload}.bbb`,
			onPayload: (params) => {
				payload = params as typeof payload;
				throw new Error("payload captured before network request");
			},
		}).result();
		expect(payload?.instructions).toBe("Base rules");
		expect(payload?.input?.map((item) => item.role)).toEqual(["developer", "developer", "user", "developer"]);
		expect(payload?.input?.[0]).toMatchObject({ content: [{ text: "Plan boundary" }] });
		expect(payload?.input?.[1]).toMatchObject({ content: [{ text: "No edits" }] });
		expect(payload?.input?.[3]).toMatchObject({ content: "Later update" });
		expect(JSON.stringify(payload).match(/Base rules/g)).toHaveLength(1);
	});

	it("skips blank instruction messages for OpenAI Responses", () => {
		const model = openAIResponsesModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "Implement this", timestamp: 1 },
				{ role: "developer", content: [{ type: "text", text: "   " }], timestamp: 2 },
				assistant(model.api, model.id),
			],
		};

		const input = convertResponsesMessages(model, normalizeContext(context), new Set());
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

		const input = convertResponsesMessages(model, normalizeContext(context), new Set());
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

	it("defers Anthropic instruction messages without a valid anchor until the next user turn", () => {
		const model = anthropicModel();
		const messages: Message[] = [
			{ role: "user", content: "Implement this", timestamp: 1 },
			assistant(model.api, model.id),
			{ role: "developer", content: "Too late.", timestamp: 4 },
		];

		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map((message) => message.role)).toEqual(["user", "assistant"]);

		const later = convertAnthropicMessages(
			[...messages, { role: "user", content: "Next", timestamp: 5 }, assistant(model.api, model.id)],
			model,
			false,
		);
		expect(later.map((message) => message.role)).toEqual(["user", "assistant", "user", "system", "assistant"]);
		expect(systemTexts(later)).toEqual(["Too late."]);
	});

	it("defers an Anthropic instruction between two assistant turns past the second one", () => {
		const model = anthropicModel();
		const messages: Message[] = [
			{ role: "user", content: "Implement this", timestamp: 1 },
			assistant(model.api, model.id),
			{ role: "developer", content: "Deferred.", timestamp: 2 },
			assistant(model.api, model.id),
			{ role: "user", content: "Next", timestamp: 3 },
			assistant(model.api, model.id),
		];

		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"assistant",
			"user",
			"system",
			"assistant",
		]);
	});

	it("does not place an Anthropic instruction before a user turn when the assistant between them is empty", () => {
		const model = anthropicModel();
		const messages: Message[] = [
			{ role: "user", content: "Implement this", timestamp: 1 },
			{ role: "developer", content: "Plan first.", timestamp: 2 },
			anthropicAssistant([]),
			{ role: "user", content: "Continue", timestamp: 3 },
			assistant(model.api, model.id),
		];

		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map((message) => message.role)).toEqual(["user", "user", "system", "assistant"]);
		expect(systemTexts(params)).toEqual(["Plan first."]);
	});

	it("keeps an Anthropic instruction after the user turn when the transcript ends with an empty assistant", () => {
		const model = anthropicModel();
		const messages: Message[] = [
			{ role: "user", content: "Implement this", timestamp: 1 },
			{ role: "developer", content: "Plan first.", timestamp: 2 },
			anthropicAssistant([{ type: "text", text: " " }]),
		];

		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map((message) => message.role)).toEqual(["user", "system"]);
	});

	// A session disposed mid tool batch persists the tool call without its result, then the
	// developer instructions committed by dispose, then the next user turn at relaunch.
	it("places an Anthropic instruction after the synthetic result of an orphaned tool call", () => {
		const model = anthropicModel();
		const messages: Message[] = [
			{ role: "user", content: "Implement this", timestamp: 1 },
			anthropicAssistant(
				[{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "ls" } }],
				"toolUse",
			),
			{ role: "developer", content: "Plan boundary.", timestamp: 4 },
			{ role: "user", content: "Continue", timestamp: 5 },
			assistant(model.api, model.id),
		];

		const params = convertAnthropicMessages(messages, model, false);
		const toolUseIndex = params.findIndex(
			(param) =>
				param.role === "assistant" &&
				Array.isArray(param.content) &&
				param.content.some((block) => block.type === "tool_use"),
		);
		const next = params[toolUseIndex + 1];
		expect(next?.role).toBe("user");
		expect(Array.isArray(next?.content) && next.content[0]?.type).toBe("tool_result");
		const systemIndex = params.findIndex((param) => param.role === "system");
		expect(systemIndex).toBeGreaterThan(toolUseIndex + 1);
		expect(params[systemIndex - 1]?.role).toBe("user");
		expect(params[systemIndex + 1]?.role).toBe("assistant");
		expect(systemTexts(params)).toEqual(["Plan boundary."]);
	});

	it("places native Anthropic system updates only after a user turn", () => {
		const messages: Message[] = [
			{ role: "user", content: "Implement this", timestamp: 1 },
			{ role: "system", content: "Tools changed.", timestamp: 2 },
			anthropicAssistant([]),
			{ role: "user", content: "Continue", timestamp: 3 },
			anthropicAssistant([{ type: "text", text: "Done." }]),
			{ role: "system", content: "Late update.", timestamp: 4 },
			anthropicAssistant([{ type: "text", text: "More." }]),
		];

		const params = convertAnthropicMessagesRaw(messages, false).messages;
		expect(params.map((message) => message.role)).toEqual(["user", "user", "system", "assistant", "assistant"]);
		expect(systemTexts(params)).toEqual(["Tools changed."]);
	});

	it("emits consecutive Anthropic instructions as separate system messages in transcript order", () => {
		const model = anthropicModel();
		const messages: Message[] = [
			{ role: "user", content: "Implement this", timestamp: 1 },
			{ role: "developer", content: "First.", timestamp: 2 },
			{ role: "system", content: "Native.", timestamp: 3 },
			{ role: "developer", content: "Second.", timestamp: 4 },
			assistant(model.api, model.id),
		];

		const params = convertAnthropicMessages(messages, model, false);
		expect(params.map((message) => message.role)).toEqual(["user", "system", "system", "system", "assistant"]);
		expect(systemTexts(params)).toEqual(["First.", "Native.", "Second."]);
	});

	it("keeps earlier Anthropic wire messages byte-identical as the conversation grows", () => {
		const model = anthropicModel();
		// Each request is the previous one plus the model's answer (A, T or M; E only where the
		// previous request had no trailing instruction) and new input.
		const requests: Token[][] = [
			["U", "D"],
			["U", "D", "T", "D"],
			["U", "D", "T", "D", "M", "S", "D"],
			["U", "D", "T", "D", "M", "S", "D", "A", "D"],
			["U", "D", "T", "D", "M", "S", "D", "A", "D", "A", "D", "U"],
			["U", "D", "T", "D", "M", "S", "D", "A", "D", "A", "D", "U", "A", "U"],
			["U", "D", "T", "D", "M", "S", "D", "A", "D", "A", "D", "U", "A", "U", "E", "U", "D", "D"],
			["U", "D", "T", "D", "M", "S", "D", "A", "D", "A", "D", "U", "A", "U", "E", "U", "D", "D", "T", "A"],
		];
		let previous: string[] | undefined;
		for (const tokens of requests) {
			const { messages, instructionTexts } = buildTranscript(tokens);
			const params = convertAnthropicMessages(messages, model, false);
			expectValidAnthropicSystemPlacement(params, tokens.join(""));
			expect(systemTexts(params).every((text) => instructionTexts.includes(text))).toBe(true);
			const wire = params.map((param) => JSON.stringify(param));
			if (previous) expect(wire.slice(0, previous.length), tokens.join("")).toEqual(previous);
			previous = wire;
		}
		expect(systemTexts(convertAnthropicMessages(buildTranscript(requests.at(-1)!).messages, model, false))).toEqual(
			expectedEmittedInstructions(requests.at(-1)!),
		);
	});

	it("places, defers and keeps Anthropic instructions stable for every short transcript", () => {
		const model = anthropicModel();
		const serialize = (tokens: Token[]) =>
			convertAnthropicMessages(buildTranscript(tokens).messages, model, false).map((param) => JSON.stringify(param));
		const failures: string[] = [];
		for (const tokens of allTokenSequences(4)) {
			const label = tokens.join("") || "(empty)";
			const params = convertAnthropicMessages(buildTranscript(tokens).messages, model, false);
			try {
				expectValidAnthropicSystemPlacement(params, label);
				expect(systemTexts(params), label).toEqual(expectedEmittedInstructions(tokens));
			} catch (error) {
				failures.push(error instanceof Error ? error.message.split("\n")[0] : String(error));
				continue;
			}
			// Appending a successful, non-empty response must not change what was already sent
			// (a request without any turn is rejected by the API, so it has no answer to append).
			if (params.every((param) => param.role === "system")) continue;
			const wire = params.map((param) => JSON.stringify(param));
			for (const response of ["A", "T", "M"] as const) {
				const next = serialize([...tokens, response]);
				if (JSON.stringify(next.slice(0, wire.length)) !== JSON.stringify(wire)) {
					failures.push(`${label}+${response}: earlier wire messages changed`);
				}
			}
		}
		expect(failures.slice(0, 10)).toEqual([]);
	});

	it("sends the snapshot after leading developers as the top-level prompt on first run and relaunch", async () => {
		const boundary: Message = { role: "developer", content: "Plan boundary", timestamp: 1 };
		const secondBoundary: Message = { role: "developer", content: "No edits", timestamp: 1 };
		const snapshot: Message = {
			role: "system",
			content: "",
			sections: { preamble: "You are pi.", rules: "Follow the rules." },
			timestamp: 2,
		};
		const user: Message = { role: "user", content: "First", timestamp: 3 };
		const first = await captureAnthropicPayload([boundary, secondBoundary, snapshot, user]);
		const resumedMessages = JSON.parse(
			JSON.stringify([
				boundary,
				secondBoundary,
				snapshot,
				user,
				anthropicAssistant([{ type: "text", text: "Done." }]),
				{ role: "user", content: "Continue", timestamp: 4 },
			]),
		) as Message[];
		const second = await captureAnthropicPayload(resumedMessages);
		expect(first.system).toEqual(second.system);
		expect(first.system).toEqual([
			{
				type: "text",
				text: "You are pi.\n\nFollow the rules.",
				cache_control: { type: "ephemeral" },
			},
		]);
		expect(first.messages.map((message) => message.role)).toEqual(["user", "system", "system"]);
		expect(first.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "First", cache_control: { type: "ephemeral" } }],
		});
		expect(second.messages[0]).toMatchObject({ role: "user", content: "First" });
		expect(first.messages.slice(1)).toEqual(second.messages.slice(1, 3));
		expect(first.messages.slice(1)).toEqual([
			{ role: "system", content: [{ type: "text", text: "Plan boundary" }] },
			{ role: "system", content: [{ type: "text", text: "No edits" }] },
		]);
		expect(second.messages.map((message) => message.role)).toEqual(["user", "system", "system", "assistant", "user"]);
	});

	it("keeps genuinely later snapshots as updates after a user/assistant/tool history", async () => {
		const boundary: Message = { role: "developer", content: "Plan boundary", timestamp: 1 };
		const initial: Message = { role: "system", content: "Base prompt", timestamp: 2 };
		const messages: Message[] = [
			boundary,
			initial,
			{ role: "user", content: "First", timestamp: 3 },
			anthropicAssistant([{ type: "text", text: "Done." }]),
			{
				role: "toolResult",
				toolCallId: "id",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 4,
			},
			{ role: "system", content: "Updated rule", timestamp: 5 },
		];
		const payload = await captureAnthropicPayload(messages);
		expect(payload.system).toMatchObject([{ text: "Base prompt" }]);
		expect(payload.messages.map((message) => message.role)).toEqual([
			"user",
			"system",
			"assistant",
			"user",
			"system",
		]);
		expect(payload.messages.at(-1)).toMatchObject({
			role: "system",
			content: [{ type: "text", text: "Updated rule" }],
		});
	});

	it("anchors cache control on the user before every trailing wire system update", () => {
		const messages: Message[] = [
			{ role: "user", content: "First", timestamp: 1 },
			{ role: "system", content: "Native update", timestamp: 2 },
			{ role: "developer", content: "Plan boundary", timestamp: 3 },
		];
		const params = convertAnthropicMessagesRaw(messages, false, { type: "ephemeral" }).messages;
		expect(params.map((message) => message.role)).toEqual(["user", "system", "system"]);
		expect(params[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "First", cache_control: { type: "ephemeral" } }],
		});
		for (const param of params.slice(1)) {
			expect(param.content).toEqual([{ type: "text", text: expect.any(String) }]);
		}
	});

	it("keeps cache control off trailing native tool changes", () => {
		const messages: Message[] = [
			{ role: "user", content: "First", timestamp: 1 },
			{
				role: "system",
				content: "",
				toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }],
				timestamp: 2,
			},
		];
		const params = convertAnthropicMessagesRaw(
			messages,
			false,
			{ type: "ephemeral" },
			false,
			undefined,
			true,
		).messages;
		expect(params[0]).toMatchObject({
			role: "user",
			content: [{ cache_control: { type: "ephemeral" } }],
		});
		expect(params[1]).toMatchObject({ role: "system", content: [{ type: "tool_addition" }] });
		expect(params[1].content).toEqual([{ type: "tool_addition", tool: { type: "tool_reference", name: "read" } }]);
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
