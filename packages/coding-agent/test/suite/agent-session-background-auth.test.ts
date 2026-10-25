import type { StreamFn } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRouteRequest } from "../../src/core/virtual-models.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function setup(hook?: Promise<void>) {
	const h = await createHarness({
		models: [{ id: "summary", contextWindow: 20000, maxTokens: 1000, reasoning: true }],
		settings: {
			compaction: { keepRecentTokens: 1, reserveTokens: 1000 },
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
		},
		extensionFactories: hook
			? [
					(pi) => {
						pi.on("session_before_compact", () => hook);
					},
				]
			: undefined,
	});
	harnesses.push(h);
	h.sessionManager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 1 });
	h.sessionManager.appendMessage({ role: "user", content: "history".repeat(3000), timestamp: 2 });
	const model = h.getModel();
	h.sessionManager.appendMessage({
		...fauxAssistantMessage("history reply"),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	h.sessionManager.appendMessage({ role: "user", content: "split prefix".repeat(200), timestamp: 3 });
	h.sessionManager.appendMessage({
		...fauxAssistantMessage("kept reply"),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	h.session.refreshContext();
	return h;
}

describe("Background compaction request snapshot and per-call authentication", () => {
	it("refreshes auth for split calls and retries while freezing stream, model, transport and retry policy", async () => {
		const h = await setup();
		const first = deferred();
		const release = deferred();
		const originalAuth = h.session.modelRuntime.getAuth.bind(h.session.modelRuntime);
		let authCalls = 0;
		vi.spyOn(h.session.modelRuntime, "getAuth").mockImplementation(async (model, overrides) => {
			const result = await originalAuth(model, overrides);
			return {
				...result!,
				auth: {
					...result!.auth,
					apiKey: `synthetic-${++authCalls}`,
					headers: { "x-synthetic-call": String(authCalls) },
					baseUrl: `https://faux.invalid/${authCalls}`,
				},
				env: { SYNTHETIC: String(authCalls) },
			};
		});
		const calls: Array<{
			modelId: string;
			url: string;
			key?: string;
			header?: string;
			env?: string;
			transport?: string;
			cache?: string;
		}> = [];
		const stream: StreamFn = async (model, context, options) => {
			calls.push({
				modelId: model.id,
				url: model.baseUrl,
				key: options?.apiKey,
				header: options?.headers?.["x-synthetic-call"] ?? undefined,
				env: options?.env?.SYNTHETIC,
				transport: options?.transport,
				cache: options?.cacheRetention,
			});
			if (calls.length === 1) {
				first.resolve();
				await release.promise;
			}
			return streamSimple(model, context, options);
		};
		h.session.agent.streamFunction = stream;
		h.session.agent.transport = "sse";
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 synthetic retry" }),
			fauxAssistantMessage("history summary"),
			fauxAssistantMessage("prefix summary"),
		]);
		h.session.startBackgroundCompaction({ source: "user" });
		await first.promise;
		h.session.agent.transport = "websocket";
		h.session.agent.state.model = { ...h.getModel(), id: "changed", maxTokens: 7 };
		h.session.agent.streamFunction = () => {
			throw new Error("live stream must not be used");
		};
		h.settingsManager.applyOverrides({ retry: { enabled: false, maxRetries: 0 } });
		release.resolve();
		await vi.waitFor(() => expect(h.session.getBackgroundCompaction()?.phase).toBe("ready"));
		expect(authCalls).toBe(3);
		expect(calls).toEqual(
			[1, 2, 3].map((n) => ({
				modelId: "summary",
				url: `https://faux.invalid/${n}`,
				key: `synthetic-${n}`,
				header: String(n),
				env: String(n),
				transport: "sse",
				cache: "none",
			})),
		);
		expect(JSON.stringify(h.sessionManager.getEntries())).not.toContain("synthetic-");
	});

	it("routes a frozen virtual snapshot once, then authenticates each physical call without rerouting", async () => {
		const hook = deferred();
		const h = await setup(hook.promise);
		const route = vi.fn((_request: ModelRouteRequest) => ({ model: h.getModel(), thinkingLevel: "high" as const }));
		h.session.modelRuntime.registerVirtualModel({
			provider: "router",
			id: "auto",
			name: "Auto",
			thinkingLevels: ["low", "high"],
			route,
		});
		h.session.agent.state.model = h.session.modelRuntime.getModel("router", "auto")!;
		h.session.agent.state.thinkingLevel = "high";
		const auth = vi.spyOn(h.session.modelRuntime, "getAuth");
		h.setResponses([fauxAssistantMessage("history summary"), fauxAssistantMessage("prefix summary")]);
		h.session.startBackgroundCompaction({ source: "user" });
		h.session.agent.state.model = { ...h.getModel(), id: "changed" };
		h.session.agent.state.thinkingLevel = "off";
		h.sessionManager.appendCustomMessageEntry("task", "after launch", false);
		hook.resolve();
		await vi.waitFor(() => expect(h.session.getBackgroundCompaction()?.phase).toBe("ready"));
		expect(route).toHaveBeenCalledTimes(1);
		expect(route.mock.calls[0]?.[0]).toMatchObject({ thinkingLevel: "high", reason: "direct" });
		expect(JSON.stringify(route.mock.calls)).not.toContain("after launch");
		expect(auth).toHaveBeenCalledTimes(2);
		for (const [model] of auth.mock.calls) expect(model).toMatchObject({ id: "summary" });
	});

	it("does not send after cancellation during a signal-ignoring auth lookup", async () => {
		const h = await setup();
		const entered = deferred();
		const release = deferred();
		const original = h.session.modelRuntime.getAuth.bind(h.session.modelRuntime);
		vi.spyOn(h.session.modelRuntime, "getAuth").mockImplementation(async (model) => {
			entered.resolve();
			await release.promise;
			return original(model);
		});
		const stream = vi.fn<StreamFn>(streamSimple);
		h.session.agent.streamFunction = stream;
		h.session.startBackgroundCompaction({ source: "user" });
		await entered.promise;
		h.session.cancelBackgroundCompaction();
		release.resolve();
		await vi.waitFor(() =>
			expect(h.eventsOfType("session_background_compaction").some((event) => event.phase === "discarded")).toBe(
				true,
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(stream).not.toHaveBeenCalled();
		expect(h.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
	});
});
