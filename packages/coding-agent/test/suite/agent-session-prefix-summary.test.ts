import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	normalizeContext,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectPromptPrefixStable } from "../../../ai/test/prompt-prefix-utils.ts";
import { prepareCompaction, SESSION_SUMMARY_PREAMBLE } from "../../src/core/compaction/compaction.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const SUMMARY = "## Goal\nContinue work\n## Next Steps\n1. Finish";
const fixtures: Harness[] = [];
afterEach(() => {
	for (const h of fixtures.splice(0)) h.cleanup();
});
async function setup(options: HarnessOptions = {}) {
	const h = await createHarness({
		api: "anthropic-messages",
		settings: { compaction: { enabled: false, keepRecentTokens: 30 } },
		...options,
	});
	fixtures.push(h);
	h.session.agent.sessionId = h.session.sessionId;
	h.session.agent.state.model = { ...h.session.model!, promptCache: { short: 300, long: 3600 } };
	await h.session.bindExtensions({});
	const calls: Array<{ context: Context; options: SimpleStreamOptions }> = [];
	const original = h.session.agent.streamFunction;
	const stream: StreamFn = (model, context, options) => {
		calls.push({ context: structuredClone(context), options: { ...options } });
		return original(model, context, options);
	};
	h.session.agent.streamFunction = stream;
	h.setResponses([fauxAssistantMessage("old answer"), fauxAssistantMessage("kept answer")]);
	await h.session.prompt(`OLD ${"history ".repeat(4000)}`);
	await h.session.prompt(`KEPT ${"tail ".repeat(50)}`);
	return { h, calls };
}
function isFork(context: Context) {
	return JSON.stringify(context.messages.at(-1)).includes(SESSION_SUMMARY_PREAMBLE);
}
async function defaultCompaction(h: Harness, reason: "threshold" | "overflow", signal = new AbortController().signal) {
	const prep = prepareCompaction(
		h.sessionManager.getBranch(),
		h.settingsManager.getCompactionSettings(h.session.model),
	);
	expect(prep).toBeDefined();
	// biome-ignore lint/complexity/useLiteralKeys: exercise the private blocking entry point without widening its API.
	return h.session["_runDefaultCompaction"](prep!, h.session.model!, undefined, signal, reason);
}

async function assertForkAvailable() {
	const { h, calls } = await setup();
	h.setResponses([fauxAssistantMessage(SUMMARY)]);
	await h.session.compact();
	expect(isFork(calls[2].context)).toBe(true);
}

