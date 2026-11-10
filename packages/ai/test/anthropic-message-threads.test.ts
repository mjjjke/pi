import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AnthropicOptions, stream } from "../src/api/anthropic-messages.ts";
import {
	CLAUDE_CODE_CCH_SEED,
	CLAUDE_CODE_VERSION,
	computeBillingVersionSuffix,
	computeClaudeCodeCch,
} from "../src/api/anthropic-oauth.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { AssistantMessage, Message, Model, Tool, ToolResultMessage } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const THREADS_BETA = "message-threads-2026-08-12";
const grammarError =
	"The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.";

interface WireMessage {
	role: string;
	content: unknown;
	output_config?: { effort?: string };
}

interface WireBody {
	model: string;
	messages: WireMessage[];
	system?: unknown;
	tools?: unknown[];
	max_tokens: number;
	thinking?: unknown;
	output_config?: unknown;
	tool_choice?: unknown;
	fallbacks?: unknown;
	thread?: { type: string; previous_message_id?: string };
}

interface CapturedRequest {
	rawBody: string;
	body: WireBody;
	betas: string[];
}

interface ReplySpec {
	id?: string;
	model?: string;
	text?: string;
	thinking?: string;
	trailingText?: string;
	toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
	stopReason?: string;
	/** Event to emit instead of finishing normally. */
	end?: "error_event" | "no_message_stop";
}

