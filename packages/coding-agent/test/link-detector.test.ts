import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { LinkDetector } from "../src/utils/link-detector.ts";

const cwd = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? "/tmp", "detector-"));
for (const name of ["a.ts", "with spaces.ts", "1.2.3", "3", "a.ts:12"]) writeFileSync(join(cwd, name), "");
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
it("detects paths with positions, exact codespans and URLs before path candidates", () => {
	const detector = new LinkDetector(cwd, "zed");
	const source = "See a.ts:12:3, with a.ts and https://example.com/a.ts.";
	const spans = detector.linkify(source, "text");
	expect(spans.map((span) => source.slice(span.start, span.end))).toEqual([
		"a.ts:12:3",
		"a.ts",
		"https://example.com/a.ts",
	]);
	expect(spans[0].target).toBe(`zed://file${cwd}/a.ts:12:3`);
	expect(detector.linkify("with spaces.ts", "codespan")[0].target).toBe(`zed://file${cwd}/with%20spaces.ts:1`);
	expect(detector.linkify("a.ts:12", "codespan")).toEqual([]); // Existing ambiguous filename wins, then is refused.
	expect(detector.linkify("1.2.3 3/4 missing.ts", "text")).toEqual([]);
	expect(detector.linkify("1.2.3", "codespan")).toEqual([]);
});
it("bounds positive/negative discovery caches and performs no stat on a warm re-render", () => {
	const authorize = vi.fn((target: string) => (target.endsWith("missing.ts") ? undefined : target));
	const detector = new LinkDetector(cwd, "zed", { authorize, maxEntries: 2, ttlMs: 1000 });
	detector.linkify("a.ts missing.ts", "text");
	const calls = authorize.mock.calls.length;
	detector.linkify("a.ts missing.ts", "text");
	expect(authorize).toHaveBeenCalledTimes(calls);
	detector.linkify("a.ts:12:3", "text");
	expect(authorize).toHaveBeenCalledTimes(calls);
});
it("settings load, defaults, overrides and reload retain the requested choices", async () => {
	const settings = SettingsManager.inMemory();
	expect(settings.getEditorLinks()).toBe("file");
	expect(settings.getLinkOpenModifier()).toBe("ctrl");
	settings.applyOverrides({ editorLinks: "zed", linkOpenModifier: "none" });
	await settings.reload();
	expect(settings.getEditorLinks()).toBe("zed");
	expect(settings.getLinkOpenModifier()).toBe("none");
});
