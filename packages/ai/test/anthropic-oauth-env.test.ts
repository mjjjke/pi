import { afterEach, expect, it, vi } from "vitest";
import {
	CLAUDE_CODE_CCH_SEED,
	CLAUDE_CODE_VERSION,
	getClaudeCodeCchSeed,
	getClaudeCodeVersion,
	signAnthropicOAuthFetch,
} from "../src/api/anthropic-oauth.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});
it("validates env overrides with defaults and honors scoped env over process env", () => {
	vi.stubEnv("PI_ANTHROPIC_CLAUDE_CODE_VERSION", "2.1.145");
	vi.stubEnv("PI_ANTHROPIC_CCH_SEED", "0x1");
	expect(getClaudeCodeVersion()).toBe("2.1.145");
	expect(getClaudeCodeCchSeed()).toBe("0x1");
	expect(getClaudeCodeVersion({ PI_ANTHROPIC_CLAUDE_CODE_VERSION: " 2.1.280 " })).toBe("2.1.280");
	expect(getClaudeCodeCchSeed({ PI_ANTHROPIC_CCH_SEED: " 0xAB " })).toBe("0xAB");
	for (const value of ["", "  ", "a; cch=abcde", "v\ninvalid"])
		expect(getClaudeCodeVersion({ PI_ANTHROPIC_CLAUDE_CODE_VERSION: value })).toBe(CLAUDE_CODE_VERSION);
	for (const value of ["", "  ", "1", "0x", "0x10000000000000000", "invalid"])
		expect(getClaudeCodeCchSeed({ PI_ANTHROPIC_CCH_SEED: value })).toBe(CLAUDE_CODE_CCH_SEED);
});
it("never retries a downstream fetch rejection inside the signer", async () => {
	const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("transport failed"));
	const fetch = signAnthropicOAuthFetch(transport);
	await expect(
		fetch("https://example.test/v1/messages?beta=true", {
			method: "POST",
			body: JSON.stringify({
				system: [
					{
						type: "text",
						text: "x-anthropic-billing-header: cc_version=2.1.280.000; cc_entrypoint=cli; cch=00000;",
					},
				],
				messages: [{ role: "user", content: "hi" }],
			}),
		}),
	).rejects.toThrow("transport failed");
	expect(transport).toHaveBeenCalledOnce();
});
it("passes Request-without-init through without consuming it", async () => {
	const request = new Request("https://example.test/v1/messages", { method: "POST", body: "unsupported" });
	const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response());
	await signAnthropicOAuthFetch(transport)(request);
	expect(transport).toHaveBeenCalledWith(request, undefined);
	expect(request.bodyUsed).toBe(false);
});
