import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { CLAUDE_CODE_CCH_SEED, computeClaudeCodeCch } from "../src/api/anthropic-oauth.ts";
import { stream as streamCodex } from "../src/api/openai-codex-responses.ts";
import type { Api, AssistantMessage, Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { expectPromptPrefixStable, jsonSlices } from "./prompt-prefix-utils.ts";

// Regression: 2026-10-13 historical tool-result corruption (see FORK.md OAuth coverage).
const quotedBilling = "x-anthropic-billing-header: cc_version=2.1.280.abc; cc_entrypoint=cli; cch=00000;";
const adversarial = `Captured request — café 日本語 🧪\n${quotedBilling}\nAnother billing example:\n${quotedBilling}\nLiteral cch=abcde; and cache_control text\nJSON-looking: {"quoted":"\\n"}`;
const hookText = "\nStable onPayload addition — ñ\nsecond line";
const anthropicModel: Model<"anthropic-messages"> = {
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.test",
	reasoning: true,
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

function assistant(model: Model<Api>, id: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{ type: "text", text: "Reading — résumé\nnext line" },
			{ type: "toolCall", id, name: "read", arguments: { path: "café.txt" } },
		],
		stopReason: "toolUse",
		timestamp,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

const bootstrapPrefix: Context["messages"] = [
	{ role: "developer", content: "<collaboration_mode>\n# Default\nMask — ñ\n</collaboration_mode>", timestamp: 0 },
	{ role: "developer", content: "One-shot startup notice", timestamp: 0 },
	{ role: "user", content: "Handoff snapshot — café", timestamp: 0 },
];

function withInstructions<T extends Model<Api>>(model: T): T {
	return { ...model, capabilities: { midConversationInstructionMessages: true } };
}

function turns(model: Model<Api>, bootstrap = false): [Context, Context] {
	const previous: Context = {
		systemPrompt: "Keep history opaque — 日本語\nPreserve all earlier bytes.",
		tools: [
			{
				name: "read",
				description: "Read text — café\nwithout rewriting it",
				parameters: Type.Object({ path: Type.String() }),
			},
			{ name: "other", description: "Another stable declaration", parameters: Type.Object({}) },
		],
		messages: [
			...(bootstrap ? bootstrapPrefix : []),
			{ role: "user", content: "Read the captured request — é\nthen continue.", timestamp: 1 },
			assistant(model, "call_old", 2),
			{
				role: "toolResult",
				toolCallId: "call_old",
				toolName: "read",
				content: [{ type: "text", text: adversarial }],
				isError: false,
				timestamp: 3,
			},
		],
	};
	return [
		previous,
		{
			...previous,
			messages: [
				...previous.messages,
				assistant(model, "call_new", 4),
				{
					role: "toolResult",
					toolCallId: "call_new",
					toolName: "read",
					content: [{ type: "text", text: "New result — mañana\nOnly this suffix is new." }],
					isError: false,
					timestamp: 5,
				},
			],
		},
	];
}

const anthropicPrefix = (oauth: boolean) => ({
	fixed: ["system", "tools"],
	history: "messages",
	normalize: (raw: string, path: string, previousLength: number) => {
		// Only system[0].text's five cch hex digits are uncached. The version suffix,
		// identity, prompt and every other system byte must remain identical.
		if (oauth && path === "system") {
			return raw.replace(
				/^(\[\{"type":"text","text":"x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=cli; cch=)[0-9a-f]{5}(;")/,
				"$1<CCH>$2",
			);
		}
		// The old final tool_result loses its breakpoint when the new user/tool turn
		// becomes the cache anchor. No other cache_control field may be ignored.
		if (path === `messages[${previousLength - 1}]`) {
			return raw.replace(/,"cache_control":\{"type":"ephemeral"\}(\}\]\})$/, "$1");
		}
		return raw;
	},
});

beforeEach(() => {
	// Even an accidental fallback/new fetch path cannot reach the network.
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("Unexpected network transport");
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());

async function captureAnthropic(
	oauth: boolean,
	rewriteWire = (body: string) => body,
	bootstrap = false,
): Promise<string[]> {
	const model = bootstrap ? withInstructions(anthropicModel) : anthropicModel;
	const bodies: string[] = [];
	const onPayload = vi.fn(async (value: unknown) => {
		const payload = value as { system: { text: string }[] };
		payload.system[oauth ? 1 : 0]!.text += hookText;
		return payload;
	});
	for (const context of turns(model, bootstrap)) {
		const result = await streamAnthropic(model, normalizeContext(context), {
			apiKey: oauth ? "sk-ant-oat-offline-test" : "sk-ant-offline-test",
			maxRetries: 0,
			cacheRetention: "short",
			env: { PI_ANTHROPIC_CLAUDE_CODE_VERSION: "2.1.280", PI_ANTHROPIC_CCH_SEED: CLAUDE_CODE_CCH_SEED },
			onPayload,
			fetch: async (input, init) => {
				const request = new Request(input, init);
				expect(request.url).toBe("https://example.test/v1/messages?beta=true");
				expect(request.headers.get(oauth ? "authorization" : "x-api-key")).toBe(
					oauth ? "Bearer sk-ant-oat-offline-test" : "sk-ant-offline-test",
				);
				bodies.push(rewriteWire(await request.text()));
				return new Response(
					'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
	}
	expect(onPayload).toHaveBeenCalledTimes(2);
	expect(bodies).toHaveLength(2);
	return bodies;
}

describe("final-wire prompt prefix stability", () => {
	it.each([false, true])("preserves Anthropic old context byte-for-byte (subscription OAuth=%s)", async (oauth) => {
		const [before, after] = await captureAnthropic(oauth);
		for (const body of [before!, after!]) {
			const payload = JSON.parse(body);
			expect(payload.system[oauth ? 1 : 0].text).toContain(hookText);
			expect(payload.messages[2].content[0].content).toBe(adversarial);
			if (oauth) {
				expect(payload.system[0]).not.toHaveProperty("cache_control");
				expect(payload.system[0].text).toMatch(
					/cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
				);
				const cch = payload.system[0].text.slice(-6, -1);
				payload.system[0].text = payload.system[0].text.replace(/cch=[0-9a-f]{5};$/, "cch=00000;");
				expect(cch).toBe(computeClaudeCodeCch(JSON.stringify(payload), CLAUDE_CODE_CCH_SEED));
			}
		}
		const oldPayload = JSON.parse(before!);
		const newPayload = JSON.parse(after!);
		expect(oldPayload.messages[2].content[0].cache_control).toEqual({ type: "ephemeral" });
		expect(newPayload.messages[2].content[0]).not.toHaveProperty("cache_control");
		expect(newPayload.messages.at(-1).content[0].cache_control).toEqual({ type: "ephemeral" });
		if (oauth) expect(oldPayload.system[0].text).not.toBe(newPayload.system[0].text);
		expectPromptPrefixStable(before!, after!, anthropicPrefix(oauth));
	});

	it.each([false, true])("keeps the folded v4 bootstrap prefix byte-stable on Anthropic (OAuth=%s)", async (oauth) => {
		const [before, after] = await captureAnthropic(oauth, undefined, true);
		for (const body of [before!, after!]) {
			const payload = JSON.parse(body);
			const offset = oauth ? 1 : 0;
			expect(payload.system.slice(offset).map((block: { text: string }) => block.text)).toEqual([
				expect.stringContaining("Keep history opaque"),
				"<collaboration_mode>\n# Default\nMask — ñ\n</collaboration_mode>",
				"One-shot startup notice",
			]);
			expect(payload.system.at(-1).cache_control).toEqual({ type: "ephemeral" });
			expect(payload.system.slice(0, -1).some((block: object) => "cache_control" in block)).toBe(false);
			expect(payload.messages[0].role).toBe("user");
			expect(JSON.stringify(payload.messages)).not.toContain("collaboration_mode");
		}
		expectPromptPrefixStable(before!, after!, anthropicPrefix(oauth));
	});

	it.each([false, true])(
		"preserves Codex instructions, tools and every old input item after onPayload and zstd serialization (v4 bootstrap=%s)",
		async (bootstrap) => {
			const model = bootstrap ? withInstructions(codexModel) : codexModel;
			const tokenPayload = Buffer.from(
				JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } }),
			).toString("base64url");
			const bodies: string[] = [];
			const onPayload = vi.fn(async (value: unknown) => {
				const payload = value as { instructions: string };
				return { ...payload, instructions: payload.instructions + hookText };
			});
			for (const context of turns(model, bootstrap)) {
				const result = await streamCodex(model, normalizeContext(context), {
					apiKey: `offline.${tokenPayload}.test`,
					transport: "sse",
					maxRetries: 0,
					cacheRetention: "short",
					sessionId: "offline-prefix-stability",
					onPayload,
					fetch: async (input, init) => {
						const request = new Request(input, init);
						expect(request.url).toBe("https://example.test/backend-api/codex/responses");
						const bytes = Buffer.from(await request.arrayBuffer());
						const encoding = request.headers.get("content-encoding");
						expect(encoding).toBe("zstd");
						bodies.push(zstdDecompressSync(bytes).toString("utf8"));
						return new Response(
							'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
							{
								headers: { "content-type": "text/event-stream" },
							},
						);
					},
				}).result();
				expect(result.stopReason, result.errorMessage).toBe("stop");
			}
			expect(onPayload).toHaveBeenCalledTimes(2);
			expect(bodies).toHaveLength(2);
			for (const body of bodies) {
				const payload = JSON.parse(body);
				expect(payload.instructions).toContain(hookText);
				expect(payload.input.find((item: { type: string }) => item.type === "function_call_output").output).toBe(
					adversarial,
				);
				if (bootstrap) {
					expect(payload.instructions).not.toContain("collaboration_mode");
					expect(payload.input.slice(0, 3).map((item: { role: string }) => item.role)).toEqual([
						"developer",
						"developer",
						"user",
					]);
					expect(JSON.stringify(payload.input[0])).toContain("collaboration_mode");
				}
			}
			expectPromptPrefixStable(bodies[0]!, bodies[1]!, {
				fixed: ["instructions", "tools", "prompt_cache_key"],
				history: "input",
			});
		},
	);

	it("rejects the incident's whole-body regex signer even with the legitimate OAuth/cache exceptions", async () => {
		// Exact historical regex/placeholder/hash algorithm, kept test-local. Messages
		// serialize before system, so this signs an OLD tool result, not system[0].
		const brokenSigner = (body: string) => {
			expect(body.indexOf('"messages":')).toBeLessThan(body.indexOf('"system":'));
			const pattern = /(x-anthropic-billing-header:[^"\\]*(?:\\.[^"\\]*)*?cch=)([0-9a-f]{5})(;)/i;
			const placeholder = body.replace(
				pattern,
				(_match, prefix: string, _cch: string, suffix: string) => `${prefix}00000${suffix}`,
			);
			return body.replace(
				pattern,
				(_match, prefix: string, _cch: string, suffix: string) =>
					`${prefix}${computeClaudeCodeCch(placeholder, CLAUDE_CODE_CCH_SEED)}${suffix}`,
			);
		};
		const [before, after] = await captureAnthropic(true, brokenSigner);
		expect(JSON.parse(before!).messages[2].content[0].content).not.toBe(adversarial);
		expect(() => expectPromptPrefixStable(before!, after!, anthropicPrefix(true))).toThrow(
			"cached prefix changed at messages[2]",
		);
	});

	it("compares raw JSON bytes rather than equal parsed values", () => {
		const before = '{"instructions":"é","tools":[],"input":[{"content":"é","role":"user"}]}';
		const after =
			'{"instructions":"é","tools":[],"input":[{"content":"\\u00e9","role":"user"},{"role":"user","content":"new"}]}';
		expect(JSON.parse(before).input[0]).toEqual(JSON.parse(after).input[0]);
		expect(() =>
			expectPromptPrefixStable(before, after, { fixed: ["instructions", "tools"], history: "input" }),
		).toThrow("cached prefix changed at input[0]");
		expect(jsonSlices(' { "x": [true, null, 12, "\\"\\\\"] } ').children.get("x")?.raw).toBe(
			'[true, null, 12, "\\"\\\\"]',
		);
	});
});
