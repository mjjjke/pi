import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.ts";
import { createCompactionJobSummarizer } from "../src/core/compaction-job.ts";

const model: Model<"openai-responses"> = {
	id: "session-model",
	name: "session model",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100000,
	maxTokens: 1000,
};
const usage: Usage = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function response(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "summary" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: structuredClone(usage),
		stopReason,
		timestamp: 1,
		...(stopReason === "error" ? { errorMessage: "503 temporarily unavailable" } : {}),
	};
}
function preparation(split = false): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: [{ role: "user", content: "history", timestamp: 1 }],
		turnPrefixMessages: split ? [{ role: "user", content: "turn prefix", timestamp: 2 }] : [],
		isSplitTurn: split,
		tokensBefore: 1000,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { ...DEFAULT_COMPACTION_SETTINGS },
	};
}
function fake(...responses: AssistantMessage[]) {
	let index = 0;
	return vi.fn<StreamFn>(() => {
		const stream = createAssistantMessageEventStream();
		stream.end(responses[index++]);
		return stream;
	});
}

describe("background compaction reuses the real compactor offline", () => {
	it("uses a detached session model/request snapshot, job signal/instructions and no cache writes", async () => {
		const liveModel = structuredClone(model);
		const headers = { "x-route": "launch" };
		const env = { ROUTE: "launch" };
		const stream = fake(response());
		const summarize = createCompactionJobSummarizer(
			liveModel,
			undefined,
			headers,
			"blocking instructions",
			new AbortController().signal,
			"off",
			stream,
			env,
			undefined,
			undefined,
			"routing-session",
		);
		liveModel.id = "changed-model";
		headers["x-route"] = "changed";
		env.ROUTE = "changed";
		const controller = new AbortController();
		const account = vi.fn();
		const result = await summarize({
			preparation: preparation(),
			branch: [],
			signal: controller.signal,
			customInstructions: "job focus",
			onUsage: account,
		});
		expect(result.summary).toContain("summary");
		expect(result.firstKeptEntryId).toBe("kept");
		expect(stream.mock.calls[0][0].id).toBe("session-model");
		expect(stream.mock.calls[0][2]).toMatchObject({
			cacheRetention: "none",
			sessionId: "routing-session",
			headers: { "x-route": "launch" },
			env: { ROUTE: "launch" },
		});
		expect(stream.mock.calls[0][2]?.signal).toBe(controller.signal);
		expect(JSON.stringify(stream.mock.calls[0][1])).toContain("job focus");
		expect(JSON.stringify(stream.mock.calls[0][1])).not.toContain("blocking instructions");
		expect(account).toHaveBeenCalledExactlyOnceWith(usage);
	});
	it("accounts both split-turn requests once and combines only the successful summary usage", async () => {
		const stream = fake(response(), response());
		const account = vi.fn();
		const summarize = createCompactionJobSummarizer(model, undefined, undefined, undefined, undefined, "off", stream);
		const result = await summarize({
			preparation: preparation(true),
			branch: [],
			signal: new AbortController().signal,
			onUsage: account,
		});
		expect(account.mock.calls.map(([value]) => value)).toEqual([usage, usage]);
		expect(result.usage?.totalTokens).toBe(24);
		expect(stream.mock.calls.map((call) => call[2]?.cacheRetention)).toEqual(["none", "none"]);
	});
	it("retains first-call usage when the second split summary fails validation", async () => {
		const stream = fake(response(), response("length"));
		const account = vi.fn();
		const summarize = createCompactionJobSummarizer(model, undefined, undefined, undefined, undefined, "off", stream);
		await expect(
			summarize({
				preparation: preparation(true),
				branch: [],
				signal: new AbortController().signal,
				onUsage: account,
			}),
		).rejects.toThrow("token cap");
		expect(account.mock.calls.map(([value]) => value)).toEqual([usage, usage]);
	});
	it("accounts consumed usage from a failed retry attempt as well as its successful retry", async () => {
		const stream = fake(response("error"), response());
		const account = vi.fn();
		const summarize = createCompactionJobSummarizer(
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
			stream,
			undefined,
			{ enabled: true, maxRetries: 1, baseDelayMs: 0 },
		);
		await summarize({
			preparation: preparation(),
			branch: [],
			signal: new AbortController().signal,
			onUsage: account,
		});
		expect(account.mock.calls.map(([value]) => value)).toEqual([usage, usage]);
	});
});
