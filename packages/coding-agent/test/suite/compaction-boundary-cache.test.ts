import { zstdDecompressSync } from "node:zlib";
import { type Context, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectPromptPrefixStable } from "../../../ai/test/prompt-prefix-utils.ts";
import { COMPACTION_BOUNDARY_TEXT_V1 } from "../../src/core/messages.ts";
import { createHarness, getMessageText } from "./harness.ts";

/**
 * A5: the first request after a marked compaction (summary, kept range, boundary, prompt) is a byte-identical
 * prefix of the next request at the final wire, for Anthropic and Codex.
 */

const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32000,
};

const codexModel: Model<"openai-codex-responses"> = {
	...anthropicModel,
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.test/backend-api",
};

async function postCompactionRequests(): Promise<[Context, Context]> {
	const contexts: Context[] = [];
	const harness = await createHarness({
		settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 10 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", (event) => ({
					compaction: {
						summary: "SUMMARY",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		],
	});
	try {
		await harness.session.bindExtensions({});
		const capture = (text: string) => (context: Context) => {
			contexts.push(structuredClone(context));
			return fauxAssistantMessage(text);
		};
		harness.setResponses([
			fauxAssistantMessage("OLD-ANSWER"),
			fauxAssistantMessage("KEPT-ANSWER"),
			capture("FIRST-ANSWER"),
			capture("SECOND-ANSWER"),
		]);
		await harness.session.prompt(`OLD ${"o".repeat(400)}`);
		await harness.session.prompt(`KEPT ${"k".repeat(100)}`);
		await harness.session.compact();
		await harness.session.prompt("FIRST-PROMPT");
		await harness.session.prompt("SECOND-PROMPT");
	} finally {
		harness.cleanup();
	}
	expect(contexts).toHaveLength(2);
	expect(contexts[0].messages.map(getMessageText)).toContain(COMPACTION_BOUNDARY_TEXT_V1);
	return contexts as [Context, Context];
}

describe("compaction boundary keeps the cached prefix (A5)", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("Unexpected network transport");
			}),
		);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("Anthropic: the first post-compaction request is an unchanged prefix of the next", async () => {
		const bodies: string[] = [];
		for (const context of await postCompactionRequests()) {
			const result = await streamAnthropic(anthropicModel, normalizeContext(context), {
				apiKey: "sk-ant-offline-test",
				maxRetries: 0,
				cacheRetention: "short",
				fetch: async (input, init) => {
					bodies.push(await new Request(input, init).text());
					return new Response(
						'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			}).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
		}
		expect(bodies[0]).toContain("Compaction boundary (not a request)");
		expectPromptPrefixStable(bodies[0], bodies[1], {
			fixed: ["system", "tools"],
			history: "messages",
			normalize: (raw, path, previousLength) =>
				path === `messages[${previousLength - 1}]`
					? raw.replace(/,"cache_control":\{"type":"ephemeral"\}(\}\]\})$/, "$1")
					: raw,
		});
	});

	it("Codex: the first post-compaction request is an unchanged prefix of the next", async () => {
		const tokenPayload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } }),
		).toString("base64url");
		const bodies: string[] = [];
		for (const context of await postCompactionRequests()) {
			const result = await streamCodex(codexModel, normalizeContext(context), {
				apiKey: `offline.${tokenPayload}.test`,
				transport: "sse",
				maxRetries: 0,
				cacheRetention: "short",
				sessionId: "offline-boundary-prefix",
				fetch: async (input, init) => {
					const request = new Request(input, init);
					const bytes = Buffer.from(await request.arrayBuffer());
					bodies.push(
						request.headers.get("content-encoding") === "zstd"
							? zstdDecompressSync(bytes).toString("utf8")
							: bytes.toString("utf8"),
					);
					return new Response(
						'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			}).result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
		}
		expect(bodies[0]).toContain("Compaction boundary (not a request)");
		expectPromptPrefixStable(bodies[0], bodies[1], {
			fixed: ["instructions", "tools", "prompt_cache_key"],
			history: "input",
		});
	});
});
