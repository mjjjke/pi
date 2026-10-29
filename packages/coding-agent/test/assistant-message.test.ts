import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getOsc8LinkAtColumn, setCapabilities, TuiAltScreen, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { getProgressUpdateIndices } from "../src/modes/interactive/components/progress-update.ts";
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
	test.each([1, 2])(
		"stationary hover survives streaming tails, invalidation and separate owners (blocks=%s)",
		(blocks) => {
			initTheme("dark");
			setCapabilities({ images: null, hyperlinks: true, trueColor: true });
			const url = "https://ok.test/";
			const source = `[abcdefghijklmnop](${url}) tail`;
			const content = (tail = ""): AssistantMessage["content"] =>
				Array.from({ length: blocks }, (_, index) => ({
					type: "text",
					text: source + (index === blocks - 1 ? tail : ""),
				}));
			const message = createAssistantMessage(content());
			const component = new AssistantMessageComponent(message);
			const other = new AssistantMessageComponent(message);
			const terminal = new VirtualTerminal(12, 16);
			const opened: string[] = [];
			const tui = new TuiAltScreen(terminal, false, process.env.PI_SCRATCH_DIR, {
				copyOnSelect: false,
				openUrl: (target) => opened.push(target),
			});
			tui.addChild(component);
			tui.start();
			try {
				tui.renderNow();
				const original = tui.getScreenLines();
				const row = original.findIndex((line) => getOsc8LinkAtColumn(line, 1)?.url === url);
				const identity = getOsc8LinkAtColumn(original[row], 1);
				expect(identity?.id).toBeTruthy();
				expect(getOsc8LinkAtColumn(other.render(12)[row], 1)?.id).not.toBe(identity?.id);
				terminal.sendInput(`\x1b[<35;2;${row + 1}M`);
				tui.renderNow();
				expect(tui.getScreenLines()[row]).toContain("\x1b[7m");
				for (const tail of [" more", " more again"]) {
					component.updateContent(createAssistantMessage(content(tail)), true);
					tui.renderNow();
					expect(getOsc8LinkAtColumn(tui.getScreenLines()[row], 1)).toEqual(identity);
					expect(tui.getScreenLines()[row]).toContain("\x1b[7m");
					component.invalidate();
					tui.renderNow();
					expect(tui.getScreenLines()[row]).toContain("\x1b[7m");
				}
				terminal.sendInput(`\x1b[<16;2;${row + 1}M`);
				terminal.sendInput(`\x1b[<16;2;${row + 1}m`);
				expect(opened).toEqual([url]);
			} finally {
				tui.stop({ preserveScreen: true });
			}
		},
	);
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

		test("shows marked progress updates as assistant text even when thinking is hidden", () => {
			initTheme("dark");
			const message = anthropicMessage([
				{ type: "thinking", thinking: "", thinkingSignature: "sig-reasoning" },
				{ type: "thinking", thinking: "Found the bug.", thinkingSignature: "sig-update", progressUpdate: true },
				toolCall,
			]);
			for (const hidden of [true, false]) {
				const lines = renderLines(message, hidden);
				const rendered = stripAnsi(lines.join("\n"));
				expect(rendered).toContain("Found the bug.");
				expect(lines).toEqual(
					renderLines(anthropicMessage([{ type: "text", text: "Found the bug." }, toolCall]), hidden),
				);
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
			expect(hiddenRendered).toContain("Reading the config next.");
			expect(renderLines(message, true)).toEqual(
				renderLines(
					anthropicMessage([message.content[0], { type: "text", text: "Reading the config next." }, toolCall]),
					true,
				),
			);
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

		test.each([false, true])("reclassifies summarized reasoning on one streaming component (hidden=%s)", (hidden) => {
			initTheme("dark");
			const updateText = "Reading the config next.";
			const message = anthropicMessage([
				{ type: "thinking", thinking: "private reasoning", thinkingSignature: "sig-1" },
			]);
			const calls: unknown[] = [];
			const component = new AssistantMessageComponent(undefined, hidden, undefined, "Thinking...", 1, [
				(markdown, context) => {
					if (markdown.includes(updateText)) calls.push(context);
					return markdown;
				},
			]);
			component.updateContent(message, true);
			expect(stripAnsi(component.render(80).join("\n"))).toContain(hidden ? "Thinking..." : "private reasoning");

			message.content.push({ type: "thinking", thinking: updateText, thinkingSignature: "sig-2" });
			component.updateContent(message, true);
			const before = component.render(80);
			if (hidden) {
				expect(stripAnsi(before.join("\n")).match(/Thinking\.\.\./g)).toHaveLength(1);
				expect(stripAnsi(before.join("\n"))).not.toContain(updateText);
			} else {
				expect(lineWith(before, updateText)).toContain(`${thinkingStyle()}Reading`);
			}
			expect(calls).toEqual(
				hidden ? [] : [{ messageType: "assistant-thinking", isStreaming: true, availableWidth: 78 }],
			);
			calls.length = 0;

			message.content.push(toolCall);
			const original = structuredClone(message);
			component.updateContent(message, true);
			const after = component.render(80);
			expect(after).toEqual(
				renderLines(anthropicMessage([message.content[0], { type: "text", text: updateText }, toolCall]), hidden),
			);
			expect(lineWith(after, updateText)).not.toContain(`${thinkingStyle()}Reading`);
			expect(calls).toEqual([{ messageType: "assistant", isStreaming: true, availableWidth: 78 }]);
			expect(message).toEqual(original);
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
			expect(rendered).toContain("Update one.");
			expect(rendered).not.toContain("stray summary");
		});

		test("keeps OpenAI commentary identical to ordinary text once its phase is known", () => {
			initTheme("dark");
			const message = createAssistantMessage([
				{ type: "text", text: "Checking the tests first.", textSignature: commentary },
				toolCall,
				{ type: "text", text: "All done.", textSignature: finalAnswer },
			]);
			expect(getProgressUpdateIndices(message)).toEqual(new Set());
			const rendered = stripAnsi(renderLines(message, true).join("\n"));
			expect(rendered).toContain("Checking the tests first.");
			expect(renderLines(message, true)).toEqual(
				renderLines(
					createAssistantMessage([
						{ type: "text", text: "Checking the tests first." },
						toolCall,
						{ type: "text", text: "All done." },
					]),
					true,
				),
			);
			expect(rendered).toContain("All done.");
		});

		test("uses ordinary assistant text spacing for commentary followed by text or a tool call", () => {
			initTheme("dark");
			const message = createAssistantMessage([
				{ type: "text", text: "Checking first.", textSignature: commentary },
				{ type: "text", text: "All done.", textSignature: finalAnswer },
			]);
			const lines = renderLines(message).map((line) => stripAnsi(line).trimEnd());
			const update = lines.findIndex((line) => line.includes("Checking first."));
			expect(lines[update + 1]).toContain("All done.");
			expect(renderLines(message)).toEqual(
				renderLines(
					createAssistantMessage([
						{ type: "text", text: "Checking first." },
						{ type: "text", text: "All done." },
					]),
				),
			);

			const trailing = createAssistantMessage([
				{ type: "text", text: "Checking.", textSignature: commentary },
				toolCall,
			]);
			const trailingLines = renderLines(trailing).map((line) => stripAnsi(line).trimEnd());
			expect(trailingLines.at(-1)).toContain("Checking.");
		});

		test.each(["marked", "commentary", "summarized"] as const)(
			"renders %s updates exactly like ordinary Markdown, including padding, wrapping, color and spacing",
			(kind) => {
				const text = `  **Checking** \`config.ts\` next. ${"word ".repeat(30)}\n\n- First item\n- Second item\n  `;
				const reasoning = { type: "thinking" as const, thinking: "private reasoning", thinkingSignature: "sig" };
				const prefix = kind === "summarized" ? [reasoning] : [];
				const update: AssistantMessage["content"][number] =
					kind === "commentary"
						? { type: "text", text, textSignature: commentary }
						: { type: "thinking", thinking: text, progressUpdate: kind === "marked" ? true : undefined };
				const message = anthropicMessage([...prefix, update, toolCall, { type: "text", text: "All done." }]);
				const original = structuredClone(message);
				const ordinary = anthropicMessage([
					...prefix,
					{ type: "text", text },
					toolCall,
					{ type: "text", text: "All done." },
				]);
				for (const themeName of ["dark", "light"]) {
					initTheme(themeName);
					for (const hidden of [false, true]) {
						for (const padding of [0, 1, 3]) {
							const component = new AssistantMessageComponent(
								message,
								hidden,
								undefined,
								"Thinking...",
								padding,
							);
							const expected = new AssistantMessageComponent(
								ordinary,
								hidden,
								undefined,
								"Thinking...",
								padding,
							);
							for (const width of [24, 40, 80]) {
								// Compare raw ANSI lines as well as geometry, not just stripped text.
								expect(component.render(width)).toEqual(expected.render(width));
							}
							component.setOutputPad(padding + 1);
							expected.setOutputPad(padding + 1);
							component.setHideThinkingBlock(!hidden);
							expected.setHideThinkingBlock(!hidden);
							component.invalidate();
							expected.invalidate();
							expect(component.render(40)).toEqual(expected.render(40));
						}
					}
				}
				expect(message).toEqual(original);
			},
		);

		test("passes updates through assistant Markdown transformers with ordinary width and streaming state", () => {
			initTheme("dark");
			const message = anthropicMessage([
				{ type: "thinking", thinking: "Checking.", progressUpdate: true },
				toolCall,
			]);
			const calls: unknown[] = [];
			const component = new AssistantMessageComponent(undefined, true, undefined, "Thinking...", 3, [
				(markdown, context) => {
					calls.push(context);
					return `${markdown} Transformed.`;
				},
			]);
			for (const streaming of [true, false]) {
				component.updateContent(message, streaming);
				expect(stripAnsi(component.render(40).join("\n"))).toContain("Checking. Transformed.");
			}
			expect(calls).toEqual([
				{ messageType: "assistant", isStreaming: true, availableWidth: 34 },
				{ messageType: "assistant", isStreaming: false, availableWidth: 34 },
			]);
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
