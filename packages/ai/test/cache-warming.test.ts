import { describe, expect, it } from "vitest";
import {
	CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY,
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	evaluateCacheWarming,
	getPromptCacheTtlMs,
} from "../src/cache-warming.ts";
import { calculateCost } from "../src/models.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Api, Model, SimpleStreamOptions, Usage } from "../src/types.ts";

const opus = getBuiltinModel("anthropic", "claude-opus-5-5");

function cost(model: Model<Api>, tokens: Partial<Usage>): number {
	return calculateCost(model, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	}).total;
}

// Solve p * (write - read) - (read + one output token) >= minimum savings.
function threshold(writeRate: number): number {
	const p = CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY;
	return (
		((CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS + opus.cost.output / 1_000_000) * 1_000_000) /
		(p * (writeRate - opus.cost.cacheRead) - opus.cost.cacheRead)
	);
}

const shortThreshold = threshold(opus.cost.cacheWrite);
const longThreshold = threshold(opus.cost.input * 2);
const promptTokens = Math.ceil((shortThreshold + longThreshold) / 2);

function expectedDecision(model: Model<Api>, write: Partial<Usage>) {
	const read = cost(model, { cacheRead: promptTokens });
	const missCost = cost(model, write) - read;
	const warmCost = cost(model, { cacheRead: promptTokens, output: 1 });
	const continuationProbability = CACHE_WARMING_IDLE_CONTINUATION_PROBABILITY;
	const expectedSavings = continuationProbability * missCost - warmCost;
	return {
		phase: "idle",
		missCost,
		warmCost,
		continuationProbability,
		expectedSavings,
		economicsAvailable: true,
		action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
	};
}

describe("evaluateCacheWarming", () => {
	it("prices long-retention misses as 1h writes and warms between the two idle thresholds", () => {
		expect(longThreshold).toBeLessThan(promptTokens);
		expect(promptTokens).toBeLessThan(shortThreshold);
		const decision = evaluateCacheWarming(opus, promptTokens, "idle", { cacheRetention: "long" });
		expect(decision).toEqual(expectedDecision(opus, { cacheWrite: promptTokens, cacheWrite1h: promptTokens }));
		expect(decision.action).toBe("warm");
		for (const [tokens, action] of [
			[Math.floor(longThreshold), "stop"],
			[Math.ceil(longThreshold), "warm"],
		] as const) {
			expect(evaluateCacheWarming(opus, tokens, "idle", { cacheRetention: "long" }).action).toBe(action);
		}
	});

	it("preserves short-retention and default pricing", () => {
		for (const options of [undefined, { cacheRetention: "short" }] satisfies (SimpleStreamOptions | undefined)[]) {
			expect(evaluateCacheWarming(opus, promptTokens, "idle", options)).toEqual(
				expectedDecision(opus, { cacheWrite: promptTokens }),
			);
		}
		expect(evaluateCacheWarming(opus, promptTokens, "idle", { cacheRetention: "short" }).action).toBe("stop");
	});

	it("uses the same scoped environment retention and option precedence as the TTL", () => {
		const options: SimpleStreamOptions = { env: { PI_CACHE_RETENTION: "long" } };
		expect(getPromptCacheTtlMs(opus, options)).toBe(opus.promptCache!.long! * 1000);
		expect(evaluateCacheWarming(opus, promptTokens, "idle", options).action).toBe("warm");
		const short: SimpleStreamOptions = { ...options, cacheRetention: "short" };
		expect(getPromptCacheTtlMs(opus, short)).toBe(opus.promptCache!.short! * 1000);
		expect(evaluateCacheWarming(opus, promptTokens, "idle", short).action).toBe("stop");
	});

	it("keeps pricing misses as input when the model has no cache-write price", () => {
		const model = { ...opus, cost: { ...opus.cost, cacheWrite: 0 } };
		for (const cacheRetention of ["short", "long"] as const) {
			expect(evaluateCacheWarming(model, promptTokens, "idle", { cacheRetention })).toEqual(
				expectedDecision(model, { input: promptTokens }),
			);
		}
	});

	it("delegates equal 5m and 1h rates to calculateCost", () => {
		const model = { ...opus, cost: { ...opus.cost, cacheWrite: opus.cost.input * 2 } };
		expect(evaluateCacheWarming(model, promptTokens, "idle", { cacheRetention: "long" })).toEqual(
			evaluateCacheWarming(model, promptTokens, "idle", { cacheRetention: "short" }),
		);
	});
});
