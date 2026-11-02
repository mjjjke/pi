import { describe, expect, test } from "vitest";
import { getDocsPath, getExamplesPath, getReadmePath } from "../src/config.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	buildPiDocumentationSection,
	buildSystemPrompt,
	buildSystemPromptSections,
	diffSystemPromptSections,
} from "../src/core/system-prompt.ts";

const testSkill: Skill = {
	name: "test-skill",
	description: "A test skill.",
	filePath: "/skills/test-skill/SKILL.md",
	baseDir: "/skills/test-skill",
	sourceInfo: createSyntheticSourceInfo("/skills/test-skill/SKILL.md", { source: "test" }),
	disableModelInvocation: false,
};

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<tools>\n(none)\n");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("prompt structure", () => {
		test("keeps the default and custom prompt prefixes exact", () => {
			const defaultPrompt = buildSystemPrompt({ cwd: "/tmp", selectedTools: [], contextFiles: [], skills: [] });
			const customPrompt = buildSystemPrompt({
				customPrompt: "You are Exact.",
				cwd: "/tmp",
				selectedTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(defaultPrompt).toBe(
				"You are an expert coding assistant.\nUse the available tools to answer the user's request.\n\n" +
					"<tools>\n(none)\n</tools>\n\n" +
					"<rules>\n- Be concise in your responses\n- Show file paths clearly when working with files\n</rules>\n\n" +
					"<cwd>\n/tmp\n</cwd>",
			);
			expect(customPrompt.startsWith("You are Exact.\n\n<cwd>")).toBe(true);
		});

		test("preserves an exact forced prompt without sections", () => {
			expect(buildSystemPrompt({ forceSystemPrompt: "exact", cwd: "/tmp" })).toBe("exact");
		});

		test("maps appended instructions and project context to stable sections", () => {
			const prompt = buildSystemPrompt({
				customPrompt: "You are Exact.",
				appendSystemPrompt: "Additional instructions.",
				contextFiles: [{ path: "/tmp/AGENTS.md", content: "Project instructions." }],
				selectedTools: [],
				skills: [],
				cwd: "/tmp",
			});

			expect(prompt).toContain("<addendum>\nAdditional instructions.\n</addendum>");
			expect(prompt).toContain(
				'<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/tmp/AGENTS.md">',
			);
			expect(prompt).toContain("<cwd>\n/tmp\n</cwd>");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test.each([
			[["powershell"], "Use PowerShell for file operations"],
			[["bash", "powershell"], "Use bash or PowerShell for file operations"],
		] as const)("omits shell discovery directives for %j", (selectedTools, removed) => {
			const prompt = buildSystemPrompt({
				selectedTools: [...selectedTools],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain(removed);
		});

		const PARALLEL_CALLS_RULE =
			"- In one message, edit/write calls run alone in message order: later calls see their effect. Other calls (shell commands, reads, searches) start concurrently in no guaranteed order: a command that needs another command's effect (e.g. git add then commit) goes in the same command with && or in a later message.";

		test.each([
			[["read", "bash", "edit", "write"], true],
			[["bash", "edit"], true],
			[["bash", "write"], true],
			[["powershell", "edit"], true],
			[["read", "bash"], false],
			[["read", "edit", "write"], false],
			[[], false],
		] as const)(
			"describes exclusive mutations and parallel calls only for a shell plus edit/write (%j)",
			(selectedTools, expected) => {
				const prompt = buildSystemPrompt({
					selectedTools: [...selectedTools],
					contextFiles: [],
					skills: [],
					cwd: process.cwd(),
				});

				if (expected) expect(prompt).toContain(PARALLEL_CALLS_RULE);
				else expect(prompt).not.toContain("start concurrently");
			},
		);

		test("lists snippets without filler or a trailing blank line", () => {
			const sections = buildSystemPromptSections({ cwd: "/tmp", toolSnippets: { read: "Read files" } });
			expect(sections.tools).toBe("<tools>\n- read: Read files\n</tools>");
			expect(sections.docs).toBeUndefined();
		});

		test("keeps documentation routing available only as an explicit section", () => {
			const docs = buildPiDocumentationSection();
			expect(docs).toContain(`- Main documentation: ${getReadmePath()}`);
			expect(docs).toContain(`- Additional docs: ${getDocsPath()}`);
			expect(docs).toContain(`- Examples: ${getExamplesPath()}`);
			expect(docs).toContain("resolve docs/... under Additional docs and examples/... under Examples");
			expect(docs).toContain("environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md)");
			expect(docs).toContain("Before implementing harness changes, read the relevant docs and examples in full");
			expect(buildSystemPromptSections({ cwd: "/tmp", sections: { docs } }).docs).toBe(`<docs>\n${docs}\n</docs>`);
			expect(buildSystemPromptSections({ cwd: "/tmp" }).docs).toBeUndefined();
		});

		test("preserves custom section overrides, including an explicit docs section", () => {
			const sections = buildSystemPromptSections({
				cwd: "/tmp",
				sections: { tools: "Custom tools", rules: "Custom rules", docs: "Custom documentation" },
			});
			expect(sections.tools).toBe("<tools>\nCustom tools\n</tools>");
			expect(sections.rules).toBe("<rules>\nCustom rules\n</rules>");
			expect(sections.docs).toBe("<docs>\nCustom documentation\n</docs>");
		});

		test("keeps an explicit docs override after rules and before appended instructions", () => {
			const options = { cwd: "/tmp", appendSystemPrompt: "Keep this policy." };
			const sections = buildSystemPromptSections({
				...options,
				sections: { docs: "Custom documentation" },
			});

			expect(Object.keys(sections)).toEqual(["preamble", "tools", "rules", "docs", "addendum", "cwd"]);
			expect(buildSystemPrompt({ ...options, sections: { docs: "Custom documentation" } })).toBe(
				Object.values(sections).join("\n\n"),
			);
			expect(buildSystemPromptSections(options)).not.toHaveProperty("docs");
		});

		test("resyncs legacy defaults as a patch without mutating the sent sections", () => {
			const current = buildSystemPromptSections({ cwd: "/tmp" });
			const previous = {
				...current,
				preamble: "Legacy preamble",
				tools: "<tools>\n(none)\n\nAdditional tools may be available.\n</tools>",
				docs: "<docs>\nLegacy documentation\n</docs>",
			};
			const sent = { ...previous };
			expect(diffSystemPromptSections(previous, current)).toEqual({
				preamble: current.preamble,
				tools: current.tools,
				docs: null,
			});
			expect(previous).toEqual(sent);
			expect(diffSystemPromptSections(current, buildSystemPromptSections({ cwd: "/tmp" }))).toBeUndefined();
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("skills", () => {
		test.each([
			{ name: "default prompt", customPrompt: undefined },
			{ name: "custom prompt", customPrompt: "Custom system prompt" },
		])("includes skills with only bash in the $name", ({ customPrompt }) => {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<skills>");
			expect(prompt).toContain("<available_skills>");
			expect(prompt).toContain("<name>test-skill</name>");
			expect(prompt).toContain("Use bash to load a skill's file");
			expect(prompt).toContain(
				"Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
			);
		});

		test("omits skills without read or bash", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["write"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("<available_skills>");
		});
	});

	// #10343
	describe("hidden tools", () => {
		const build = (hiddenTools: string[]) =>
			buildSystemPrompt({
				selectedTools: ["read", "bash", "run"],
				hiddenTools,
				toolSnippets: { read: "Read files", bash: "Run commands", run: "Run a task" },
				toolGuidelines: { read: ["Use read for files."], run: ["Prefer run."] },
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

		test("leaves hidden tools out of the tool list and rules", () => {
			const prompt = build(["read", "bash"]);

			expect(prompt).toContain("<tools>\n- run: Run a task\n");
			expect(prompt).not.toContain("- read: ");
			expect(prompt).not.toContain("Use read for files.");
			expect(build([])).toContain("- read: Read files");
			expect(build([])).toContain("- Use read for files.");
			expect(prompt).toContain("- Prefer run.");
		});

		test("keeps skills without naming a hidden reader", () => {
			expect(build(["read", "bash"])).toContain("\nLoad a skill's file when the task matches its description.");
			expect(build(["read"])).toContain("Use bash to load a skill's file");
			expect(build([])).toContain("Use the read tool to load a skill's file");
		});
	});
});
