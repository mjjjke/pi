import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	createProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type ModelCapabilities,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { completeSummarization } from "../src/core/compaction/compaction.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createVirtualModel } from "../src/core/virtual-models.ts";

function model(provider: string, capabilities?: ModelCapabilities): Model<"anthropic-messages"> {
	return {
		id: "claude-fable-5-2",
		name: "Fable",
		provider,
		api: "anthropic-messages",
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
		...(capabilities ? { capabilities } : {}),
	};
}

const expected = {
	progressUpdates: true,
	midConversationInstructionMessages: true,
	fastMode: { provider: "anthropic", body: { speed: "fast" } },
};

async function createRuntime(store = new InMemoryModelsStore()) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	return ModelRuntime.create({ credentials, modelsStore: store, modelsPath: null, allowModelNetwork: false });
}

afterEach(() => vi.restoreAllMocks());

describe("runtime fork capabilities", () => {
	it.each(["sdk", "constructor", "setModel", "scope"] as const)(
		"normalizes raw objects from %s before storing session state",
		async (ingress) => {
			const cwd = mkdtempSync(join(tmpdir(), "pi-fork-model-"));
			const runtime = await createRuntime();
			const source = model("anthropic");
			const settingsManager = SettingsManager.inMemory({});
			const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager });
			await resourceLoader.reload();
			const config = {
				cwd,
				agentDir: cwd,
				modelRuntime: runtime,
				settingsManager,
				resourceLoader,
				sessionManager: SessionManager.inMemory(cwd),
				noTools: "all" as const,
				model: ingress === "sdk" ? source : runtime.getModel("anthropic", "claude-opus-4-8"),
				scopedModels: ingress === "scope" ? [{ model: source }] : undefined,
			};
			const session =
				ingress === "constructor"
					? new AgentSession({
							...config,
							agent: new Agent({
								initialState: { model: source },
								streamFn: (model, context, options) => runtime.streamSimple(model, context, options),
							}),
							allowedToolNames: [],
						})
					: (await createAgentSession(config)).session;
			try {
				if (ingress === "setModel") await session.setModel(source);
				if (ingress === "scope") {
					expect(session.scopedModels[0].model.capabilities).toEqual(expected);
					await session.cycleModel();
				}
				expect(session.model?.capabilities).toEqual(expected);
				expect(source.capabilities).toBeUndefined();
				const explicit = model("anthropic", { progressUpdates: false });
				session.setScopedModels([{ model: explicit }]);
				expect(session.scopedModels[0].model.capabilities).toEqual({ ...expected, progressUpdates: false });
				expect(explicit.capabilities).toEqual({ progressUpdates: false });
				await session.setModel(explicit);
				expect(session.model?.capabilities).toEqual({ ...expected, progressUpdates: false });
				const virtual = createVirtualModel({ provider: "openai", id: "gpt-5.6-cyber", name: "Alias" });
				session.setScopedModels([{ model: virtual }]);
				expect(session.scopedModels[0].model).toEqual(virtual);
				expect(virtual.compat).toBeUndefined();
			} finally {
				session.dispose();
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	);

	it.each(["stream", "streamSimple", "providerStream", "providerStreamSimple", "summary"] as const)(
		"normalizes raw %s requests deterministically without changing the caller",
		async (method) => {
			const runtime = await createRuntime();
			const source = { ...model("anthropic"), id: "claude-fable-6" };
			const context = normalizeContext({
				systemPrompt: "Stable system",
				messages: [
					{ role: "developer", content: "Persisted standing value", timestamp: 0 },
					{ role: "user", content: "hi", timestamp: 1 },
				],
			});
			const bodies: string[] = [];
			const fetch: typeof globalThis.fetch = async (input, init) => {
				bodies.push(await new Request(input, init).text());
				return new Response(
					'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			};
			for (let i = 0; i < 3; i++) {
				const options = {
					fetch,
					apiKey: "test-key",
					maxRetries: 0,
					cacheRetention: "short" as const,
					maxTokens: 2048,
					thinkingEnabled: true,
					thinkingDisplay: "updates" as const,
					reasoning: "low" as const,
					sessionId: "stable",
				};
				const provider = runtime.getProvider("anthropic")!;
				const result =
					method === "summary"
						? await completeSummarization(source, context, options)
						: await (method === "providerStream"
								? provider.stream(source, context, options)
								: method === "providerStreamSimple"
									? provider.streamSimple(source, context, options)
									: runtime[method](source, context, options)
							).result();
				expect(result.stopReason, result.errorMessage).toBe("stop");
			}
			const body = JSON.parse(bodies[0]);
			expect(body.thinking.display).toBe("updates");
			expect(body.system.some((block: { text: string }) => block.text === "Persisted standing value")).toBe(true);
			expect(new Set(bodies).size).toBe(1);
			expect(source.capabilities).toBeUndefined();
		},
	);

	it("patches a newly fetched catalog model with null capabilities", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify([{ ...model("anthropic"), id: "claude-fable-6", capabilities: null }]), {
				headers: { "last-modified": new Date("2099-01-01").toUTCString() },
			}),
		);
		const runtime = await createRuntime();
		await runtime.getProvider("anthropic")?.refreshModels?.({
			allowNetwork: true,
			signal: new AbortController().signal,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
		});
		expect(runtime.getModel("anthropic", "claude-fable-6")?.capabilities).toEqual(expected);
	});

	it.each([
		undefined,
		{
			progressUpdates: false,
			midConversationInstructionMessages: false,
			fastMode: { provider: "anthropic", body: { speed: "explicit" } },
		},
	] satisfies (ModelCapabilities | undefined)[])(
		"fills cached remote models without overwriting explicit values: %j",
		async (capabilities) => {
			// Use a genuinely absent id: this checkout's pinned data already includes Fable 5.2.
			expect(getBuiltinModels("anthropic").some((entry) => entry.id === "claude-fable-6")).toBe(false);
			const source = { ...model("anthropic", capabilities), id: "claude-fable-6" };
			const store = new InMemoryModelsStore();
			await store.write("anthropic", { models: [source], lastModified: Date.parse("2099-01-01") });
			const runtime = await createRuntime(store);
			const patched = runtime.getModel("anthropic", source.id);
			expect(patched?.capabilities).toEqual(capabilities ?? expected);
			expect(runtime.getAllModels("anthropic").find((entry) => entry.id === source.id)).toEqual(patched);
			expect(
				(await runtime.getAvailable("anthropic")).find((entry) => entry.id === source.id)?.capabilities,
			).toEqual(capabilities ?? expected);
			expect((await store.read("anthropic"))?.models).toEqual([source]);
		},
	);

	it("fills extension and native models while leaving other provider identities unchanged", async () => {
		const runtime = await createRuntime();
		for (const providerId of ["anthropic", "openrouter"]) {
			const source = model(providerId);
			runtime.registerProvider(providerId, { models: [source] });
			await runtime.refresh({ allowNetwork: false, providers: [providerId] });
			expect(runtime.getModel(providerId, source.id)?.capabilities).toEqual(
				providerId === "anthropic" ? expected : undefined,
			);
			runtime.registerNativeProvider(
				createProvider({
					id: providerId,
					models: [source],
					auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
					api: {
						stream: () => {
							throw new Error("not used");
						},
						streamSimple: () => {
							throw new Error("not used");
						},
					},
				}),
			);
			await runtime.refresh({ allowNetwork: false, providers: [providerId] });
			expect(runtime.getModel(providerId, source.id)?.capabilities).toEqual(
				providerId === "anthropic" ? expected : undefined,
			);
			expect(source.capabilities).toBeUndefined();
		}
	});
});
