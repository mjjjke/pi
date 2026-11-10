import { describe, expect, it } from "vitest";
import { detectLineEnding, restoreLineEndings } from "../src/index.ts";

describe("fork line-ending exports used by pi-handoff", () => {
	it("retains first-line detection and explicit restoration", () => {
		expect(detectLineEnding("first\r\nsecond\n")).toBe("\r\n");
		expect(detectLineEnding("first\nsecond\r\n")).toBe("\n");
		expect(detectLineEnding("no newline")).toBe("\n");
		expect(restoreLineEndings("first\nsecond\n", "\r\n")).toBe("first\r\nsecond\r\n");
		expect(restoreLineEndings("first\nsecond\n", "\n")).toBe("first\nsecond\n");
	});
});