describe("session prefix-sharing compaction", () => {
	it("reads at least 90% of the faux fork prompt from cache and adds only the compaction entry", async () => {
		const { h, calls } = await setup();
		const onResponse = vi.fn();
		h.session.agent.onResponse = onResponse;
		const branch = structuredClone(h.sessionManager.getBranch());
		h.setResponses([fauxAssistantMessage(SUMMARY)]);
		const result = await h.session.compact();
		expect(calls).toHaveLength(3);
		expect(isFork(calls[2].context)).toBe(true);
		const usage = result.usage!;
		expect(usage.cacheRead).toBeGreaterThanOrEqual(0.9 * (usage.input + usage.cacheRead + usage.cacheWrite));
		expect(h.sessionManager.getBranch().slice(0, -1)).toEqual(branch);
		expect(h.sessionManager.getBranch().at(-1)?.type).toBe("compaction");
		expect(onResponse).not.toHaveBeenCalled();
		expect(
			h.session.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes(SUMMARY)),
		).toBe(false);
	});
	it("matches every session request option except an explicit non-request allowlist", async () => {
		const { h, calls } = await setup({ models: [{ id: "reasoning-faux", reasoning: true }] });
		h.session.setThinkingLevel("medium");
		h.session.agent.thinkingBudgets = { medium: 2048 };
		h.session.agent.maxRetryDelayMs = 987;
		h.session.agent.transport = "sse";
		h.setResponses([fauxAssistantMessage("latest"), fauxAssistantMessage(SUMMARY)]);
		await h.session.prompt("one more input");
		await h.session.compact();
		const sessionOptions = calls[2].options,
			forkOptions = calls[3].options;
		expect(isFork(calls[3].context)).toBe(true);
		// Signals/auth belong to the job; response observers do not shape a request. The
		// agent loop's default identity is supplied by the SDK wrapper, not by compaction.
		const excluded = new Set([
			"signal",
			"apiKey",
			"headers",
			"env",
			"onResponse",
			"onProviderStreamEvent",
			"identity",
			"model",
			"toolExecution",
			"beforeToolCall",
			"afterToolCall",
			"finishTurn",
			"prepareRequest",
			"getInstructionMessages",
			"getTools",
			"getMessageAdmissionToken",
			"getMessageRiders",
			"prepareNextTurn",
			"convertToLlm",
			"transformContext",
			"getApiKey",
			"getSteeringMessages",
			"getFollowUpMessages",
			"hasQueuedMessages",
		]);
		for (const key of Object.keys(sessionOptions) as Array<keyof SimpleStreamOptions>) {
			if (!excluded.has(key)) {
				expect(forkOptions, key).toHaveProperty(key);
				expect(forkOptions[key], key).toEqual(sessionOptions[key]);
			}
		}
		expect(sessionOptions.reasoning).toBe("medium");
		expect(forkOptions.disableContinuation).toBe(true);
		expect(forkOptions).not.toHaveProperty("cacheRetention");
	});
	it("freezes background context and request policy at launch while keeping later turns on install", async () => {
		const { h, calls } = await setup();
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let entered!: () => void;
		const started = new Promise<void>((r) => {
			entered = r;
		});
		const transform = h.session.agent.transformContext;
		h.session.agent.transformContext = async (messages, signal) => {
			entered();
			await gate;
			return transform ? transform(messages, signal) : messages;
		};
		h.session.agent.thinkingBudgets = { medium: 111 };
		h.setResponses([fauxAssistantMessage("later answer"), fauxAssistantMessage(SUMMARY)]);
		expect(h.session.startBackgroundCompaction({ source: "user" }).status).toBe("started");
		await started;
		h.session.agent.transformContext = transform;
		h.session.agent.thinkingBudgets = { medium: 222 };
		await h.session.prompt("LATER-INPUT");
		release();
		await vi.waitFor(() => expect(h.session.getBackgroundCompaction()?.phase).toBe("ready"));
		const fork = calls.find((call) => isFork(call.context));
		expect(fork).toBeDefined();
		expect(JSON.stringify(fork!.context)).not.toContain("LATER-INPUT");
		expect(fork!.options.thinkingBudgets).toEqual({ medium: 111 });
		const installed = await h.session.compactNow();
		expect(installed.status).toBe("applied");
		expect(JSON.stringify(h.session.messages)).toContain("LATER-INPUT");
		expect(JSON.stringify(h.session.messages)).toContain("later answer");
	});
	it("forks again when the new cut lies inside the previous compaction's kept range", async () => {
		const { h, calls } = await setup({
			settings: { compaction: { enabled: false, keepRecentTokens: 60 } },
		});
		h.setResponses([fauxAssistantMessage(SUMMARY)]);
		await h.session.compact();
		expect(isFork(calls[2].context)).toBe(true);
		h.setResponses([fauxAssistantMessage("small answer"), fauxAssistantMessage(SUMMARY)]);
		await h.session.prompt("small input");
		const settings = { ...h.settingsManager.getCompactionSettings(h.session.model), keepRecentTokens: 8 };
		vi.spyOn(h.settingsManager, "getCompactionSettings").mockReturnValue(settings);
		const branch = h.sessionManager.getBranch();
		const prep = prepareCompaction(branch, settings)!;
		expect(prep).toBeDefined();
		const previousIndex = branch.findIndex((entry) => entry.type === "compaction");
		expect(branch.findIndex((entry) => entry.id === prep.firstKeptEntryId)).toBeLessThan(previousIndex);
		await h.session.compact();
		expect(isFork(calls[4].context)).toBe(true);
		expect(calls).toHaveLength(5);
	});
	it("rejects a faux tool-call summary without invoking execution or tool_call hooks", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }], details: {} }));
		const hook = vi.fn();
		const { h, calls } = await setup({
			tools: [{ name: "probe", label: "probe", description: "probe", parameters: Type.Object({}), execute }],
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", hook);
				},
			],
		});
		const before = h.sessionManager.getBranch().length;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("fallback"),
		]);
		const result = await h.session.compact();
		expect(isFork(calls[2].context)).toBe(true);
		expect(isFork(calls[3].context)).toBe(false);
		expect(result.summary).toContain("fallback");
		expect(execute).not.toHaveBeenCalled();
		expect(hook).not.toHaveBeenCalled();
		expect(h.sessionManager.getBranch()).toHaveLength(before + 1);
	});
	it.each(["blocking", "background"])(
		"the actual last session Anthropic body is a byte prefix of the %s fork body",
		async (mode) => {
			const { h, calls } = await setup();
			h.setResponses([fauxAssistantMessage(SUMMARY)]);
			if (mode === "blocking") await h.session.compact();
			else {
				expect(h.session.startBackgroundCompaction({ source: "user" }).status).toBe("started");
				await vi.waitFor(() => expect(h.session.getBackgroundCompaction()?.phase).toBe("ready"));
			}
			expect(isFork(calls[2].context)).toBe(true);
			const bodies: string[] = [];
			for (const call of [calls[1], calls[2]]) {
				const response = await streamAnthropic(
					{
						...h.session.model!,
						api: "anthropic-messages",
						compat: undefined,
						baseUrl: "https://offline.invalid",
					},
					normalizeContext(call.context),
					{
						...call.options,
						apiKey: "offline-test",
						disableContinuation: true,
						maxRetries: 0,
						cacheRetention: "short",
						fetch: async (input, init) => {
							bodies.push(await new Request(input, init).text());
							return new Response(
								'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
								{ headers: { "content-type": "text/event-stream" } },
							);
						},
					},
				).result();
				expect(response.stopReason, response.errorMessage).toBe("stop");
			}
			expectPromptPrefixStable(bodies[0], bodies[1], {
				fixed: ["system", "tools"],
				history: "messages",
				normalize: (raw, path, previousLength) =>
					path === `messages[${previousLength - 1}]`
						? raw.replace(/,"cache_control":\{"type":"ephemeral"\}(\}\]\})$/, "$1")
						: raw,
			});
		},
	);
	it("normalizes a build exception concurrent with cancellation to AbortError", async () => {
		const { h, calls } = await setup();
		const controller = new AbortController();
		h.session.agent.transformContext = async () => {
			controller.abort();
			throw new Error("hook stopped");
		};
		await expect(defaultCompaction(h, "threshold", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(calls).toHaveLength(2);
	});
	it("blocking threshold compaction uses the fork too", async () => {
		const { h, calls } = await setup();
		h.setResponses([fauxAssistantMessage(SUMMARY)]);
		await defaultCompaction(h, "threshold");
		expect(isFork(calls[2].context)).toBe(true);
	});
	it("extension-provided compaction sends no fork request", async () => {
		await assertForkAvailable();
		const { h, calls } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "hook",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		await h.session.compact();
		expect(calls).toHaveLength(2);
		expect(h.sessionManager.getBranch().at(-1)).toMatchObject({ type: "compaction", summary: "hook" });
	});
	it("non-Anthropic and overflow requests stay serialized", async () => {
		await assertForkAvailable();
		const { h, calls } = await setup({ api: "prefix-faux-other" });
		h.setResponses([fauxAssistantMessage("fallback")]);
		await h.session.compact();
		expect(isFork(calls[2].context)).toBe(false);
		const second = await setup();
		second.h.setResponses([fauxAssistantMessage("overflow fallback")]);
		await defaultCompaction(second.h, "overflow");
		expect(isFork(second.calls[2].context)).toBe(false);
	});
	it("virtual selections remain serialized even when routed to Anthropic", async () => {
		await assertForkAvailable();
		const { h, calls } = await setup();
		h.session.modelRuntime.registerVirtualModel({
			provider: "virtual-prefix",
			id: "virtual",
			name: "Virtual",
			route: async () => ({ model: h.models[0], thinkingLevel: "off" }),
		});
		h.session.agent.state.model = h.session.modelRuntime.getModel("virtual-prefix", "virtual")!;
		h.setResponses([fauxAssistantMessage("virtual fallback")]);
		await h.session.compact();
		expect(isFork(calls[2].context)).toBe(false);
	});
	it("a context hook removing the kept point or throwing uses the serialized path", async () => {
		await assertForkAvailable();
		for (const mode of ["remove", "throw"]) {
			const { h, calls } = await setup();
			h.session.agent.transformContext = async () => {
				if (mode === "throw") throw new Error("hook failure");
				return [];
			};
			h.setResponses([fauxAssistantMessage("fallback")]);
			await h.session.compact();
			expect(isFork(calls[2].context)).toBe(false);
		}
	});
});
