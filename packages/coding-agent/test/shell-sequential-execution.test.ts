import { describe, expect, it } from "vitest";
import { createBashTool, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createPowerShellTool, createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";

// Fork: shell tools run their batch sequentially so a shell command (git add/commit,
// tests) never races an edit/write issued earlier in the same assistant message.
describe("shell tools execution mode", () => {
	it("declares bash as sequential", () => {
		expect(createBashToolDefinition(process.cwd()).executionMode).toBe("sequential");
		expect(createBashTool(process.cwd()).executionMode).toBe("sequential");
	});

	it("declares powershell as sequential", () => {
		expect(createPowerShellToolDefinition(process.cwd()).executionMode).toBe("sequential");
		expect(createPowerShellTool(process.cwd()).executionMode).toBe("sequential");
	});
});
