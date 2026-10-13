import { expect, it, vi } from "vitest";
import { stream } from "../src/api/anthropic-messages.ts";
import { computeClaudeCodeCch } from "../src/api/anthropic-oauth.ts";
import { normalizeContext } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 1000,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
it("signs every provider retry from fresh placeholders without modifying reusable parameters", async () => {
	const bodies: string[] = [];
	let placeholder = "";
	const result = await stream(model, context, {
		apiKey: "sk-ant-oat-test",
		maxRetries: 1,
		maxRetryDelayMs: 100,
		onPayload: (payload) => {
			placeholder = JSON.stringify(payload);
		},
		fetch: async (_input, init) => {
			bodies.push(String(init?.body));
			if (bodies.length === 1)
				return new Response('{"error":{"type":"rate_limit_error","message":"retry"}}', {
					status: 429,
					headers: { "retry-after-ms": "1", "content-type": "application/json" },
				});
			return new Response(
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	}).result();
	expect(result.stopReason).toBe("stop");
	expect(bodies).toHaveLength(2);
	expect(bodies[0]).toBe(bodies[1]);
	expect(placeholder).toContain("cc_version=2.1.280.000;");
	const payload = JSON.parse(bodies[0]!);
	const cch = payload.system[0].text.slice(-6, -1);
	payload.system[0].text = `${payload.system[0].text.slice(0, -6)}00000;`;
	expect(computeClaudeCodeCch(JSON.stringify(payload), "0x4d659218e32a3268")).toBe(cch);
});
it("does not fetch or retry an already-aborted provider request", async () => {
	const controller = new AbortController();
	controller.abort();
	const fetch = vi.fn<typeof globalThis.fetch>();
	const result = await stream(model, context, {
		apiKey: "sk-ant-oat-test",
		signal: controller.signal,
		fetch,
	}).result();
	expect(result.stopReason).toBe("aborted");
	expect(fetch).not.toHaveBeenCalled();
});
