import { afterEach, describe, expect, it, vi } from "vitest";
import { type AnthropicOptions, convertMessages, stream } from "../src/api/anthropic-messages.ts";
import {
	computeBillingVersionSuffix,
	computeClaudeCodeCch,
	extractFirstUserMessageText,
} from "../src/api/anthropic-oauth.ts";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

const model: Model<"anthropic-messages"> = {
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5 (subscription)",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32000,
	compat: { forceAdaptiveThinking: true },
};
const user = { role: "user" as const, content: "hello", timestamp: 1 };
type Payload = {
	system?: { type: string; text: string; cache_control?: unknown }[];
	messages: unknown[];
	output_config?: { effort: string };
	betas?: string[];
};
async function capture(context: Context, options: AnthropicOptions = {}, target = model) {
	let body = "";
	let headers = new Headers();
	const result = await stream(target, normalizeContext(context), {
		apiKey: "sk-ant-oat-test",
		maxRetries: 0,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			headers = request.headers;
			body = await request.text();
			return new Response(
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
		...options,
	}).result();
	expect(result.stopReason).toBe("stop");
	return { body, headers, payload: JSON.parse(body) as Payload };
}
afterEach(() => vi.unstubAllGlobals());
describe("Anthropic OAuth compatibility on the serialized wire", () => {
	it.each(["You are an expert coding assistant operating inside pi, a coding agent harness.", "My custom prompt", ""])(
		"puts billing before true identity and prompt: %s",
		async (systemPrompt) => {
			const { body, headers, payload } = await capture({ systemPrompt, messages: [user] });
			expect(payload.system).toHaveLength(2);
			expect(payload.system?.[0]?.text).toMatch(
				/^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5};$/,
			);
			expect(payload.system?.[0]?.text).not.toContain("cch=00000");
			expect(payload.system?.[0]?.cache_control).toBeUndefined();
			expect(payload.system?.[1]).toEqual({
				type: "text",
				text: `You are Claude Opus 5.5 (model ID: ${model.id}), made by Anthropic.${systemPrompt ? `\n\n${systemPrompt}` : ""}`,
				cache_control: { type: "ephemeral" },
			});
			expect(body).not.toContain("Claude Code");
			expect(headers.get("user-agent")).toBe("claude-cli/2.1.280");
			expect(headers.get("x-app")).toBe("cli");
			expect(headers.get("authorization")).toBe("Bearer sk-ant-oat-test");
			expect(headers.has("x-api-key")).toBe(false);
		},
	);
	it.each(["", model.id, " (subscription)"])("uses Claude for empty or ID-only names: %s", async (name) => {
		const { payload } = await capture({ messages: [user] }, {}, { ...model, name });
		expect(payload.system?.[1]?.text).toBe(`You are Claude (model ID: ${model.id}), made by Anthropic.`);
	});
	it("preserves literal dollar sequences in model names", async () => {
		const { payload } = await capture(
			{ messages: [user] },
			{ cacheRetention: "none" },
			{ ...model, name: "Claude $& $1 $$ (custom)" },
		);
		expect(payload.system?.[1]).toEqual({
			type: "text",
			text: `You are Claude $& $1 $$ (model ID: ${model.id}), made by Anthropic.`,
		});
	});
	it("keeps API key system shape unchanged", async () => {
		const { payload, headers } = await capture(
			{ systemPrompt: "Custom", messages: [user] },
			{ apiKey: "test-key", thinkingEnabled: true, effort: "low" },
		);
		expect(payload.system).toEqual([{ type: "text", text: "Custom", cache_control: { type: "ephemeral" } }]);
		expect(headers.get("anthropic-beta") ?? "").not.toContain("effort-2025-11-24");
		const empty = await capture({ messages: [user] }, { apiKey: "test-key" });
		expect(empty.payload.system).toBeUndefined();
	});
	it("uses scoped version for billing and user-agent", async () => {
		const { payload, headers } = await capture(
			{ messages: [user] },
			{ env: { PI_ANTHROPIC_CLAUDE_CODE_VERSION: "2.1.145" } },
		);
		expect(payload.system?.[0]?.text).toMatch(/cc_version=2\.1\.145\./);
		expect(headers.get("user-agent")).toBe("claude-cli/2.1.145");
	});
	it("signs after onPayload mutations using the scoped seed, without changing tool-result quotes", async () => {
		const seed = "0x1234567890abcdef";
		let reusable: Payload | undefined;
		const originalFetch = globalThis.fetch;
		const quoted = "x-anthropic-billing-header: cc_version=2.1.280.abc; cc_entrypoint=cli; cch=00000;";
		const { body, payload } = await capture(
			{ messages: [user] },
			{
				env: { PI_ANTHROPIC_CCH_SEED: seed },
				onPayload: (value) => {
					const params = value as Payload;
					reusable = params;
					params.system![1]!.text += "\nExtension mutation";
					return {
						...params,
						messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: quoted }] }],
					};
				},
			},
		);
		expect(globalThis.fetch).toBe(originalFetch);
		expect(reusable?.system?.[0]?.text).toContain("cc_version=2.1.280.000;");
		expect(reusable?.system?.[0]?.text).toContain("cch=00000;");
		expect(payload.system?.[1]?.text).toContain("Extension mutation");
		expect(payload.messages).toEqual([
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: quoted }] },
		]);
		const signed = payload.system![0]!.text.slice(-6, -1);
		payload.system![0]!.text = `${payload.system![0]!.text.slice(0, -6)}00000;`;
		expect(signed).toBe(computeClaudeCodeCch(JSON.stringify(payload), seed));
		expect(body).not.toBe(JSON.stringify(payload));
	});
	it("adds OAuth effort beta after onPayload and retains configured betas", async () => {
		const { headers } = await capture(
			{ messages: [user] },
			{
				headers: { "anthropic-beta": "custom-beta" },
				onPayload: (value) => ({ ...(value as Payload), output_config: { effort: "low" } }),
			},
		);
		expect(headers.get("anthropic-beta")?.split(",")).toEqual(["custom-beta", "effort-2025-11-24"]);
	});
	it.each([null, "custom-beta", "custom-beta,effort-2025-11-24"])(
		"appends effort to effective beta overrides, including fast mode: %s",
		async (configured) => {
			for (const fast of [false, true]) {
				const { headers } = await capture(
					{ messages: [user] },
					{
						headers: { "anthropic-beta": configured },
						onPayload: (value) => ({
							...(value as Payload),
							output_config: { effort: "low" },
							...(fast ? { speed: "fast" } : {}),
						}),
					},
				);
				const betas = headers.get("anthropic-beta")?.split(",") ?? [];
				expect(betas.filter((value) => value === "effort-2025-11-24")).toHaveLength(1);
				if (configured) expect(betas).toContain("custom-beta");
				if (fast) expect(betas).toContain("fast-mode-2026-02-01");
			}
		},
	);
	it.each([{ content: "" }, { content: [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }] }])(
		"emits signed billing when first user text is absent: %s",
		async ({ content }) => {
			const { payload } = await capture({ messages: [{ ...user, content }] });
			const finalText = extractFirstUserMessageText(
				payload.messages as Parameters<typeof extractFirstUserMessageText>[0],
			);
			expect(payload.system?.[0]?.text).toContain(
				`cc_version=2.1.280.${await computeBillingVersionSuffix(finalText)};`,
			);
			expect(payload.system?.[0]?.cache_control).toBeUndefined();
		},
	);
	it("emits billing for tool-result-only and empty transcripts", async () => {
		for (const messages of [
			[],
			[
				{
					role: "toolResult" as const,
					toolCallId: "1",
					toolName: "read",
					content: [{ type: "text" as const, text: "result" }],
					isError: false,
					timestamp: 1,
				},
			],
		]) {
			const { payload } = await capture({ messages });
			expect(payload.system?.[0]?.text).toContain(`cc_version=2.1.280.${await computeBillingVersionSuffix("")};`);
		}
	});
	it.each(["user-agent", "User-Agent", "USER-AGENT"])(
		"honors OAuth UA/x-app overrides regardless of header case: %s",
		async (name) => {
			const { payload, headers } = await capture(
				{ messages: [user] },
				{ headers: { [name]: "custom-UA", "X-App": "custom-app" } },
				{ ...model, headers: { "UsEr-AgEnT": "model-UA", "x-app": "model-app" } },
			);
			expect(headers.get("user-agent")).toBe("custom-UA");
			expect(headers.get("x-app")).toBe("custom-app");
			expect(payload.system?.[0]?.text).toContain("cc_version=2.1.280.");
		},
	);
	it("adds effort beta for managed effort and fast mode", async () => {
		const { headers } = await capture(
			{ messages: [user] },
			{ onPayload: (value) => ({ ...(value as Payload), speed: "fast" }) },
			{ ...model, compat: { supportsMidConvoEffort: true } },
		);
		expect(headers.get("anthropic-beta")?.split(",")).toContain("effort-2025-11-24");
	});
});

