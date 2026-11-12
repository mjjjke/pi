import {
	createProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type ModelCapabilities,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

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
