import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact, type SessionSummaryRequest } from "../src/core/compaction/compaction.ts";

const model: Model<"anthropic-messages"> = {
	id: "test",
	name: "test",
	api: "anthropic-messages",
	provider: "test",
	baseUrl: "https://invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
};
function reply(
	text = "## Goal\nSummary\n## Next Steps\nContinue",
	stopReason: AssistantMessage["stopReason"] = "stop",
	content?: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		stopReason,
		content: content ?? [{ type: "text", text }],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 100,
			cacheWrite: 2,
			totalTokens: 117,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		},
	};
}
const kept = { role: "user", content: "Keep this next request", timestamp: 1 } as const;
const context: Context = {
	messages: [
		{
			role: "system",
			content: "original system",
			toolsAdded: [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }],
			timestamp: 0,
		},
		{ role: "user", content: "earlier history", timestamp: 1 },
		kept,
	],
};
function preparation(split = false, previousSummary?: string): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: [{ role: "user", content: "history", timestamp: 0 }],
		turnPrefixMessages: split ? [{ role: "user", content: "request", timestamp: 0 }] : [],
		isSplitTurn: split,
		previousSummary,
		tokensBefore: 1000,
		fileOps: { read: new Set(["a.ts"]), written: new Set(["b.ts"]), edited: new Set() },
		settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 10 },
	};
}
function fixture(
	responses: Array<AssistantMessage | Error> = [reply()],
	options: SimpleStreamOptions = {},
	onCall?: () => void,
) {
	const calls: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
	const stream: StreamFn = (_model, ctx, opts) => {
		calls.push({ context: structuredClone(ctx), options: opts });
		onCall?.();
		const response = responses.shift() ?? reply("serialized");
		if (response instanceof Error) throw response;
		const result = createAssistantMessageEventStream();
		result.end(response);
		return result;
	};
	const request: SessionSummaryRequest = { context, keptStart: kept, options };
	const callbacks = { onRetryScheduled: vi.fn(), onRetryAttemptStart: vi.fn(), onRetryFinished: vi.fn() };
	const onUsage = vi.fn();
	return {
		calls,
		callbacks,
		onUsage,
		run: (prep = preparation(), signal?: AbortSignal) =>
			compact(
				prep,
				model,
				"key",
				{ test: "header" },
				"focus",
				signal,
				"medium",
				stream,
				undefined,
				{ enabled: true, maxRetries: 1, baseDelayMs: 1 },
				callbacks,
				undefined,
				onUsage,
				request,
			),
	};
}

describe("compact session request", () => {
	it("copies the supplied context plus exactly one user message and keeps C2 options", async () => {
		const onPayload = vi.fn();
		const options: SimpleStreamOptions = {
			reasoning: "medium",
			sessionId: "session",
			onPayload,
			transport: "sse",
			thinkingBudgets: { medium: 1234 },
			maxRetryDelayMs: 321,
			disableContinuation: true,
		};
		const f = fixture(undefined, options);
		const before = structuredClone(context);
		const result = await f.run();
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0].context.messages.slice(0, -1)).toEqual(before.messages);
		expect(context).toEqual(before);
		expect(f.calls[0].context.messages.at(-1)).toMatchObject({
			role: "user",
			content: [{ type: "text", text: expect.stringContaining("Additional focus: focus") }],
		});
		expect(f.calls[0].options).toMatchObject({
			...options,
			apiKey: "key",
			headers: { test: "header" },
			disableContinuation: true,
		});
		expect(f.calls[0].options).not.toHaveProperty("cacheRetention");
		expect(result.usage).toEqual(reply().usage);
	});
	it("uses one request for a split turn and retains file lists without the split block", async () => {
		const f = fixture();
		const result = await f.run(preparation(true));
		expect(f.calls).toHaveLength(1);
		expect(JSON.stringify(f.calls[0].context)).toContain("in the middle of a turn");
		expect(result.summary).not.toContain("Turn Context (split turn)");
		expect(result.summary).toContain("a.ts");
		expect(result.summary).toContain("b.ts");
		expect(result.details).toEqual({ readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
	});
	it("regenerates an update even with empty history", async () => {
		const f = fixture();
		const prep = preparation(true, "old summary");
		prep.messagesToSummarize = [];
		await f.run(prep);
		expect(JSON.stringify(f.calls[0].context)).toContain("Your summary replaces it");
		expect(f.calls).toHaveLength(1);
	});
	const tool = { type: "toolCall", id: "call", name: "read", arguments: {} } as const;
	const unusable = [
		reply("", "toolUse", [tool]),
		reply("", "stop", [tool, { type: "text", text: "## Goal\n## Next Steps" }]),
		reply("  "),
		reply("## Next Steps\nOnly"),
		reply("## Goal\nOnly"),
		reply("## Goal\n## Next Steps", "error"),
		reply("## Goal\n## Next Steps", "length"),
	];
	for (const [index, response] of unusable.entries())
		it(`falls back with combined billed usage for unusable ${index}`, async () => {
			const f = fixture([response]);
			const result = await f.run(preparation(true));
			expect(f.calls).toHaveLength(3);
			expect(result.summary).toContain("serialized");
			expect(result.summary).toContain("Turn Context (split turn)");
			expect(result.usage?.input).toBe(30);
			expect(result.usage?.cost.total).toBe(30);
			expect(f.onUsage).toHaveBeenCalledTimes(3);
		});
	it("falls back on a thrown send error", async () => {
		const f = fixture([new Error("prompt too long")]);
		const result = await f.run();
		expect(f.calls).toHaveLength(2);
		expect(result.summary).toContain("serialized");
	});
	it("never calls retry callbacks for the fork", async () => {
		const f = fixture([{ ...reply("error", "error"), errorMessage: "503 service unavailable" }, reply()]);
		const result = await f.run();
		expect(f.calls).toHaveLength(2);
		expect(result.summary).not.toContain("serialized");
		expect(result.usage?.input).toBe(20);
		for (const callback of Object.values(f.callbacks)) expect(callback).not.toHaveBeenCalled();
	});
	it("rejects an aborted response without falling back", async () => {
		const f = fixture([reply("", "aborted")]);
		await expect(f.run()).rejects.toMatchObject({ name: "AbortError" });
		expect(f.calls).toHaveLength(1);
	});
	it("normalizes a send exception concurrent with signal cancellation to AbortError", async () => {
		const controller = new AbortController();
		const f = fixture([new Error("transport closed")], {}, () => controller.abort());
		await expect(f.run(preparation(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(f.calls).toHaveLength(1);
	});
	it("rejects an aborted signal without falling back", async () => {
		const controller = new AbortController();
		controller.abort();
		const f = fixture();
		await expect(f.run(preparation(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(f.calls.length).toBeLessThanOrEqual(1);
	});
});
