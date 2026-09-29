import { describe, expect, it } from "vitest";
import { getGeneratedCapabilities } from "../scripts/fork-model-capabilities.ts";
import { convertMessages, stream, streamSimple } from "../src/api/anthropic-messages.ts";
import { transformMessages } from "../src/api/transform-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import {
	anthropicSupportsProgressUpdates,
	supportsProgressUpdates,
	THINKING_DISPLAY_UPDATES_BETA,
} from "../src/providers/progress-updates.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

// https://platform.claude.com/docs/en/build-with-claude/thinking#progress-updates-between-tool-calls

function anthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { forceAdaptiveThinking: true },
		capabilities: { progressUpdates: true },
		...overrides,
	};
}

const user = (text: string, timestamp = 1) => ({ role: "user" as const, content: text, timestamp });

interface Captured {
	thinking?: { type: string; display?: string };
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options: Parameters<typeof stream>[2] = {},
): Promise<{ payload: Captured; beta: string | null }> {
	let payload: Captured | undefined;
	let beta: string | null = null;
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = input instanceof Request ? input : new Request(input, init);
		beta = request.headers.get("anthropic-beta");
		payload = JSON.parse(await request.text()) as Captured;
		return sseResponse(doneEvents());
	};
	await stream(model, normalizeContext({ messages: [user("hi")] }), {
		apiKey: "test-key",
		cacheRetention: "none",
		thinkingEnabled: true,
		fetch: fetchImpl,
		...options,
	}).result();
	if (!payload) throw new Error("Expected payload capture");
	return { payload, beta };
}

function doneEvents(stopReason = "end_turn"): object[] {
	return [
		{
			type: "message_start",
			message: { id: "msg_test", model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 0 } },
		},
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { input_tokens: 1, output_tokens: 1 } },
		{ type: "message_stop" },
	];
}

function sseResponse(events: object[]): Response {
	const body = events
		.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function thinkingBlockEvents(index: number, text: string, signature: string): object[] {
	return [
		{ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
		{ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } },
		{ type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
		{ type: "content_block_stop", index },
	];
}

function toolTurnEvents(reasoning: string, update: string): object[] {
	const [start, , stop] = doneEvents("tool_use");
	return [
		start,
		...thinkingBlockEvents(0, reasoning, "sig-reasoning"),
		...thinkingBlockEvents(1, update, "sig-update"),
		{
			type: "content_block_start",
			index: 2,
			content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
		},
		{ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } },
		{ type: "content_block_stop", index: 2 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 1, output_tokens: 1 } },
		stop,
	];
}

async function parseToolTurn(
	display: "updates" | "summarized",
	reasoning: string,
	update: string,
): Promise<AssistantMessage> {
	return stream(anthropicModel(), normalizeContext({ messages: [user("hi")] }), {
		apiKey: "test-key",
		cacheRetention: "none",
		thinkingEnabled: true,
		thinkingDisplay: display,
		fetch: async () => sseResponse(toolTurnEvents(reasoning, update)),
	}).result();
}

