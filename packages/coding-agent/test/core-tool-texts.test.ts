import { describe, expect, it } from "vitest";
import type { ExtensionToolContext } from "../src/core/extensions/types.ts";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { applyEditsToNormalizedContent } from "../src/core/tools/edit-diff.ts";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const ctx = { cwd: "/tmp" } as ExtensionToolContext;
const pathText =
	"File path, relative or absolute. A leading ~/ (or a bare ~) expands to your home directory; environment variables such as $HOME do not.";
const fact =
	"The user sees each edit as a colored diff and each write as highlighted content; a file changed through the shell shows them only the command and its output. edit writes nothing unless every oldText matches exactly one region, while sed -i or a script's replace() can silently change nothing or more than intended.";
const shellDescription = (name: string) =>
	`Run a ${name} command in the working directory. Each call starts a new non-interactive process: directory and environment changes do not carry over, and there is no terminal for interactive input. For a command that finishes in the foreground, the text result keeps at most the last 2000 lines or 50KB of combined stdout and stderr.`;
const definitions = () =>
	[
		createReadToolDefinition("/tmp"),
		createBashToolDefinition("/tmp"),
		createEditToolDefinition("/tmp"),
		createWriteToolDefinition("/tmp"),
	] as const;

describe("approved core tool texts rev 3.2", () => {
	it("pins descriptions, snippets and every parameter text", () => {
		const [read, bash, edit, write] = definitions();
		expect(read.description).toBe(
			"Read a file. Text files return up to 2000 lines or 50KB starting at offset; images (jpg, png, gif, webp, bmp) are returned as attachments.",
		);
		expect(bash.description).toBe(shellDescription("bash"));
		expect(createPowerShellToolDefinition("/tmp").description).toBe(shellDescription("PowerShell"));
		expect(edit.description).toBe(
			"Replace text in one existing file. Each oldText must match exactly one region of the file as it was before this call, and entries must not overlap. Matching ignores line-ending differences and tolerates trailing whitespace and Unicode compatibility, quote, dash and space differences, also when counting matches; if any entry needs that tolerance, other text on the touched lines may be normalized too. All replacements are validated before writing; a validation failure writes nothing.",
		);
		expect(write.description).toBe(
			"Write a UTF-8 text file: creates it, or replaces its whole content if it exists, creating missing parent directories. There is no append mode.",
		);
		expect(definitions().map((t) => t.promptSnippet)).toEqual([
			"Read a text file or an image",
			"Run shell commands",
			"Change part of an existing text file",
			"Create a text file or replace one entirely",
		]);
		expect(read.parameters.properties.path).toMatchObject({ description: pathText });
		expect(edit.parameters.properties.path).toMatchObject({ description: pathText });
		expect(write.parameters.properties.path).toMatchObject({ description: pathText });
		expect(read.parameters.properties.offset).toMatchObject({
			description: "Line number to start reading from (1-indexed)",
		});
		expect(read.parameters.properties.limit).toMatchObject({ description: "Maximum number of lines to read" });
		expect(bash.parameters.properties.command).toMatchObject({ description: "Shell command to execute" });
		expect(bash.parameters.properties.timeout).toMatchObject({ description: "Timeout in seconds" });
		expect(bash.parameters.properties.run_in_background).toMatchObject({
			description:
				"Start the command in the background and return at once instead of waiting for its output (default false). Fails when background execution is not available. timeout does not apply.",
		});
		expect(bash.parameters.properties.notify_on).toMatchObject({
			description:
				"Only with run_in_background: JavaScript regular expression source (no flags); matching output lines are reported while the command runs",
		});
		expect(bash.parameters.properties.description).toMatchObject({
			description: "Short label for the command, shown in the UI",
		});
		expect(edit.parameters.properties.edits).toMatchObject({ description: "One or more replacements in this file" });
		expect(edit.parameters.properties.edits.items.properties.oldText).toMatchObject({
			description: "Non-empty text identifying the region to replace",
		});
		expect(edit.parameters.properties.edits.items.properties.newText).toMatchObject({
			description: "Replacement text for this targeted edit.",
		});
		expect(write.parameters.properties.content).toMatchObject({
			description: "The complete file content, written verbatim",
		});
		expect(bash.outputSchema).toMatchObject({
			properties: { output: { description: "Combined stdout and stderr, possibly truncated" } },
		});
	});
	it("keeps declarations static across environment, timeout hooks and read settings", () => {
		const plain = createBashToolDefinition("/tmp");
		const configured = createBashToolDefinition("/elsewhere", {
			exposeSessionEnvironment: false,
			commandPrefix: "true",
			onTimeout: () => {},
		});
		expect([configured.description, configured.parameters]).toEqual([plain.description, plain.parameters]);
		expect(createReadToolDefinition("/elsewhere", { autoResizeImages: false }).description).toBe(
			createReadToolDefinition("/tmp").description,
		);
	});
	it.each([true, false])(
		"has only ordering and the interactive fact as core tool rules (renders=%s)",
		(rendersToolCalls) => {
			const tools = definitions();
			const options = {
				cwd: "/tmp",
				rendersToolCalls,
				selectedTools: tools.map((t) => t.name),
				toolSnippets: Object.fromEntries(tools.map((t) => [t.name, t.promptSnippet ?? ""])),
				toolGuidelines: Object.fromEntries(tools.map((t) => [t.name, t.promptGuidelines ?? []])),
			};
			const sections = buildSystemPromptSections(options);
			expect(sections.rules.includes(fact)).toBe(rendersToolCalls);
			expect(sections.rules.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(rendersToolCalls ? 4 : 3);
			expect(sections.rules).toContain("In one message, edit/write calls run alone in message order:");
			expect(sections.rules).not.toMatch(
				/Use (bash|PowerShell|read|edit|write)|Keep edits|When changing|Each edits|Put changes|PI_\*/,
			);
			expect(buildSystemPromptSections(options)).toEqual(sections);
		},
	);
	it("omits rendering claims for explore, hidden codemode tools and no-shell loadouts", () => {
		for (const options of [
			{ selectedTools: ["read", "bash", "grep", "find", "ls"] },
			{
				selectedTools: ["read", "bash", "edit", "write", "codemode"],
				hiddenTools: ["read", "bash", "edit", "write"],
			},
			{ selectedTools: ["read", "edit", "write"] },
		]) {
			expect(buildSystemPromptSections({ cwd: "/tmp", rendersToolCalls: true, ...options }).rules).not.toContain(
				fact,
			);
		}
		expect(
			buildSystemPromptSections({
				cwd: "/tmp",
				rendersToolCalls: true,
				selectedTools: ["read", "powershell", "edit", "write"],
			}).rules,
		).toContain(fact);
	});
	it("gives a generic bounded-shell hint for an oversized line", async () => {
		const tool = createReadToolDefinition("/tmp", {
			operations: { access: async () => {}, readFile: async () => Buffer.from("x".repeat(51201)) },
		});
		const result = await tool.execute("long", { path: "long.txt" }, undefined, undefined, ctx);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "[Line 1 is 50.0KB, exceeds 50.0KB limit. This tool cannot return this line. If a shell tool is available, use it to inspect a bounded portion of the line.]",
			},
		]);
	});
	it.each([false, true])("pins not-found and duplicate recovery tails (multiple=%s)", (multiple) => {
		const prior = multiple ? [{ oldText: "first", newText: "new" }] : [];
		expect(() =>
			applyEditsToNormalizedContent("first\na\na", [...prior, { oldText: "missing", newText: "x" }], "P"),
		).toThrowError(
			multiple
				? "Could not find edits[1] in P. The file may differ from what you remember: read the current text and copy oldText from it."
				: "Could not find the text in P. The file may differ from what you remember: read the current text and copy oldText from it.",
		);
		expect(() =>
			applyEditsToNormalizedContent("first\na\na", [...prior, { oldText: "a", newText: "x" }], "P"),
		).toThrowError(
			multiple
				? "Found 2 occurrences of edits[1] in P. Add surrounding text to pick one; edit has no replace-all."
				: "Found 2 occurrences of the text in P. Add surrounding text to pick one; edit has no replace-all.",
		);
	});
	it("allows a no-op entry beside a real change, rejects fuzzy twins and validates before writing", async () => {
		expect(
			applyEditsToNormalizedContent(
				"a\nb",
				[
					{ oldText: "a", newText: "a" },
					{ oldText: "b", newText: "c" },
				],
				"P",
			).newContent,
		).toBe("a\nc");
		expect(() => applyEditsToNormalizedContent('"a"\n“a”', [{ oldText: '"a"', newText: "b" }], "P")).toThrow(
			"Found 2 occurrences",
		);
		const writes: string[] = [];
		const edit = createEditToolDefinition("/tmp", {
			operations: {
				access: async () => {},
				readFile: async () => Buffer.from("first"),
				writeFile: async (_p, content) => {
					writes.push(content);
				},
			},
		});
		await expect(
			edit.execute(
				"validation",
				{
					path: "P",
					edits: [
						{ oldText: "first", newText: "changed" },
						{ oldText: "missing", newText: "x" },
					],
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow("Could not find edits[1]");
		expect(writes).toEqual([]);
	});
});
