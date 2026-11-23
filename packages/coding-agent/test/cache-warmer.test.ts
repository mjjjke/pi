import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	getCacheWarmingDelayMs,
	getPromptCacheTtlMs,
	isCacheWarmingReplayable,
	type Model,
	type ModelsSimpleStreamOptions,
	normalizeContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	CacheWarmer,
	type CacheWarmingAction,
	type CacheWarmingDecision,
	type CacheWarmingDecisionEvent,
	type CacheWarmRequest,
	formatCacheWarmingStatus,
	formatCacheWarmingUsage,
} from "../src/core/cache-warmer.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { type SessionEntry, SessionManager, type UsageEntry } from "../src/core/session-manager.ts";
import type { CacheWarmingMode } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const adaptiveModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-opus-4-6"),
	promptCache: { short: 300, long: 3600 },
};
const budgetModel: Model<Api> = {
	...getBuiltinModel("anthropic", "claude-sonnet-4-5"),
	promptCache: { short: 300, long: 3600 },
};
const openaiModel: Model<Api> = {
	...getBuiltinModel("openai", "gpt-5"),
	promptCache: { short: 300, long: 86_400 },
};
const unknownModel: Model<Api> = { ...adaptiveModel, promptCache: undefined };

const warmUsage: Usage = {
	input: 0,
	output: 1,
	cacheRead: 100,
	cacheWrite: 0,
	totalTokens: 101,
	cost: { input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.01 },
};

function response(model: Model<Api>, stopReason: AssistantMessage["stopReason"] = "length"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: warmUsage,
		stopReason,
		timestamp: 0,
	};
}

function branchWithPrompt(promptTokens: number): SessionEntry[] {
	return [
		{
			type: "message",
			id: "a",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: {
				...response(adaptiveModel),
				usage: { ...warmUsage, output: 10, cacheRead: promptTokens, totalTokens: promptTokens + 10 },
			},
		},
	];
}

function fakeRuntime(
	options: {
		result?: (model: Model<Api>) => Promise<AssistantMessage>;
		decide?: (event: CacheWarmingDecisionEvent) => CacheWarmingAction | Promise<CacheWarmingAction>;
		mode?: CacheWarmingMode;
		maxIdleHours?: number;
		branch?: SessionEntry[];
	} = {},
) {
	const calls: Array<{ model: Model<Api>; options: ModelsSimpleStreamOptions | undefined }> = [];
	const events: CacheWarmingDecisionEvent[] = [];
	const warmedEntries: UsageEntry[] = [];
	const usageManager = SessionManager.inMemory();
	const appendUsage = vi.fn(usageManager.appendUsage.bind(usageManager));
	const state = { mode: options.mode ?? "idle", branch: options.branch ?? branchWithPrompt(100_000) };
	const warmer = new CacheWarmer(
		{
			streamSimple: (model, _context, streamOptions) => {
				calls.push({ model, options: streamOptions });
				return {
					result: () => (options.result ?? (async (m: Model<Api>) => response(m)))(model),
				} as unknown as AssistantMessageEventStream;
			},
		},
		{ appendUsage, getBranch: () => state.branch },
		() => state.mode,
		async (event) => {
			events.push(event);
			return options.decide?.(event) ?? event.action;
		},
		options.maxIdleHours === undefined ? undefined : () => options.maxIdleHours!,
	);
	warmer.onWarmed = (entry) => warmedEntries.push(entry);
	return { warmer, calls, events, warmedEntries, appendUsage, state };
}

function request(model: Model<Api> = adaptiveModel, options: ModelsSimpleStreamOptions = {}): CacheWarmRequest {
	return { model, context: normalizeContext({ messages: [] }), options };
}

const current = () => true;

afterEach(() => vi.useRealTimers());