function assistantMessage(model: Model<"anthropic-messages">, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

describe("Anthropic progress updates capability", () => {
	it("gates progress updates to the documented models", () => {
		for (const id of [
			"claude-fable-5-1",
			"claude-fable-5.1",
			"claude-mythos-5-1",
			"claude-opus-5-5",
			"claude-opus-5.5",
			"claude-sonnet-5-5",
			"claude-fable-5",
			"claude-fable-5-20260101",
			"claude-opus-5-5-20260101",
		]) {
			expect(anthropicSupportsProgressUpdates(id), id).toBe(true);
		}
		for (const id of [
			"claude-opus-5",
			"claude-sonnet-5",
			"claude-mythos-5",
			"claude-opus-4-8",
			"claude-opus-5-1",
			"claude-fable-5-10",
			"claude-haiku-4-5",
			undefined,
		]) {
			expect(anthropicSupportsProgressUpdates(id), String(id)).toBe(false);
		}
	});

	it("adds the capability for first-party Anthropic models only", () => {
		const base = anthropicModel({ capabilities: undefined });
		expect(getGeneratedCapabilities(base)?.progressUpdates).toBe(true);
		expect(getGeneratedCapabilities({ ...base, id: "claude-opus-5" })?.progressUpdates).toBeUndefined();
		expect(
			getGeneratedCapabilities({ ...base, provider: "openrouter", id: "anthropic/claude-opus-5.5" })
				?.progressUpdates,
		).toBeUndefined();
	});

	it("marks pinned built-in models", () => {
		expect(supportsProgressUpdates(getModel("anthropic", "claude-opus-5-5"))).toBe(true);
		expect(supportsProgressUpdates(getModel("anthropic", "claude-fable-5-1"))).toBe(true);
		expect(supportsProgressUpdates(getModel("anthropic", "claude-opus-5"))).toBe(false);
	});
});

describe("Anthropic thinking display updates", () => {
	it("sends display updates with the beta header on capable models", async () => {
		const { payload, beta } = await capturePayload(anthropicModel(), { thinkingDisplay: "updates" });
		expect(payload.thinking).toEqual({ type: "adaptive", display: "updates" });
		expect(beta?.split(",")).toContain(THINKING_DISPLAY_UPDATES_BETA);
	});

	it("sends display updates on managed-effort models", async () => {
		const model = anthropicModel({ compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true } });
		const { payload, beta } = await capturePayload(model, { thinkingDisplay: "updates" });
		expect(payload.thinking?.display).toBe("updates");
		expect(beta?.split(",")).toContain(THINKING_DISPLAY_UPDATES_BETA);
	});

	it("falls back to summarized for models without progress updates", async () => {
		const { payload, beta } = await capturePayload(anthropicModel({ id: "claude-opus-5", capabilities: undefined }), {
			thinkingDisplay: "updates",
		});
		expect(payload.thinking?.display).toBe("summarized");
		expect(beta ?? "").not.toContain(THINKING_DISPLAY_UPDATES_BETA);
	});

	it("falls back to summarized when a configured beta header omits the updates beta", async () => {
		const { payload } = await capturePayload(anthropicModel({ headers: { "anthropic-beta": "some-beta" } }), {
			thinkingDisplay: "updates",
		});
		expect(payload.thinking?.display).toBe("summarized");
	});

	it("keeps summarized as the library default", async () => {
		const { payload, beta } = await capturePayload(anthropicModel());
		expect(payload.thinking?.display).toBe("summarized");
		expect(beta ?? "").not.toContain(THINKING_DISPLAY_UPDATES_BETA);
	});

	it("forwards thinkingDisplay from streamSimple", async () => {
		let payload: Captured | undefined;
		await streamSimple(anthropicModel(), normalizeContext({ messages: [user("hi")] }), {
			apiKey: "test-key",
			cacheRetention: "none",
			reasoning: "high",
			thinkingDisplay: "updates",
			onPayload: (value) => {
				payload = value as Captured;
				throw new Error("captured");
			},
		}).result();
		expect(payload?.thinking?.display).toBe("updates");
	});
});

describe("Anthropic progress update parsing and replay", () => {
	it("marks non-empty thinking blocks as progress updates under display updates", async () => {
		const message = await parseToolTurn("updates", "", "Found the bug. Reading a next.");
		expect(message.content[0]).toEqual({ type: "thinking", thinking: "", thinkingSignature: "sig-reasoning" });
		expect(message.content[1]).toEqual({
			type: "thinking",
			thinking: "Found the bug. Reading a next.",
			thinkingSignature: "sig-update",
			progressUpdate: true,
		});
		expect(message.content[2]).toMatchObject({ type: "toolCall", name: "read" });
	});

	it("does not mark thinking blocks under display summarized", async () => {
		const message = await parseToolTurn("summarized", "Reasoning summary.", "Update summary.");
		expect(message.content.filter((block) => block.type === "thinking" && block.progressUpdate)).toEqual([]);
	});

	it("replays empty signed reasoning and progress updates as thinking blocks without the marker", () => {
		const model = anthropicModel();
		const assistant = assistantMessage(model, [
			{ type: "thinking", thinking: "", thinkingSignature: "sig-reasoning" },
			{ type: "thinking", thinking: "Update.", thinkingSignature: "sig-update", progressUpdate: true },
			{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } },
		]);
		const { messages } = convertMessages([user("hi"), assistant], false);
		expect(messages[1]).toEqual({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "", signature: "sig-reasoning" },
				{ type: "thinking", thinking: "Update.", signature: "sig-update" },
				{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "a" } },
			],
		});
	});

	it("drops empty reasoning and converts progress updates to plain text across models", () => {
		const source = anthropicModel();
		const target = anthropicModel({ id: "claude-opus-5", capabilities: undefined });
		const context: Context = {
			messages: [
				user("hi"),
				assistantMessage(source, [
					{ type: "thinking", thinking: "", thinkingSignature: "sig-reasoning" },
					{ type: "thinking", thinking: "Update.", thinkingSignature: "sig-update", progressUpdate: true },
				]),
			],
		};
		const transformed = transformMessages(context.messages, target);
		expect((transformed[1] as AssistantMessage).content).toEqual([{ type: "text", text: "Update." }]);
	});
});
