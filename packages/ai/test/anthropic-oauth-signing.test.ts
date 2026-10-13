import { afterEach, expect, it, vi } from "vitest";
import {
	buildBillingHeaderValue,
	CLAUDE_CODE_CCH_SEED,
	computeBillingVersionSuffix,
	computeClaudeCodeCch,
	extractFirstUserMessageText,
	signAnthropicOAuthFetch,
	xxHash64,
} from "../src/api/anthropic-oauth.ts";

const billing = "x-anthropic-billing-header: cc_version=2.1.145.000; cc_entrypoint=cli; cch=00000;";
const placeholder =
	'{"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.145.abc; cc_entrypoint=cli; cch=00000;"}],"messages":[{"role":"user","content":"hello"}]}';
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

// Golden vectors from the superseded pi-anthropic-auth extension.
it("matches the reconstructed xxHash64 seed and cch golden vectors", () => {
	expect(xxHash64(new TextEncoder().encode("hello"), CLAUDE_CODE_CCH_SEED).toString(16)).toBe("fc8105d2d40e53f1");
	expect(computeClaudeCodeCch(placeholder, CLAUDE_CODE_CCH_SEED)).toBe("e4e84");
});
it("preserves the billing suffix algorithm, empty text and wrapper selection", async () => {
	expect(await computeBillingVersionSuffix("Please summarize this repository status.", "2.1.145")).toBe("62a");
	expect(
		extractFirstUserMessageText([
			{
				role: "user",
				content: [
					{ type: "text", text: "System: wrapper" },
					{ type: "text", text: "hello" },
				],
			},
		]),
	).toBe("hello");
	expect(
		extractFirstUserMessageText([
			{
				role: "user",
				content: [
					{ type: "text", text: "<system-reminder>first" },
					{ type: "text", text: "System: final" },
				],
			},
		]),
	).toBe("System: final");
	expect(buildBillingHeaderValue()).toBe(
		"x-anthropic-billing-header: cc_version=2.1.280.000; cc_entrypoint=cli; cch=00000;",
	);
});
async function signed(
	body: RequestInit["body"],
	seed = CLAUDE_CODE_CCH_SEED,
	url = "https://example.test/v1/messages",
	method = "POST",
) {
	let received: RequestInit | undefined;
	const response = new Response("ok");
	const init: RequestInit = { method, body, headers: { "x-test": "untouched" } };
	const transport: typeof fetch = async (_input, next) => {
		received = next;
		return response;
	};
	expect(await signAnthropicOAuthFetch(transport, seed)(url, init)).toBe(response);
	return { received, init };
}
it("signs the golden serialized body", async () => {
	const { received } = await signed(placeholder.replace("2.1.145.abc", "2.1.145.000"));
	expect(received?.body).toBe(placeholder.replace("2.1.145.abc", "2.1.145.b21").replace("cch=00000", "cch=4b925"));
});
it("only edits system[0]; quoted billing text stays opaque", async () => {
	const payload = {
		system: [
			{ type: "text", text: billing },
			{ type: "text", text: billing },
		],
		messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "id", content: billing }] }],
	};
	const { received } = await signed(JSON.stringify(payload));
	const shaped = JSON.parse(String(received?.body));
	expect(shaped.system[1]).toEqual(payload.system[1]);
	expect(shaped.messages).toEqual(payload.messages);
	expect(shaped.system[0].text).not.toBe(billing);
	shaped.system[0].text = shaped.system[0].text.replace(/cch=[0-9a-f]{5};$/, "cch=00000;");
	expect(computeClaudeCodeCch(JSON.stringify(shaped), CLAUDE_CODE_CCH_SEED)).toBe(
		JSON.parse(String(received?.body)).system[0].text.slice(-6, -1),
	);
});
it.each([
	"bad JSON",
	"null",
	"[]",
	'{"system": "text"}',
	JSON.stringify({ system: [{ type: "text", text: billing.replace("00000", "abcde") }] }),
	JSON.stringify({ system: [{ type: "text", text: `Quoted ${billing}` }] }),
])("fails open on unsupported body: %s", async (body) => {
	const { received, init } = await signed(body);
	expect(received).toBe(init);
});
it("fails open on seed and serialization errors without logging payloads", async () => {
	const log = vi.spyOn(console, "error");
	const badSeed = await signed(placeholder.replace("2.1.145.abc", "2.1.145.000"), "private-invalid-seed");
	expect(badSeed.received).toBe(badSeed.init);
	vi.spyOn(JSON, "stringify").mockImplementationOnce(() => {
		throw new RangeError("private request");
	});
	const badSerialization = await signed(placeholder.replace("2.1.145.abc", "2.1.145.000"));
	expect(badSerialization.received).toBe(badSerialization.init);
	expect(log).not.toHaveBeenCalled();
});
it("leaves other methods, endpoints and non-string bodies unchanged", async () => {
	for (const [body, url, method] of [
		[placeholder, "https://example.test/v1/messages", "GET"],
		[placeholder, "https://example.test/v1/oauth/token", "POST"],
		[new Blob([placeholder]), "https://example.test/v1/messages", "POST"],
	] as const) {
		const { received, init } = await signed(body, CLAUDE_CODE_CCH_SEED, url, method);
		expect(received).toBe(init);
	}
});
it("signs a 12M-character body without altering the attachment", async () => {
	const body = JSON.stringify({
		system: [{ type: "text", text: billing }],
		messages: [
			{ role: "user", content: [{ type: "image", source: { type: "base64", data: "A".repeat(12_000_000) } }] },
		],
	});
	const { received } = await signed(body);
	expect(String(received?.body).length).toBe(body.length);
	expect(
		String(received?.body)
			.replace(/2\.1\.145\.[0-9a-f]{3};/, "2.1.145.000;")
			.replace(/cch=[0-9a-f]{5};/, "cch=00000;"),
	).toBe(body);
}, 15000);
