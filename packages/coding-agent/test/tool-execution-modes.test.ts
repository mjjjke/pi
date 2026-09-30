import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createBashTool, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditTool, createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createPowerShellTool, createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { createWriteTool, createWriteToolDefinition } from "../src/core/tools/write.ts";

// Fork: mutation calls are exclusive; independent shell calls retain parallelism.
describe("tool execution modes", () => {
	it.each([
		["bash", createBashToolDefinition, createBashTool],
		["powershell", createPowerShellToolDefinition, createPowerShellTool],
	] as const)("leaves %s parallel by default", (_name, definition, tool) => {
		expect(definition(process.cwd()).executionMode).toBeUndefined();
		expect(tool(process.cwd()).executionMode).toBeUndefined();
	});

	it.each([
		["edit", createEditToolDefinition, createEditTool],
		["write", createWriteToolDefinition, createWriteTool],
	] as const)("declares %s exclusive", (_name, definition, tool) => {
		expect(definition(process.cwd()).executionMode).toBe("exclusive");
		expect(tool(process.cwd()).executionMode).toBe("exclusive");
	});

	it("passes extension exclusive mode through both definition adapters", () => {
		const definition: ToolDefinition = {
			name: "mutate",
			label: "mutate",
			description: "mutate",
			parameters: Type.Object({}),
			executionMode: "exclusive",
			execute: async () => ({ content: [], details: undefined }),
		};
		const tool = wrapToolDefinition(definition);
		expect(tool.executionMode).toBe("exclusive");
		expect(createToolDefinitionFromAgentTool(tool).executionMode).toBe("exclusive");
	});
});
