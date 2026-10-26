import { describe, expect, it } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

describe("session-held history projection settings", () => {
	it("holds both equal and differing values across every recompute without persisting them", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("project", () => JSON.stringify({ images: { blockImages: false }, codemode: { mode: "on" } }));
		const settings = SettingsManager.fromStorage(storage);
		settings.applyOverrides({ transport: "sse" });
		settings.holdSessionValues({ images: { blockImages: false }, codemode: { mode: "on" } });
		storage.withLock("project", () => JSON.stringify({ images: { blockImages: true }, codemode: { mode: "only" } }));
		await settings.reload();
		settings.setTheme("dark");
		settings.setProjectSkillPaths([]);
		settings.applyOverrides({ images: { blockImages: true }, codemode: { mode: "only" } });
		settings.setProjectTrusted(false);
		settings.setProjectTrusted(true);
		expect(settings.getBlockImages()).toBe(false);
		expect(settings.getSettings().codemode?.mode).toBe("on");
		expect(settings.getTransport()).toBe("sse");
		await settings.flush();
		const fresh = SettingsManager.fromStorage(storage);
		expect(fresh.getBlockImages()).toBe(true);
		expect(fresh.getSettings().codemode?.mode).toBe("only");
	});

	it("an explicit image setter wins over the destination project and can be changed again", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("project", () => JSON.stringify({ images: { blockImages: true } }));
		const settings = SettingsManager.fromStorage(storage);
		settings.holdSessionValues({ images: { blockImages: false }, codemode: { mode: "on" } });
		settings.setBlockImages(false);
		expect(settings.getBlockImages()).toBe(false);
		settings.setBlockImages(true);
		expect(settings.getBlockImages()).toBe(true);
		settings.setBlockImages(false);
		await settings.reload();
		expect(settings.getBlockImages()).toBe(false);
		expect(SettingsManager.fromStorage(storage).getBlockImages()).toBe(true);
	});

	it("an explicit image setter drops only that hold", async () => {
		const storage = new InMemorySettingsStorage();
		const settings = SettingsManager.fromStorage(storage);
		settings.holdSessionValues({ images: { blockImages: false }, codemode: { mode: "on" } });
		settings.setBlockImages(true);
		expect(settings.getBlockImages()).toBe(true);
		await settings.reload();
		expect(settings.getBlockImages()).toBe(true);
		expect(settings.getSettings().codemode?.mode).toBe("on");
	});
});
