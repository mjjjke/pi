import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops with neutral truncation wording", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("Thinking...");
		expect(rendered).toContain("Response was truncated before completion.");
	});

	test("coalesces adjacent thinking blocks into one hidden thinking label", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered.match(/Thinking\.\.\./g)).toHaveLength(1);
		expect(rendered).toContain("answer");
	});

	test("collapses individual thinking runs when clicked", () => {
		initTheme("dark");
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first reasoning" },
				{ type: "text", text: "answer" },
				{ type: "thinking", thinking: "second reasoning" },
			]),
		);
		const width = 80;
		const lines = component.render(width);
		const firstThinkingRow = lines.findIndex((line) => stripAnsi(line).includes("first reasoning"));
		expect(firstThinkingRow).toBeGreaterThanOrEqual(0);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 1,
			y: firstThinkingRow,
			screenX: 1,
			screenY: firstThinkingRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(event)?.handled).toBe(true);

		const collapsed = stripAnsi(component.render(width).join("\n"));
		expect(collapsed).not.toContain("first reasoning");
		expect(collapsed).toContain("Thinking...");
		expect(collapsed).toContain("second reasoning");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("chains Markdown transformers in registration order", () => {
		initTheme("dark");
		const calls: string[] = [];
		const message = createAssistantMessage([{ type: "text", text: "The result is $x^2$." }]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "assistant", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The result is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("identifies partial assistant Markdown as streaming", () => {
		initTheme("dark");
		const streamingStates: boolean[] = [];
		const message = createAssistantMessage([{ type: "text", text: "partial" }]);
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
			(markdown, context) => {
				streamingStates.push(context.isStreaming);
				return context.isStreaming ? markdown : `${markdown} transformed`;
			},
		]);

		component.updateContent(message, true);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("transformed");

		component.updateContent(message, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("partial transformed");
		expect(streamingStates).toEqual([true, false]);
	});

	test("reapplies Markdown transformers when available width changes", () => {
		initTheme("dark");
		const availableWidths: number[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "answer" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown, context) => {
					availableWidths.push(context.availableWidth);
					return `${markdown} (${context.availableWidth})`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("answer (78)");
		component.render(80);
		expect(stripAnsi(component.render(60).join("\n"))).toContain("answer (58)");
		expect(availableWidths).toEqual([78, 58]);
	});

	test("continues the Markdown transformer chain when a transformer throws", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "text", text: "still visible" }]),
			false,
			undefined,
			"Thinking...",
			1,
			[
				(markdown) => {
					calls.push("first");
					return markdown.replace("still", "remains");
				},
				() => {
					calls.push("throw");
					throw new Error("broken transformer");
				},
				(markdown) => {
					calls.push("last");
					return `${markdown} after error`;
				},
			],
		);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("remains visible after error");
		expect(calls).toEqual(["first", "throw", "last"]);
	});

	test("transforms text and thinking Markdown without mutating the original message", () => {
		initTheme("dark");
		const message = createAssistantMessage([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
		const component = new AssistantMessageComponent(message, false, undefined, "Thinking...", 1, [
			(markdown, { messageType }) => {
				return `${messageType}:${markdown}`;
			},
		]);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("assistant:answer");
		expect(rendered).toContain("assistant-thinking:reasoning");
		expect(message.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "reasoning" },
		]);
	});

	describe("progress updates", () => {
		// Thinking style marker; italics are not emitted in every terminal/test environment.
		const thinkingStyle = () => theme.fg("thinkingText", "x").split("x")[0];

		function anthropicMessage(content: AssistantMessage["content"], model = "claude-opus-5-5"): AssistantMessage {
			return { ...createAssistantMessage(content), api: "anthropic-messages", provider: "anthropic", model };
		}

		const toolCall = { type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "file.txt" } };
		const commentary = JSON.stringify({ v: 1, id: "msg_1", phase: "commentary" });
		const finalAnswer = JSON.stringify({ v: 1, id: "msg_2", phase: "final_answer" });

		function renderLines(message: AssistantMessage, hideThinking = false): string[] {
			return new AssistantMessageComponent(message, hideThinking).render(80);
		}

		function lineWith(lines: string[], text: string): string | undefined {
			return lines.find((line) => stripAnsi(line).includes(text));
		}

		test("shows marked progress updates as bullets even when thinking is hidden", () => {
			initTheme("dark");
			const message = anthropicMessage([
				{ type: "thinking", thinking: "", thinkingSignature: "sig-reasoning" },
				{ type: "thinking", thinking: "Found the bug.", thinkingSignature: "sig-update", progressUpdate: true },
				toolCall,
			]);
			for (const hidden of [true, false]) {
				const lines = renderLines(message, hidden);
				const rendered = stripAnsi(lines.join("\n"));
				expect(rendered).toContain("• Found the bug.");
				expect(rendered).not.toContain("Thinking...");
				expect(lineWith(lines, "Found the bug.")).not.toContain(`${thinkingStyle()}Found`);
			}
		});

		test("renders nothing for empty reasoning blocks", () => {
			initTheme("dark");
			const message = anthropicMessage([{ type: "thinking", thinking: "", thinkingSignature: "sig" }, toolCall]);
			for (const hidden of [true, false]) {
				expect(stripAnsi(renderLines(message, hidden).join("\n")).trim()).toBe("");
			}
		});

		test("treats the last of several thinking blocks before a tool call as an update in summarized mode", () => {
			initTheme("dark");
			const message = anthropicMessage([
				{ type: "thinking", thinking: "private reasoning", thinkingSignature: "sig-1" },
				{ type: "thinking", thinking: "Reading the config next.", thinkingSignature: "sig-2" },
				toolCall,
			]);
			const hiddenRendered = stripAnsi(renderLines(message, true).join("\n"));
			expect(hiddenRendered).toContain("Thinking...");
			expect(hiddenRendered).toContain("• Reading the config next.");
			expect(hiddenRendered).not.toContain("private reasoning");

			const lines = renderLines(message);
			expect(lineWith(lines, "private reasoning")).toContain(`${thinkingStyle()}private`);
			expect(lineWith(lines, "Reading the config next.")).not.toContain(`${thinkingStyle()}Reading`);
			expect(message.content[1]).toEqual({
				type: "thinking",
				thinking: "Reading the config next.",
				thinkingSignature: "sig-2",
			});
		});

		test("does not apply the heuristic without a following tool call, to single blocks, or to other models", () => {
			initTheme("dark");
			const cases = [
				anthropicMessage([
					{ type: "thinking", thinking: "first", thinkingSignature: "sig-1" },
					{ type: "thinking", thinking: "second", thinkingSignature: "sig-2" },
					{ type: "text", text: "answer" },
				]),
				anthropicMessage([{ type: "thinking", thinking: "second", thinkingSignature: "sig-2" }, toolCall]),
				anthropicMessage(
					[
						{ type: "thinking", thinking: "first", thinkingSignature: "sig-1" },
						{ type: "thinking", thinking: "second", thinkingSignature: "sig-2" },
						toolCall,
					],
					"claude-opus-4-6",
				),
				createAssistantMessage([
					{ type: "thinking", thinking: "first" },
					{ type: "thinking", thinking: "second" },
					toolCall,
				]),
			];
			for (const message of cases) {
				const rendered = stripAnsi(renderLines(message, true).join("\n"));
				expect(rendered).not.toContain("•");
				expect(rendered).not.toContain("second");
			}
		});

		test("does not apply the heuristic to messages that already mark updates", () => {
			initTheme("dark");
			const message = anthropicMessage([
				{ type: "thinking", thinking: "Update one.", thinkingSignature: "sig-1", progressUpdate: true },
				toolCall,
				{ type: "thinking", thinking: "", thinkingSignature: "sig-2" },
				{ type: "thinking", thinking: "stray summary", thinkingSignature: "sig-3" },
				toolCall,
			]);
			const rendered = stripAnsi(renderLines(message, true).join("\n"));
			expect(rendered).toContain("• Update one.");
			expect(rendered).not.toContain("stray summary");
		});

		test("renders OpenAI commentary text as a progress update once its phase is known", () => {
			initTheme("dark");
			const message = createAssistantMessage([
				{ type: "text", text: "Checking the tests first.", textSignature: commentary },
				toolCall,
				{ type: "text", text: "All done.", textSignature: finalAnswer },
			]);
			const rendered = stripAnsi(renderLines(message, true).join("\n"));
			expect(rendered).toContain("• Checking the tests first.");
			expect(rendered).not.toContain("• All done.");
			expect(rendered).toContain("All done.");

			const streaming = createAssistantMessage([{ type: "text", text: "Checking the tests first." }]);
			expect(stripAnsi(renderLines(streaming).join("\n"))).not.toContain("•");
		});

		test("indents wrapped progress update lines under the bullet", () => {
			initTheme("dark");
			const message = anthropicMessage([
				{ type: "thinking", thinking: "word ".repeat(30).trim(), thinkingSignature: "sig", progressUpdate: true },
				toolCall,
			]);
			const lines = new AssistantMessageComponent(message).render(40).map((line) => stripAnsi(line));
			const first = lines.findIndex((line) => line.includes("•"));
			expect(lines[first].startsWith(" • word")).toBe(true);
			expect(lines[first + 1].startsWith("   word")).toBe(true);
		});
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("hello"))).toBe(true);
	});
});
