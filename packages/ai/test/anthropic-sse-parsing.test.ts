import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context, ToolCall } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const minimalAnthropicEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	},
	{
		event: "content_block_start",
		data: JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		}),
	},
	{
		event: "content_block_stop",
		data: JSON.stringify({ type: "content_block_stop", index: 0 }),
	},
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	},
	{
		event: "message_stop",
		data: JSON.stringify({ type: "message_stop" }),
	},
];

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

function createRoutingFakeAnthropicClient(response: Response) {
	const messagesCreate = vi.fn((_params: unknown, _options?: { headers?: Record<string, string> }) => ({
		asResponse: async () => response,
	}));
	const betaMessagesCreate = vi.fn((_params: unknown, _options?: { headers?: Record<string, string> }) => ({
		asResponse: async () => response,
	}));

	return {
		client: {
			messages: { create: messagesCreate },
			beta: { messages: { create: betaMessagesCreate } },
		} as unknown as Anthropic,
		messagesCreate,
		betaMessagesCreate,
	};
}

describe("Anthropic raw SSE parsing", () => {
	it("routes fast speed payloads through beta messages", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const context: Context = {
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const { client, messagesCreate, betaMessagesCreate } = createRoutingFakeAnthropicClient(
			createSseResponse(minimalAnthropicEvents),
		);

		const stream = streamAnthropic(model, context, {
			client,
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				speed: "fast",
			}),
		});
		const result = await stream.result();

		expect(result.errorMessage).toBeUndefined();
		expect(messagesCreate).not.toHaveBeenCalled();
		expect(betaMessagesCreate).toHaveBeenCalledOnce();
		expect(betaMessagesCreate.mock.calls[0]?.[0]).toMatchObject({ speed: "fast", stream: true });
		expect(betaMessagesCreate.mock.calls[0]?.[1]?.headers?.["anthropic-beta"]).toBe("fast-mode-2026-02-01");
	});

	it("includes Claude Code OAuth and fast mode beta headers on OAuth fast speed payloads", async () => {
		let capturedBetaHeader: string | string[] | undefined;
		const server = createServer((request, response) => {
			capturedBetaHeader = request.headers["anthropic-beta"];
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(minimalAnthropicEvents.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n"));
		});

		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		try {
			const baseModel = getModel("anthropic", "claude-opus-4-8");
			const model = { ...baseModel, baseUrl: `http://127.0.0.1:${address.port}` };
			const context: Context = {
				messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
			};

			const stream = streamAnthropic(model, context, {
				apiKey: "sk-ant-oat-test",
				cacheRetention: "none",
				onPayload: (payload) => ({
					...(payload as Record<string, unknown>),
					speed: "fast",
				}),
			});
			const result = await stream.result();

			expect(result.errorMessage).toBeUndefined();
		} finally {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}

		const betaHeader = Array.isArray(capturedBetaHeader) ? capturedBetaHeader.join(",") : capturedBetaHeader;
		expect(betaHeader?.split(",")).toEqual(["claude-code-20250219", "oauth-2025-04-20", "fast-mode-2026-02-01"]);
	});

	it("preserves existing Anthropic beta headers on fast speed payloads", async () => {
		const baseModel = getModel("anthropic", "claude-opus-4-8");
		const model = {
			...baseModel,
			headers: { "anthropic-beta": "model-beta" },
			compat: { ...baseModel.compat, supportsEagerToolInputStreaming: false },
		};
		const context: Context = {
			messages: [{ role: "user", content: "Use the edit tool.", timestamp: Date.now() }],
			tools: [
				{
					name: "edit",
					description: "Edit a file.",
					parameters: Type.Object({ path: Type.String() }),
				},
			],
		};
		const { client, betaMessagesCreate } = createRoutingFakeAnthropicClient(
			createSseResponse(minimalAnthropicEvents),
		);

		const stream = streamAnthropic(model, context, {
			client,
			headers: { "anthropic-beta": "option-beta" },
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				speed: "fast",
			}),
		});
		const result = await stream.result();

		expect(result.errorMessage).toBeUndefined();
		const betaHeader = betaMessagesCreate.mock.calls[0]?.[1]?.headers?.["anthropic-beta"];
		expect(betaHeader?.split(",")).toEqual([
			"fast-mode-2026-02-01",
			"fine-grained-tool-streaming-2025-05-14",
			"model-beta",
			"option-beta",
		]);
	});

	it("routes normal payloads through stable messages", async () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const context: Context = {
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const { client, messagesCreate, betaMessagesCreate } = createRoutingFakeAnthropicClient(
			createSseResponse(minimalAnthropicEvents),
		);

		const stream = streamAnthropic(model, context, { client });
		const result = await stream.result();

		expect(result.errorMessage).toBeUndefined();
		expect(messagesCreate).toHaveBeenCalledOnce();
		expect(betaMessagesCreate).not.toHaveBeenCalled();
		expect(messagesCreate.mock.calls[0]?.[0]).toMatchObject({ stream: true });
		expect(messagesCreate.mock.calls[0]?.[0]).not.toHaveProperty("speed");
	});

	it("repairs malformed SSE JSON and malformed streamed tool JSON", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Use the edit tool.", timestamp: Date.now() }],
			tools: [
				{
					name: "edit",
					description: "Edit a file.",
					parameters: Type.Object({
						path: Type.String(),
						text: Type.String(),
					}),
				},
			],
		};

		const malformedToolJsonDelta = String.raw`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"A\H\",\"text\":\"col1	col2\"}"}}`;

		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_test",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "toolu_test",
						name: "edit",
						input: {},
					},
				}),
			},
			{ event: "content_block_delta", data: malformedToolJsonDelta },
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();

		const toolCall = result.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.arguments).toEqual({
			path: "A\\H",
			text: "col1\tcol2",
		});
	});

	it("preserves refusal stop details from message_delta", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const context: Context = {
			messages: [{ role: "user", content: "blocked request", timestamp: Date.now() }],
		};
		const explanation =
			"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, provide feedback, or request an exemption based on how you use Claude, visit our help center: https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude.";
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_01XFUDYJgAACzvnptvVoYEL",
						usage: {
							input_tokens: 412,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: {
						stop_reason: "refusal",
						stop_details: {
							type: "refusal",
							category: "cyber",
							explanation,
						},
					},
					usage: {
						input_tokens: 412,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(explanation);
	});

	it("ignores unknown SSE events after message_stop", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const response = createSseResponse([
			...minimalAnthropicEvents,
			{ event: "done", data: "[DONE]" },
			{ event: "proxy.stats", data: "not json" },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});
});