describe("cache warming", () => {
	it("derives eligibility and timing from retention and provider behavior", () => {
		expect([
			getPromptCacheTtlMs(adaptiveModel, undefined),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(adaptiveModel, { cacheRetention: "none" }),
			getPromptCacheTtlMs(adaptiveModel, { env: { PI_CACHE_RETENTION: "long" } }),
			getPromptCacheTtlMs(openaiModel, { cacheRetention: "long" }),
			getPromptCacheTtlMs(unknownModel, undefined),
		]).toEqual([300_000, 3_600_000, undefined, 3_600_000, 86_400_000, undefined]);
		expect([getCacheWarmingDelayMs(300_000), getCacheWarmingDelayMs(60_000), getCacheWarmingDelayMs(10_000)]).toEqual(
			[270_000, 50_000, undefined],
		);
		expect([
			isCacheWarmingReplayable(budgetModel, { reasoning: "medium" }),
			isCacheWarmingReplayable(budgetModel, undefined),
			isCacheWarmingReplayable(adaptiveModel, { reasoning: "medium" }),
			isCacheWarmingReplayable(openaiModel, { reasoning: "medium" }),
		]).toEqual([false, true, true, true]);
	});

	it("replays profitable requests and preserves options across repeated refreshes", async () => {
		vi.useFakeTimers();
		const { warmer, calls, events, appendUsage, warmedEntries } = fakeRuntime();
		const signal = new AbortController().signal;
		const transformHeaders = async () => ({});

		warmer.start(request(adaptiveModel, { reasoning: "high", signal, sessionId: "s", transformHeaders }), current);
		await vi.advanceTimersByTimeAsync(270_000);

		expect(calls[0]).toMatchObject({
			model: adaptiveModel,
			options: {
				reasoning: "high",
				sessionId: "s",
				transformHeaders,
				maxTokens: 1,
				maxRetries: 0,
				disableContinuation: true,
			},
		});
		expect(calls[0].options?.signal).not.toBe(signal);
		expect(events[0]).toMatchObject({
			type: "cache_warming_decision",
			continuationProbability: 1,
			action: "warm",
		});
		expect(events[0].missCost).toBeCloseTo(0.575);
		expect(events[0].warmCost).toBeCloseTo(0.050025);
		expect(appendUsage).toHaveBeenCalledWith(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			warmUsage,
			undefined,
		);
		expect(warmedEntries).toEqual([appendUsage.mock.results[0]?.value]);

		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(2);
		warmer.cancel();
	});

	it.each(["long", "short"] as const)("prices idle refreshes using the run's %s retention", async (cacheRetention) => {
		vi.useFakeTimers();
		const probability = 0.15;
		const { input, output, cacheRead, cacheWrite } = adaptiveModel.cost;
		const threshold = (write: number) =>
			((0.05 + output / 1_000_000) * 1_000_000) / (probability * (write - cacheRead) - cacheRead);
		const promptTokens = Math.ceil((threshold(cacheWrite) + threshold(input * 2)) / 2);
		const { warmer, calls, events } = fakeRuntime({ branch: branchWithPrompt(promptTokens) });
		warmer.start(request(adaptiveModel, { cacheRetention }), current);
		warmer.onAgentSettled();
		const action = cacheRetention === "long" ? "warm" : "stop";
		expect(warmer.status.decision?.action).toBe(action);
		const delay = getCacheWarmingDelayMs(getPromptCacheTtlMs(adaptiveModel, { cacheRetention })!)!;
		await vi.advanceTimersByTimeAsync(delay);
		expect(events[0].action).toBe(action);
		expect(events[0].missCost).toBeCloseTo(
			(((cacheRetention === "long" ? input * 2 : cacheWrite) - cacheRead) * promptTokens) / 1_000_000,
		);
		expect(calls).toHaveLength(cacheRetention === "long" ? 1 : 0);
		if (cacheRetention === "long") expect(calls[0].options?.cacheRetention).toBe("long");
		warmer.cancel();
	});

	it.each([
		{ cacheRetention: "short" as const },
		{},
		{ cacheRetention: "short" as const, env: { PI_CACHE_RETENTION: "long" } },
	])("caps short-retention idle warming at 30 minutes with a 16-hour setting: %j", async (options) => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime({ maxIdleHours: 16, branch: branchWithPrompt(400_000) });
		warmer.start(request(adaptiveModel, options), current);
		warmer.onAgentSettled();
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(calls).toHaveLength(6);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "0.5-hour idle limit reached" });
		await vi.advanceTimersByTimeAsync(16 * 3_600_000);
		expect(calls).toHaveLength(6);
	});

	it("applies the short idle cap when a streaming run settles after 30 minutes", async () => {
		vi.useFakeTimers();
		const { warmer, calls } = fakeRuntime({ maxIdleHours: 16, branch: branchWithPrompt(400_000) });
		warmer.start(request(adaptiveModel, { cacheRetention: "short" }), current);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(calls).toHaveLength(6);
		expect(warmer.status.state).toBe("scheduled");
		warmer.onAgentSettled();
		expect(warmer.status.reason).toBe("0.5-hour idle limit reached");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(calls).toHaveLength(6);
	});

	it("uses retention rather than the model TTL to choose the idle cap", async () => {
		vi.useFakeTimers();
		const { warmer, calls } = fakeRuntime({ maxIdleHours: 16, branch: branchWithPrompt(400_000) });
		warmer.start(request({ ...adaptiveModel, promptCache: { short: 3600 } }), current);
		warmer.onAgentSettled();
		expect(warmer.status.reason).toBe("0.5-hour idle limit reached");
		await vi.advanceTimersByTimeAsync(16 * 3_600_000);
		expect(calls).toHaveLength(0);
	});

	it("expires short refresh evidence even when the summary uses long retention", async () => {
		vi.useFakeTimers();
		const { warmer } = fakeRuntime({ branch: branchWithPrompt(400_000) });
		warmer.start(request(adaptiveModel, { cacheRetention: "short" }), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(warmer.hasWarmCache(adaptiveModel, 3_600_000)).toBe(true);
		vi.setSystemTime(Date.now() + 299_999);
		expect(warmer.hasWarmCache(adaptiveModel, 3_600_000)).toBe(true);
		vi.setSystemTime(Date.now() + 1);
		expect(warmer.hasWarmCache(adaptiveModel, 3_600_000)).toBe(false);
		warmer.cancel();
	});

	it.each([
		{ hours: 16, options: { cacheRetention: "long" as const } },
		{ hours: 2.7, options: { cacheRetention: "long" as const } },
		{ hours: 2.7, options: { env: { PI_CACHE_RETENTION: "long" } } },
	])("warms idle hourly caches at every delay through the cap: %j", async ({ hours, options }) => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls, events, warmedEntries } = fakeRuntime({
			maxIdleHours: hours === 16 ? undefined : hours,
			branch: branchWithPrompt(400_000),
		});
		warmer.start(request(adaptiveModel, options), current);
		warmer.onAgentSettled();
		const delay = 54 * 60_000;
		const count = Math.floor((hours * 3_600_000) / delay);
		for (let i = 1; i <= count; i++) {
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(calls).toHaveLength(i - 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(calls).toHaveLength(i);
		}
		expect(events.every((event) => event.continuationProbability === 0.15)).toBe(true);
		expect(warmedEntries).toHaveLength(count);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: `${hours}-hour idle limit reached` });
		expect(formatCacheWarmingStatus(warmer.status)).toBe(`Inactive (${hours}-hour idle limit reached)`);
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(calls).toHaveLength(count);
	});

	it("bounds successful warm evidence by model, prefix and retention even after the idle cap", async () => {
		vi.useFakeTimers();
		const { warmer } = fakeRuntime({ maxIdleHours: 0.9, branch: branchWithPrompt(400_000) });
		let matches = true;
		warmer.start(request(adaptiveModel, { cacheRetention: "long" }), () => matches);
		warmer.onAgentSettled();
		expect(warmer.hasWarmCache(adaptiveModel, 3_600_000)).toBe(false);
		await vi.advanceTimersByTimeAsync(54 * 60_000);
		expect(warmer.status.reason).toBe("0.9-hour idle limit reached");
		expect(warmer.hasWarmCache(adaptiveModel, 3_600_000)).toBe(true);
		expect(warmer.hasWarmCache(budgetModel, 3_600_000)).toBe(false);
		matches = false;
		expect(warmer.hasWarmCache(adaptiveModel, 3_600_000)).toBe(false);
		matches = true;
		vi.setSystemTime(Date.now() + 300_000);
		expect(warmer.hasWarmCache(adaptiveModel, 300_000)).toBe(false);
		expect(warmer.hasWarmCache(adaptiveModel, 3_600_000)).toBe(true);
		vi.setSystemTime(Date.now() + 3_300_000);
		expect(warmer.hasWarmCache(adaptiveModel, 3_600_000)).toBe(false);
		warmer.start(request(), current);
		expect(warmer.hasWarmCache(adaptiveModel, 3_600_000)).toBe(false);
		warmer.cancel();
	});

	it("keeps the one-hour streaming limit and rejects small idle contexts", async () => {
		vi.useFakeTimers();
		const streaming = fakeRuntime({ maxIdleHours: 16 });
		streaming.warmer.start(request(adaptiveModel, { cacheRetention: "long" }), current);
		await vi.advanceTimersByTimeAsync(54 * 60_000);
		expect(streaming.calls).toHaveLength(1);
		expect(streaming.warmer.status.reason).toBe("one-hour safety limit reached");
		expect(streaming.events[0].continuationProbability).toBe(1);

		const small = fakeRuntime({ branch: branchWithPrompt(5_000) });
		small.warmer.start(request(adaptiveModel, { cacheRetention: "long" }), current);
		small.warmer.onAgentSettled();
		await vi.advanceTimersByTimeAsync(54 * 60_000);
		expect(small.calls).toHaveLength(0);
		expect(small.warmer.status.reason).toBe("expected savings below threshold");
	});

	it("does not issue refreshes after their safe deadline", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime();
		warmer.start(request(), current);

		// A five-minute cache is scheduled for 4m30s and retains 15 seconds of
		// the 30-second expiry margin. Simulate a timer delayed by sleep.
		vi.setSystemTime(285_001);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("rechecks the deadline after an extension decision", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const { warmer, calls } = fakeRuntime({
			decide: async () => {
				await Promise.resolve();
				vi.setSystemTime(285_001);
				return "warm" as const;
			},
		});
		warmer.start(request(), current);
		vi.clearAllTimers();
		const internal = warmer as unknown as { run: object | undefined; refresh: (run: object) => Promise<void> };
		if (!internal.run) throw new Error("expected an active cache-warming run");
		await internal.refresh(internal.run);

		expect(calls).toHaveLength(0);
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache refresh deadline missed" });
	});

	it("applies economic decisions and extension overrides", async () => {
		vi.useFakeTimers();
		const unprofitable = fakeRuntime({ branch: branchWithPrompt(5_000) });
		unprofitable.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unprofitable.calls).toHaveLength(0);
		expect(unprofitable.warmer.status).toMatchObject({
			state: "inactive",
			decision: { action: "stop", economicsAvailable: true },
			extensionOverride: false,
		});

		const forced = fakeRuntime({ branch: branchWithPrompt(5_000), decide: () => "warm" });
		forced.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(forced.calls).toHaveLength(1);
		expect(forced.warmedEntries[0]?.note).toBe("extension override");
		forced.warmer.cancel();

		const vetoed = fakeRuntime({ decide: () => "stop" });
		vetoed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(vetoed.calls).toHaveLength(0);
		expect(vetoed.warmer.status).toMatchObject({ state: "inactive", extensionOverride: true });

		const unavailable = fakeRuntime({ branch: branchWithPrompt(0) });
		unavailable.warmer.start(request(), current);
		expect(unavailable.warmer.status).toMatchObject({
			state: "inactive",
			reason: "cache economics unavailable",
		});
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unavailable.calls).toHaveLength(0);
	});

	it("stops for unsupported requests, context changes, and mode changes", async () => {
		vi.useFakeTimers();
		const unsupported = fakeRuntime();
		unsupported.state.mode = "off";
		unsupported.warmer.start(request(), current);
		expect(unsupported.warmer.status.reason).toBe("cache warming disabled");
		unsupported.state.mode = "idle";
		unsupported.warmer.start(request(unknownModel), current);
		expect(unsupported.warmer.status.reason).toBe("cache lifetime unavailable");
		unsupported.warmer.start(request(budgetModel, { reasoning: "high" }), current);
		expect(unsupported.warmer.status.reason).toBe("request cannot be replayed safely");

		let stillCurrent = true;
		unsupported.warmer.start(request(), () => stillCurrent);
		stillCurrent = false;
		expect(unsupported.warmer.status.reason).toBe("conversation context changed");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unsupported.calls).toHaveLength(0);

		unsupported.warmer.start(request(), current);
		unsupported.state.mode = "off";
		await vi.advanceTimersByTimeAsync(270_000);
		expect(unsupported.calls).toHaveLength(0);

		const streaming = fakeRuntime({ mode: "streaming", branch: branchWithPrompt(400_000) });
		streaming.warmer.start(request(), current);
		streaming.warmer.onAgentSettled();
		expect(streaming.warmer.status.reason).toBe("agent run settled");
	});

	it("aborts replaced requests and does not record failed refreshes", async () => {
		vi.useFakeTimers();
		let release!: () => void;
		const pending = fakeRuntime({
			result: (model) =>
				new Promise((resolve) => {
					release = () => resolve(response(model));
				}),
		});
		pending.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		pending.warmer.start(request(), current);
		expect(pending.calls[0].options?.signal?.aborted).toBe(true);
		release();
		pending.warmer.cancel();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(pending.calls).toHaveLength(1);

		const failed = fakeRuntime({ result: async (model) => response(model, "error") });
		failed.warmer.start(request(), current);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(failed.appendUsage).not.toHaveBeenCalled();
		expect(failed.warmer.hasWarmCache(adaptiveModel, 300_000)).toBe(false);
		failed.warmer.cancel();
	});

	it("formats status and usage entries", () => {
		const decision: CacheWarmingDecision = {
			phase: "idle",
			warmCost: 0.013,
			missCost: 0.621,
			continuationProbability: 0.6,
			expectedSavings: 0.36,
			economicsAvailable: true,
			action: "warm",
		};
		expect(formatCacheWarmingStatus({ state: "scheduled", nextWarmAt: 222_000, decision }, 0)).toBe(
			"Decision in 3m 42s (60% continuation probability, expected savings $0.360 >= $0.050 -> warm)",
		);
		const usage = {
			...warmUsage,
			cost: { input: 0.00004, output: 0.00005, cacheRead: 0.02940725, cacheWrite: 0, total: 0.02949725 },
		};
		const entry = SessionManager.inMemory().appendUsage(
			"cache_warm",
			adaptiveModel.provider,
			adaptiveModel.id,
			usage,
			"extension override",
		);
		expect(formatCacheWarmingUsage(entry.usage.cost.total, entry.note)).toBe(
			"Cache warmed (extension override): $0.029497",
		);
	});
});

describe("ExtensionRunner.emitCacheWarmingDecision", () => {
	it("uses the last extension override", async () => {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const factories: ExtensionFactory[] = [
			(pi) => {
				pi.on("cache_warming_decision", () => ({ action: "warm" }));
			},
			(pi) => {
				pi.on("cache_warming_decision", () => ({ action: "stop" }));
			},
		];
		const extensions = [];
		for (const factory of factories) {
			extensions.push(await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime));
		}
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner(extensions, runtime, process.cwd(), SessionManager.inMemory(), modelRegistry);
		const event: CacheWarmingDecisionEvent = {
			type: "cache_warming_decision",
			warmCost: 0.05,
			missCost: 0.5,
			continuationProbability: 0.15,
			action: "warm",
		};

		expect(await runner.emitCacheWarmingDecision(event)).toBe("stop");
	});
});
