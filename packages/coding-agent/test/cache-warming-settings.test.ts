import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { SettingsSchema } from "../src/core/settings-schema.ts";

describe("cache warming idle limit setting", () => {
	it("defaults to 16 hours and reads only the global value", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("project", () => JSON.stringify({ cacheWarmingMaxIdleHours: 1 }));
		expect(SettingsManager.fromStorage(storage).getCacheWarmingMaxIdleHours()).toBe(16);
		storage.withLock("global", () => JSON.stringify({ cacheWarmingMaxIdleHours: 2.7 }));
		expect(SettingsManager.fromStorage(storage).getCacheWarmingMaxIdleHours()).toBe(2.7);
		expect(SettingsSchema.properties.cacheWarmingMaxIdleHours).toMatchObject({
			type: "number",
			exclusiveMinimum: 0,
			default: 16,
		});
	});

	it.each([undefined, null, 0, -1, "2", "invalid", false, {}, []])(
		"uses the default for missing or invalid settings.json value %j",
		(value) => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ cacheWarmingMaxIdleHours: value }));
			expect(SettingsManager.fromStorage(storage).getCacheWarmingMaxIdleHours()).toBe(16);
		},
	);

	it.each(["1e400", "-1e400"])("uses the default for overflowing JSON number %s", (literal) => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => `{"cacheWarmingMaxIdleHours":${literal}}`);
		expect(SettingsManager.fromStorage(storage).getCacheWarmingMaxIdleHours()).toBe(16);
	});
});
