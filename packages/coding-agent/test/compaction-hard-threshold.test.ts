import { describe, expect, it } from "vitest";
import { shouldCompact } from "../src/core/compaction/compaction.ts";

const settings = { enabled: true, reserveTokens: 1000, keepRecentTokens: 10 };
describe("compaction safety net hard threshold", () => {
	it("starts at H, not one token beyond H", () => {
		expect(shouldCompact(8999, 10000, settings)).toBe(false);
		expect(shouldCompact(9000, 10000, settings)).toBe(true);
		expect(shouldCompact(9001, 10000, settings)).toBe(true);
	});
	it("does not enable the safety net when explicitly disabled", () => {
		expect(shouldCompact(10000, 10000, { ...settings, enabled: false })).toBe(false);
	});
});
