import { describe, expect, it } from "vitest";
import { lazyApi, lazyStream } from "../src/api/lazy.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"anthropic-messages"> = {
	id: "test",
	name: "Test",
	api: "anthropic-messages",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
};

describe("lazy setup abort with fork observers and refusal", () => {
	it.each(["stream", "streamSimple"] as const)("preserves abort through %s module setup", async (method) => {
		const controller = new AbortController();
		const api = lazyApi(async () => {
			controller.abort();
			throw new Error("setup cancelled");
		});
		const result = await api[method](model, normalizeContext({ messages: [] }), {
			signal: controller.signal,
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("setup cancelled");
	});

	it("reports an aborted setup result exactly once to the existing observer", async () => {
		const controller = new AbortController();
		const observed: (AssistantMessage | undefined)[] = [];
		const stream = lazyStream(
			model,
			async () => {
				controller.abort();
				throw new Error("setup cancelled");
			},
			{ onResult: (result) => observed.push(result) },
			controller.signal,
		);
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		expect(observed).toEqual([result]);
	});
});