it.each([false, true])("splits reachable text after tool_use; OAuth=%s, preserves effort annotations", (oauth) => {
	const assistant: AssistantMessage = {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: model.id,
		stopReason: "toolUse",
		timestamp: 2,
		providerThinkingLevel: "low",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		content: [
			{ type: "thinking", thinking: "", thinkingSignature: "sig" },
			{ type: "thinking", thinking: "opaque", thinkingSignature: "redacted-sig", redacted: true },
			{ type: "text", text: "before" },
			{ type: "toolCall", id: "tool_1", name: "read", arguments: {} },
			{ type: "text", text: "after" },
			{ type: "toolCall", id: "tool_2", name: "write", arguments: {} },
		],
	};
	const converted = convertMessages([user, assistant], oauth, undefined, false, "anthropic");
	expect(
		converted.messages
			.slice(1)
			.map((message) => (Array.isArray(message.content) ? message.content.map((block) => block.type) : [])),
	).toEqual([
		["thinking", "redacted_thinking", "text", "text"],
		["tool_use", "tool_use"],
	]);
	const valid = {
		...assistant,
		content: [
			...assistant.content.filter((block) => block.type !== "toolCall"),
			...assistant.content.filter((block) => block.type === "toolCall"),
		],
	};
	expect(convertMessages([user, valid], oauth).messages).toHaveLength(2);
	expect([...converted.assistantLevels.entries()]).toEqual([[1, "low"]]);
});

it.each([undefined, null, 42, false, "", "   ", "rotated"])(
	"refresh preserves old token unless a nonempty replacement is returned: %s",
	async (refresh_token) => {
		vi.stubGlobal(
			"fetch",
			async () => new Response(JSON.stringify({ access_token: "new", refresh_token, expires_in: 3600 })),
		);
		const credential = await anthropicOAuth.refresh(
			{ type: "oauth", access: "old", refresh: "previous", expires: 0 },
			new AbortController().signal,
		);
		expect(credential.refresh).toBe(refresh_token === "rotated" ? "rotated" : "previous");
		expect(credential.access).toBe("new");
	},
);
