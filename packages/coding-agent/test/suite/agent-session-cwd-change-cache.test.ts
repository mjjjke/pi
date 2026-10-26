import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { type Context, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { expectPromptPrefixStable } from "../../../ai/test/prompt-prefix-utils.ts";
import { cwdFixture } from "./cwd-change-fixture.ts";

const anthropic: Model<"anthropic-messages"> = {
	id: "claude-opus-5-5",
	name: "offline",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 32000,
	compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
};
const codex: Model<"openai-codex-responses"> = {
	...anthropic,
	id: "gpt-6-luna",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.test/backend-api",
	compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
};

async function wire(context: Context, transport: "anthropic" | "responses", additions = true): Promise<string> {
	let body = "";
	const fetch = async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const bytes = Buffer.from(await request.arrayBuffer());
		body =
			request.headers.get("content-encoding") === "zstd"
				? zstdDecompressSync(bytes).toString("utf8")
				: bytes.toString("utf8");
		return new Response(
			transport === "anthropic"
				? 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
				: 'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	const contextCopy = normalizeContext(context);
	const token = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } }),
	).toString("base64url");
	const result =
		transport === "anthropic"
			? await streamAnthropic(anthropic, contextCopy, {
					apiKey: "sk-ant-offline",
					maxRetries: 0,
					cacheRetention: "none",
					fetch,
				}).result()
			: await streamCodex(
					{ ...codex, compat: { ...codex.compat, supportsAdditionalTools: additions } },
					contextCopy,
					{
						apiKey: `offline.${token}.test`,
						maxRetries: 0,
						transport: "sse",
						sessionId: "offline-cwd-prefix",
						cacheRetention: "none",
						fetch,
					},
				).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	return body;
}

function prefix(before: string, after: string, transport: "anthropic" | "responses", tools = true) {
	expectPromptPrefixStable(
		before,
		after,
		transport === "anthropic"
			? {
					fixed: ["system", ...(tools ? ["tools"] : [])],
					history: "messages",
					normalize: (raw, path, length) =>
						path === `messages[${length - 1}]`
							? raw.replace(/,"cache_control":\{"type":"ephemeral"\}(\}\]\})$/, "$1")
							: raw,
				}
			: { fixed: ["instructions", ...(tools ? ["tools"] : [])], history: "input" },
	);
}

describe("cwd final-wire cache contract", () => {
	it.each(["baseline", "images", "equal-reload", "codemode-only", "codemode-disabled"] as const)(
		"%s preserves every old request byte on Anthropic and Responses",
		async (scenario) => {
			const f = await cwdFixture({ codemode: scenario === "codemode-disabled" });
			let reloadedFaux: ReturnType<typeof registerFauxProvider> | undefined;
			try {
				f.runtime.setResolveTargetTrust(async () => true);
				if (scenario === "codemode-disabled") f.runtime.session.setActiveToolsByName(["read", "codemode"]);
				const contexts: Context[] = [];
				f.seed.setResponses(
					Array.from({ length: 8 }, () => (context) => {
						contexts.push(structuredClone(context));
						return fauxAssistantMessage("ok");
					}),
				);
				await f.runtime.session.prompt("bootstrap");
				if (scenario === "images" || scenario === "equal-reload")
					await f.runtime.session.sendCustomMessage({
						customType: "image",
						content: [
							{
								type: "image",
								mimeType: "image/png",
								data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=",
							},
						],
						display: false,
					});
				await f.runtime.session.prompt("before");
				mkdirSync(join(f.b, ".pi"));
				writeFileSync(
					join(f.b, ".pi", "settings.json"),
					JSON.stringify({
						images: { blockImages: scenario === "images" },
						codemode: { mode: scenario === "codemode-only" ? "only" : "on" },
						...(scenario === "codemode-disabled"
							? { extensions: ["-builtin:codemode"], defaultTools: ["+codemode"] }
							: {}),
					}),
				);
				expect((await f.runtime.changeCwd(f.b, { source: "user" })).changed).toBe(true);
				if (scenario === "equal-reload") {
					writeFileSync(join(f.b, ".pi", "settings.json"), JSON.stringify({ images: { blockImages: true } }));
					await f.runtime.session.reload();
					reloadedFaux = registerFauxProvider({
						api: f.seed.faux.api,
						models: [
							{ id: "a", reasoning: true },
							{ id: "b", reasoning: true },
						],
					});
					reloadedFaux.setResponses(
						Array.from({ length: 3 }, () => (context) => {
							contexts.push(structuredClone(context));
							return fauxAssistantMessage("ok");
						}),
					);
				}
				await f.runtime.session.prompt("after");
				await f.runtime.session.prompt("stable");
				for (const transport of ["anthropic", "responses"] as const) {
					const bodies = await Promise.all(contexts.slice(1).map((context) => wire(context, transport)));
					prefix(bodies[0]!, bodies[1]!, transport, scenario !== "codemode-disabled" || transport === "anthropic");
					prefix(bodies[1]!, bodies[2]!, transport);
				}
				if (scenario === "images") {
					f.runtime.session.settingsManager.setBlockImages(true);
					await f.runtime.session.prompt("explicit image setting");
					expect(JSON.stringify(contexts.at(-1))).toContain("Image reading is disabled.");
				}
			} finally {
				reloadedFaux?.unregister();
				await f.cleanup();
			}
		},
	);

	it.each(["add", "remove", "redefine"] as const)(
		"tool %s is appended on Anthropic; Responses accepts full-list changes and stabilizes",
		async (change) => {
			let destination = false;
			const f = await cwdFixture({
				extension: (pi) => {
					if ((change === "add" && !destination) || (change === "remove" && destination)) return;
					pi.registerTool({
						name: "extra",
						label: "extra",
						description: destination ? "new definition" : "old definition",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					});
				},
			});
			try {
				const contexts: Context[] = [];
				f.seed.setResponses(
					Array.from({ length: 3 }, () => (context) => {
						contexts.push(structuredClone(context));
						return fauxAssistantMessage("ok");
					}),
				);
				await f.runtime.session.prompt("before");
				destination = true;
				expect((await f.runtime.changeCwd(f.b, { source: "user" })).changed).toBe(true);
				await f.runtime.session.prompt("after");
				await f.runtime.session.prompt("stable");
				for (const transport of ["anthropic", "responses"] as const) {
					const bodies = await Promise.all(contexts.map((context) => wire(context, transport)));
					prefix(bodies[0]!, bodies[1]!, transport, transport === "anthropic" || change === "add");
					prefix(bodies[1]!, bodies[2]!, transport);
					if (transport === "responses" && change !== "add")
						expect(JSON.parse(bodies[0]!).tools).not.toEqual(JSON.parse(bodies[1]!).tools);
				}
				if (change === "add") {
					const bodies = await Promise.all(contexts.map((context) => wire(context, "responses", false)));
					expect(JSON.parse(bodies[0]!).tools).not.toEqual(JSON.parse(bodies[1]!).tools);
					prefix(bodies[1]!, bodies[2]!, "responses");
				}
			} finally {
				await f.cleanup();
			}
		},
	);
});