function sse(events: Array<{ type: string } & Record<string, unknown>>): Response {
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function reply(request: CapturedRequest, spec: ReplySpec = {}): Response {
	const events: Array<{ type: string } & Record<string, unknown>> = [
		{
			type: "message_start",
			message: {
				id: spec.id ?? "msg_x",
				model: spec.model ?? request.body.model,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
	];
	let index = 0;
	if (spec.thinking !== undefined) {
		events.push(
			{ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
			{ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: spec.thinking } },
			{ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } },
			{ type: "content_block_stop", index },
		);
		index++;
	}
	events.push(
		{ type: "content_block_start", index, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index, delta: { type: "text_delta", text: spec.text ?? "answer" } },
		{ type: "content_block_stop", index },
	);
	index++;
	for (const call of spec.toolCalls ?? []) {
		events.push(
			{
				type: "content_block_start",
				index,
				content_block: { type: "tool_use", id: call.id, name: call.name, input: {} },
			},
			{
				type: "content_block_delta",
				index,
				delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
			},
			{ type: "content_block_stop", index },
		);
		index++;
	}
	if (spec.trailingText !== undefined) {
		events.push(
			{ type: "content_block_start", index, content_block: { type: "text", text: spec.trailingText } },
			{ type: "content_block_stop", index },
		);
	}
	if (spec.end === "error_event") {
		return new Response(
			`${events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")}event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		);
	}
	const stopReason = spec.stopReason ?? (spec.toolCalls ? "tool_use" : "end_turn");
	events.push({ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } });
	if (spec.end !== "no_message_stop") events.push({ type: "message_stop" });
	return sse(events);
}

function errorResponse(
	status: number,
	message: string,
	errorCode?: string,
	headers?: Record<string, string>,
): Response {
	const type = status === 404 ? "not_found_error" : status === 429 ? "rate_limit_error" : "invalid_request_error";
	return Response.json(
		{ type: "error", error: { type, message, ...(errorCode ? { details: { error_code: errorCode } } : {}) } },
		{ status, headers },
	);
}

type Responder = (request: CapturedRequest) => Response;

let sessionCounter = 0;

/** The fields Anthropic requires to stay the same within a thread (observed live). */
function fingerprint({ body, betas }: CapturedRequest): string {
	const { model, thinking, output_config, tool_choice, fallbacks } = body;
	return JSON.stringify([model, thinking, output_config, tool_choice, fallbacks !== undefined, betas]);
}

/**
 * Fake Anthropic endpoint: records request bodies and beta lists, and answers from a queue or with a
 * plain reply. Like the real server, it rejects a `continue` whose fixed fields differ from the thread's.
 */
function harness() {
	const requests: CapturedRequest[] = [];
	const queue: Responder[] = [];
	const threadFingerprints = new Map<string, string>();
	const sessionId = `thread-test-${++sessionCounter}`;
	const fetch: NonNullable<AnthropicOptions["fetch"]> = async (_input, init) => {
		const body = JSON.parse(init?.body as string) as WireBody;
		const beta = new Headers(init?.headers).get("anthropic-beta");
		const request = { rawBody: init?.body as string, body, betas: beta ? beta.split(",") : [] };
		requests.push(request);
		const next = queue.shift();
		if (next) return next(request);
		const id = `msg_${requests.length}`;
		const previous = body.thread?.previous_message_id;
		const expected = previous === undefined ? fingerprint(request) : threadFingerprints.get(previous);
		if (expected !== fingerprint(request)) {
			return errorResponse(400, "fixed field changed", "thread_fingerprint_mismatch");
		}
		if (body.thread) threadFingerprints.set(id, expected);
		return reply(request, { id });
	};
	const options: AnthropicOptions = { apiKey: "test-key", fetch, sessionId, maxRetries: 0 };
	return { requests, queue, fetch, sessionId, options };
}

const baseModel: Model<"anthropic-messages"> = {
	id: "claude-test",
	name: "Test Claude",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 100,
};

function tool(name: string): Tool {
	return { name, description: `Tool ${name}`, parameters: Type.Object({ value: Type.String() }) };
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

function toolResult(id: string, name: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp: 1,
	};
}

interface TurnInput {
	model?: Model<"anthropic-messages">;
	systemPrompt?: string;
	tools?: Tool[];
	options?: AnthropicOptions;
}

async function turn(
	h: ReturnType<typeof harness>,
	messages: Message[],
	input: TurnInput = {},
): Promise<AssistantMessage> {
	const context = normalizeContext({
		systemPrompt: input.systemPrompt ?? "You are a test assistant.",
		tools: input.tools ?? [tool("lookup")],
		messages,
	});
	return stream(input.model ?? baseModel, context, { ...h.options, ...input.options }).result();
}

/** Runs one turn and appends the reply to the conversation. */
async function say(
	h: ReturnType<typeof harness>,
	messages: Message[],
	input: TurnInput = {},
): Promise<AssistantMessage> {
	const result = await turn(h, messages, input);
	messages.push(result);
	return result;
}

function threadOf(request: CapturedRequest | undefined) {
	return request?.body.thread;
}

afterEach(() => {
	cleanupSessionResources();
	vi.restoreAllMocks();
});

describe("Anthropic message threads", () => {
	it("creates a thread, then continues it with only the new messages", async () => {
		const h = harness();
		const messages = [user("first")];
		await say(h, messages);
		messages.push(user("second"));
		const result = await say(h, messages);

		expect(result.stopReason).toBe("stop");
		const [create, next] = h.requests;
		expect(create.body.thread).toEqual({ type: "create" });
		expect(create.body.system).toBeDefined();
		expect(create.body.tools).toBeDefined();
		expect(next.body.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
		expect(next.body).not.toHaveProperty("system");
		expect(next.body).not.toHaveProperty("tools");
		// The first user message had string content turned into a cached block on request 1,
		// and plain string content on request 2; the cache marker moved to the new message.
		expect(create.body.messages[0].content).toEqual([
			{ type: "text", text: "first", cache_control: { type: "ephemeral" } },
		]);
		expect(next.body.messages).toEqual([
			{ role: "user", content: [{ type: "text", text: "second", cache_control: { type: "ephemeral" } }] },
		]);
		expect(create.betas).toContain(THREADS_BETA);
		expect(next.betas).toEqual(create.betas);
	});

	it("keeps signed OAuth billing on continues, with the full post-onPayload first-user suffix", async () => {
		const h = harness();
		const firstText = "The first substantive user request after onPayload.";
		const options: AnthropicOptions = {
			apiKey: "sk-ant-oat-test",
			onPayload: (value) => {
				const params = value as { messages: WireMessage[] };
				params.messages[0].content = [
					{ type: "text", text: "System: wrapper" },
					{ type: "text", text: firstText },
				];
			},
		};
		const messages = [user("original")];
		await say(h, messages, { options });
		messages.push(user("a different delta"));
		await say(h, messages, { options });
		messages.push(user("another different delta"));
		await say(h, messages, { options });

		expect(h.requests.map((request) => request.body.thread?.type)).toEqual(["create", "continue", "continue"]);
		const suffix = await computeBillingVersionSuffix(firstText);
		expect(suffix).not.toBe(await computeBillingVersionSuffix("a different delta"));
		for (const [index, request] of h.requests.entries()) {
			const system = request.body.system as { text: string; cache_control?: unknown }[];
			expect(system).toHaveLength(index === 0 ? 2 : 1);
			expect(system[0].text).toContain(`cc_version=${CLAUDE_CODE_VERSION}.${suffix};`);
			expect(system[0].cache_control).toBeUndefined();
			if (index > 0) {
				expect(request.body).not.toHaveProperty("tools");
				expect(request.body.messages).toHaveLength(1);
			}
			const cch = system[0].text.slice(-6, -1);
			const unsigned = request.rawBody.replace(/cch=[0-9a-f]{5};/, "cch=00000;");
			expect(cch).toBe(computeClaudeCodeCch(unsigned, CLAUDE_CODE_CCH_SEED));
		}
	});

	it.each(["thread_not_found", "thread_unsupported_request"])(
		"signs OAuth continue and full resend after %s",
		async (code) => {
			const h = harness();
			const options = { apiKey: "sk-ant-oat-test" };
			const messages = [user("first user of the conversation")];
			await say(h, messages, { options });
			messages.push(user("delta"));
			h.queue.push(() => errorResponse(400, "thread rejected", code));
			expect((await say(h, messages, { options })).stopReason).toBe("stop");
			expect(h.requests.map((request) => request.body.thread?.type)).toEqual([
				"create",
				"continue",
				code === "thread_not_found" ? "create" : undefined,
			]);
			for (const request of h.requests) {
				const text = (request.body.system as { text: string }[])[0].text;
				expect(text).toContain(
					`cc_version=${CLAUDE_CODE_VERSION}.${await computeBillingVersionSuffix("first user of the conversation")};`,
				);
				expect(text.slice(-6, -1)).toBe(
					computeClaudeCodeCch(request.rawBody.replace(/cch=[0-9a-f]{5};/, "cch=00000;"), CLAUDE_CODE_CCH_SEED),
				);
			}
			expect(h.requests[2].body.messages).toHaveLength(3);
			expect(h.requests[2].body.tools).toBeDefined();
		},
	);

	it("continues OAuth with fork instruction placement and changing per-message effort over three turns", async () => {
		const h = harness();
		const model: Model<"anthropic-messages"> = {
			...baseModel,
			reasoning: true,
			capabilities: { midConversationInstructionMessages: true },
			compat: {
				supportsMidConvoSystemMessages: true,
				supportsMidConvoToolChanges: true,
				supportsMidConvoEffort: true,
			},
		};
		const messages: Message[] = [user("first")];
		const options: AnthropicOptions = { apiKey: "sk-ant-oat-test", thinkingEnabled: true, effort: "high" };
		await say(h, messages, { model, options });
		messages.push({ role: "developer", content: "queued instruction", timestamp: 2 }, user("second"));
		await say(h, messages, { model, options: { ...options, effort: "low" } });
		messages.push({ role: "system", content: "Update", toolsAdded: [tool("other")], timestamp: 3 }, user("third"));
		await say(h, messages, { model, options });
		expect(h.requests.map((request) => request.body.thread?.type)).toEqual(["create", "continue", "continue"]);
		expect(h.requests[1].body.messages.map((message) => message.output_config?.effort ?? message.role)).toEqual([
			"user",
			"system",
			"low",
		]);
		expect(h.requests[2].body.messages.map((message) => message.output_config?.effort ?? message.role)).toEqual([
			"user",
			"system",
			"high",
		]);
		expect(JSON.stringify(h.requests[1].body.messages)).toContain("queued instruction");
		expect(JSON.stringify(h.requests[2].body.messages)).toContain("tool_addition");
	});

	it("continues after fork-split assistant halves without duplicating the historical effort marker", async () => {
		const h = harness();
		const model: Model<"anthropic-messages"> = {
			...baseModel,
			reasoning: true,
			compat: { supportsMidConvoEffort: true },
		};
		const options: AnthropicOptions = { apiKey: "sk-ant-oat-test", thinkingEnabled: true, effort: "high" };
		h.queue.push((request) =>
			reply(request, {
				id: "msg_split",
				toolCalls: [{ id: "toolu_split", name: "lookup", input: {} }],
				trailingText: "text after the tool call",
			}),
		);
		// Queued responders bypass the harness's automatic thread fingerprint registration.
		h.queue.push(
			(request) => reply(request, { id: "msg_after_split" }),
			(request) => reply(request),
		);
		const messages = [user("first")];
		await say(h, messages, { model, options });
		messages.push(toolResult("toolu_split", "lookup"));
		await say(h, messages, { model, options: { ...options, effort: "low" } });
		messages.push(user("third"));
		await say(h, messages, { model, options });
		expect(h.requests.map((request) => request.body.thread?.type)).toEqual(["create", "continue", "continue"]);
		expect(h.requests[1].body.messages.map((message) => message.output_config?.effort ?? message.role)).toEqual([
			"user",
			"low",
		]);
	});

	it("fails open with the untrimmed OAuth body when suffix preparation fails", async () => {
		const h = harness();
		const options: AnthropicOptions = { apiKey: "sk-ant-oat-test" };
		const messages = [user("conversation head")];
		await say(h, messages, { options });
		messages.push(user("delta"));
		vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("signing unavailable"));
		expect((await say(h, messages, { options })).stopReason).toBe("stop");
		const request = h.requests[1];
		expect(request.body).not.toHaveProperty("thread");
		expect(request.body.messages).toHaveLength(3);
		expect((request.body.system as { text: string }[])[0].text).toBe(
			`x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.000; cc_entrypoint=cli; cch=00000;`,
		);
	});

	it("signs each OAuth continue retry from reusable placeholders", async () => {
		const h = harness();
		const options: AnthropicOptions = { apiKey: "sk-ant-oat-test", maxRetries: 1 };
		const messages = [user("conversation head")];
		await say(h, messages, { options });
		messages.push(user("new delta"));
		h.queue.push(() => errorResponse(503, "overloaded", undefined, { "retry-after-ms": "0" }));
		let reusable = "";
		expect(
			(
				await say(h, messages, {
					options: {
						...options,
						onPayload: (params) => {
							reusable = JSON.stringify(params);
						},
					},
				})
			).stopReason,
		).toBe("stop");
		expect(h.requests[1].body.thread?.type).toBe("continue");
		expect(h.requests[1].rawBody).toBe(h.requests[2].rawBody);
		expect(reusable).toContain(`cc_version=${CLAUDE_CODE_VERSION}.000;`);
		expect(reusable).toContain("cch=00000;");
		const text = (h.requests[1].body.system as { text: string }[])[0].text;
		expect(text.slice(-6, -1)).toBe(
			computeClaudeCodeCch(h.requests[1].rawBody.replace(/cch=[0-9a-f]{5};/, "cch=00000;"), CLAUDE_CODE_CCH_SEED),
		);
	});

	it("creates a new OAuth thread with a new suffix after compaction replaces the first user", async () => {
		const h = harness();
		const options = { apiKey: "sk-ant-oat-test" };
		const messages = [user("old first user")];
		await say(h, messages, { options });
		messages.splice(0, 1, user("compacted conversation summary"));
		messages.push(user("new question"));
		await say(h, messages, { options });
		expect(h.requests[1].body.thread?.type).toBe("create");
		const before = (h.requests[0].body.system as { text: string }[])[0].text;
		const after = (h.requests[1].body.system as { text: string }[])[0].text;
		const suffix = await computeBillingVersionSuffix("compacted conversation summary");
		expect(suffix).not.toBe(await computeBillingVersionSuffix("old first user"));
		expect(after).toContain(`cc_version=${CLAUDE_CODE_VERSION}.${suffix};`);
		expect(before.split("; cch=")[0]).not.toBe(after.split("; cch=")[0]);
	});

	it("creates a new OAuth thread when the billing version changes", async () => {
		const h = harness();
		const messages = [user("first")];
		await say(h, messages, { options: { apiKey: "sk-ant-oat-test" } });
		messages.push(user("second"));
		await say(h, messages, {
			options: { apiKey: "sk-ant-oat-test", env: { PI_ANTHROPIC_CLAUDE_CODE_VERSION: "9.9.9" } },
		});
		expect(h.requests[1].body.thread?.type).toBe("create");
	});

	it("continues after a reply that ends in tool calls, without placeholder results in the prefix", async () => {
		const h = harness();
		h.queue.push((request) =>
			reply(request, { id: "msg_tool", toolCalls: [{ id: "toolu_1", name: "lookup", input: { value: "x" } }] }),
		);
		const messages = [user("look it up")];
		const first = await say(h, messages);
		expect(first.stopReason).toBe("toolUse");
		messages.push(toolResult("toolu_1", "lookup"));
		await say(h, messages);

		const next = h.requests[1];
		expect(next.body.thread).toEqual({ type: "continue", previous_message_id: "msg_tool" });
		expect(next.body.messages).toHaveLength(1);
		expect(next.body.messages[0]).toMatchObject({
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "toolu_1" }],
		});
	});

	it("continues when the effort level changes between turns", async () => {
		const model: Model<"anthropic-messages"> = {
			...baseModel,
			reasoning: true,
			compat: { forceAdaptiveThinking: true, supportsMidConvoEffort: true },
		};
		const h = harness();
		h.queue.push((request) => reply(request, { id: "msg_a", thinking: "thought" }));
		const messages = [user("first")];
		await say(h, messages, { model, options: { thinkingEnabled: true, effort: "high" } });
		messages.push(user("second"));
		await say(h, messages, { model, options: { thinkingEnabled: true, effort: "low" } });

		expect(h.requests[0].body.messages.map((message) => message.output_config?.effort ?? message.role)).toEqual([
			"user",
			"high",
		]);
		const next = h.requests[1];
		expect(next.body.thread).toEqual({ type: "continue", previous_message_id: "msg_a" });
		expect(next.body.messages.map((message) => message.output_config?.effort ?? message.role)).toEqual([
			"user",
			"low",
		]);
	});

	it("continues when a system message with a native tool change follows the reply", async () => {
		const model: Model<"anthropic-messages"> = {
			...baseModel,
			compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
		};
		const h = harness();
		const messages: Message[] = [user("first")];
		await say(h, messages, { model });
		messages.push({ role: "system", content: "Update", toolsAdded: [tool("other")], timestamp: 2 }, user("second"));
		await say(h, messages, { model });

		const next = h.requests[1];
		expect(next.body.thread?.type).toBe("continue");
		expect(next.body.messages.map((message) => message.role)).toEqual(["user", "system"]);
		expect(JSON.stringify(next.body.messages[1].content)).toContain("tool_addition");
	});

	it.each<[string, TurnInput, TurnInput]>([
		["system prompt", {}, { systemPrompt: "Different prompt." }],
		["tools", {}, { tools: [tool("lookup"), tool("other")] }],
		["model", {}, { model: { ...baseModel, id: "claude-other" } }],
		["tool choice", {}, { options: { toolChoice: "any" } }],
		["cache retention", {}, { options: { cacheRetention: "long" } }],
		[
			"thinking level",
			{ model: { ...baseModel, reasoning: true }, options: { thinkingEnabled: true, thinkingBudgetTokens: 1024 } },
			{ model: { ...baseModel, reasoning: true }, options: { thinkingEnabled: true, thinkingBudgetTokens: 2048 } },
		],
	])("creates a new thread when the %s changes", async (_name, before, after) => {
		const h = harness();
		const messages = [user("first")];
		await say(h, messages, before);
		messages.push(user("second"));
		await say(h, messages, after);
		expect(threadOf(h.requests[1])).toEqual({ type: "create" });
		expect(h.requests[1].body.messages).toHaveLength(3);
	});

	it("creates a new thread when the request has no messages beyond the stored prefix", async () => {
		const h = harness();
		const messages = [user("first")];
		await say(h, messages);
		await turn(h, messages);
		expect(threadOf(h.requests[1])).toEqual({ type: "create" });
	});

	it.each([
		["thread_not_found", 404],
		["thread_already_continued", 400],
		["thread_continue_in_flight", 400],
		["thread_fingerprint_mismatch", 400],
	])("starts a new thread with the full request after %s", async (errorCode, status) => {
		const h = harness();
		const messages = [user("first")];
		await say(h, messages);
		messages.push(user("second"));
		h.queue.push(() => errorResponse(status, "thread rejected", errorCode));
		const onPayload = vi.fn();
		const result = await say(h, messages, { options: { onPayload } });

		expect(result.stopReason).toBe("stop");
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(h.requests).toHaveLength(3);
		const [, rejected, resend] = h.requests;
		expect(rejected.body.thread?.type).toBe("continue");
		expect(resend.body.thread).toEqual({ type: "create" });
		expect(resend.body.messages).toHaveLength(3);
		expect(resend.body.system).toBeDefined();
		expect(resend.betas).toEqual(rejected.betas);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics![0]).toMatchObject({
			type: "anthropic_thread_fallback",
			details: { reason: errorCode },
		});

		messages.push(user("third"));
		await say(h, messages);
		expect(threadOf(h.requests[3])).toEqual({ type: "continue", previous_message_id: "msg_3" });
	});

	it.each([
		["thread_unsupported_request", "thread_unsupported_request", "rejected"],
		["a 400 without error code about the thread field", undefined, "thread: Extra inputs are not permitted"],
	])("turns threads off for the session after %s on continue", async (_name, errorCode, message) => {
		const h = harness();
		const messages = [user("first")];
		await say(h, messages);
		messages.push(user("second"));
		h.queue.push(() => errorResponse(400, message, errorCode));
		const result = await say(h, messages);

		expect(result.stopReason).toBe("stop");
		expect(result.diagnostics?.[0]).toMatchObject({
			type: "anthropic_thread_fallback",
			details: { reason: errorCode ?? "400" },
		});
		messages.push(user("third"));
		await say(h, messages);
		const later = h.requests[3];
		expect(later.body).not.toHaveProperty("thread");
		// The resend was accepted with the threads beta, so the beta list stays the same.
		expect(later.betas).toEqual(h.requests[0].betas);
	});

	it("shows the error when the resend fails too and keeps threads on", async () => {
		const h = harness();
		const messages = [user("first")];
		await say(h, messages);
		messages.push(user("second"));
		h.queue.push(
			() => errorResponse(400, "thread: Extra inputs are not permitted"),
			() => errorResponse(400, "Real problem"),
		);
		const failed = await turn(h, messages);
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toContain("Real problem");
		expect(h.requests).toHaveLength(3);

		await turn(h, messages);
		expect(threadOf(h.requests[3])).toEqual({ type: "create" });
	});

	it.each([
		[400, "prompt is too long: 250000 tokens > 200000 maximum"],
		[404, "model: claude-test"],
	])("passes a %s that is not about the thread on without resending", async (status, message) => {
		const h = harness();
		const messages = [user("first")];
		await say(h, messages);
		messages.push(user("second"));
		h.queue.push(() => errorResponse(status, message));
		const failed = await turn(h, messages);
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toContain(message);
		expect(h.requests).toHaveLength(2);
		expect(failed.diagnostics).toBeUndefined();

		// Threads stay on: after a fix such as compaction, the next request starts a new thread.
		await turn(h, messages);
		expect(threadOf(h.requests[2])).toEqual({ type: "create" });
	});

	it("leaves strict tool rejections to the strict tool fallback", async () => {
		const model: Model<"anthropic-messages"> = { ...baseModel, compat: { supportsStrictTools: true } };
		const strictTool: Tool = { ...tool("lookup"), constrainedSampling: { type: "json_schema", strict: "prefer" } };
		const h = harness();
		h.queue.push(() => errorResponse(400, grammarError));
		const result = await turn(h, [user("first")], { model, tools: [strictTool] });
		expect(result.stopReason).toBe("stop");
		expect(h.requests).toHaveLength(2);
		expect(h.requests.map((request) => threadOf(request)?.type)).toEqual(["create", "create"]);
		expect(result.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual(["anthropic_strict_tools_fallback"]);
	});

	it("starts a new thread when a retried continue finds the thread in flight", async () => {
		const h = harness();
		const messages = [user("first")];
		await say(h, messages);
		messages.push(user("second"));
		h.queue.push(
			() => errorResponse(503, "overloaded", undefined, { "retry-after-ms": "0" }),
			() => errorResponse(400, "in flight", "thread_continue_in_flight"),
		);
		const result = await say(h, messages, { options: { maxRetries: 1 } });
		expect(result.stopReason).toBe("stop");
		expect(h.requests.map((request) => threadOf(request)?.type)).toEqual([
			"create",
			"continue",
			"continue",
			"create",
		]);
	});

	it.each<[string, string | null]>([
		["without the threads beta", "fine-grained-tool-streaming-2025-05-14"],
		["set to null", null],
	])("fails once, then turns threads off, with an explicit anthropic-beta header %s", async (_name, header) => {
		const h = harness();
		const respond: Responder = (request) =>
			request.body.thread && !request.betas.includes(THREADS_BETA)
				? errorResponse(400, "thread: Extra inputs are not permitted")
				: reply(request, { id: `msg_${h.requests.length}` });
		h.queue.push(respond, respond, respond);
		const options: AnthropicOptions = { headers: { "anthropic-beta": header } };
		const messages = [user("first")];
		const result = await say(h, messages, { options });
		expect(result.stopReason).toBe("stop");
		messages.push(user("second"));
		await say(h, messages, { options });
		expect(h.requests.map((request) => threadOf(request)?.type)).toEqual(["create", undefined, undefined]);
	});

	it.each<[string, ReplySpec | "abort"]>([
		["an aborted reply", "abort"],
		["a stream error", { end: "error_event" }],
		["a stream that ends early", { end: "no_message_stop" }],
		["a refusal", { stopReason: "refusal" }],
		["a fallback model reply", { model: "claude-fallback" }],
	])("does not record %s", async (_name, spec) => {
		const h = harness();
		const controller = new AbortController();
		if (spec !== "abort") h.queue.push((request) => reply(request, { id: "msg_bad", ...spec }));
		const messages = [user("first")];
		const first = await turn(h, messages, {
			options:
				spec === "abort"
					? {
							signal: controller.signal,
							onProviderStreamEvent: (event) => {
								if ((event as { type: string }).type === "message_start") controller.abort();
							},
						}
					: {},
		});
		messages.push(first, user("second"));
		await turn(h, messages);
		expect(threadOf(h.requests[1])).toEqual({ type: "create" });
	});

	it("does not use threads with cacheRetention none", async () => {
		const h = harness();
		const messages = [user("first")];
		await say(h, messages, { options: { cacheRetention: "none" } });
		expect(h.requests[0].body).not.toHaveProperty("thread");
		expect(h.requests[0].betas).not.toContain(THREADS_BETA);
	});

	it("matches Claude Code tool names across turns with OAuth", async () => {
		const h = harness();
		h.queue.push((request) =>
			reply(request, { id: "msg_oauth", toolCalls: [{ id: "toolu_1", name: "Read", input: { value: "x" } }] }),
		);
		const options: AnthropicOptions = { apiKey: "sk-ant-oat-test" };
		const messages = [user("read it")];
		const first = await say(h, messages, { tools: [tool("read")], options });
		expect(first.content.find((block) => block.type === "toolCall")).toMatchObject({ name: "read" });
		messages.push(toolResult("toolu_1", "read"));
		await say(h, messages, { tools: [tool("read")], options });
		expect(threadOf(h.requests[1])).toEqual({ type: "continue", previous_message_id: "msg_oauth" });
	});

	it("sends cache warming replays without a thread and keeps the conversation's thread", async () => {
		const h = harness();
		const messages = [user("first")];
		await say(h, messages);
		await turn(h, messages.slice(0, 1), { options: { maxTokens: 1, disableContinuation: true } });
		messages.push(user("second"));
		await say(h, messages);

		const [real, warm, next] = h.requests;
		expect(warm.body).not.toHaveProperty("thread");
		expect(warm.body.max_tokens).toBe(1);
		expect(warm.body.messages).toEqual(real.body.messages);
		expect(warm.betas).toEqual(real.betas);
		expect(next.body.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
	});
});

describe("Anthropic message thread prefix hash", () => {
	// Tool inputs are tool data: `content` and `cache_control` keys there are not wire-protocol
	// positions, so changing them must start a new thread instead of continuing without the change.
	it.each(["cache_control", "content", "value"])(
		"starts a new thread when tool input field %s changes",
		async (field) => {
			const h = harness();
			h.queue.push((request) =>
				reply(request, {
					id: "msg_tool",
					toolCalls: [{ id: "toolu_1", name: "lookup", input: { [field]: "old value" } }],
				}),
			);
			h.queue.push((request) => reply(request));
			const messages: Message[] = [user("first")];
			const result = await say(h, messages, { options: { apiKey: "sk-ant-oat-test" } });
			const call = result.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing tool call");
			call.arguments[field] = field === "content" ? [{ type: "text", text: "old value" }] : "new value";
			messages.push(toolResult("toolu_1", "lookup"));
			await say(h, messages, { options: { apiKey: "sk-ant-oat-test" } });
			expect(h.requests[1].body.thread?.type).toBe("create");
		},
	);

	it("continues when an unchanged tool input is replayed", async () => {
		const h = harness();
		h.queue.push((request) =>
			reply(request, {
				id: "msg_tool",
				toolCalls: [{ id: "toolu_1", name: "lookup", input: { content: "x", cache_control: "y" } }],
			}),
		);
		h.queue.push((request) => reply(request));
		const messages: Message[] = [user("first")];
		await say(h, messages, { options: { apiKey: "sk-ant-oat-test" } });
		messages.push(toolResult("toolu_1", "lookup"));
		await say(h, messages, { options: { apiKey: "sk-ant-oat-test" } });
		expect(h.requests[1].body.thread).toEqual({ type: "continue", previous_message_id: "msg_tool" });
	});
});
