import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	cloneAssistantMessage,
	sanitizeAssistantMessageDisplayTransformResult,
} from "../src/core/extensions/assistant-message-display-transform.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult } from "./utilities.ts";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 123,
	};
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

async function createRunner(factories: ExtensionFactory[]): Promise<ExtensionRunner> {
	const result = await createTestExtensionsResult(factories);
	const runner = new ExtensionRunner(
		result.extensions,
		result.runtime,
		process.cwd(),
		SessionManager.inMemory(),
		ModelRegistry.inMemory(AuthStorage.inMemory()),
	);
	runner.setUIContext(undefined, "tui");
	return runner;
}

describe("assistant message display transforms", () => {
	test("chains transforms in extension and registration order", async () => {
		const runner = await createRunner([
			(pi) => {
				pi.registerAssistantMessageDisplayTransform("first", (_message, ctx) => {
					return `${assistantText(ctx.displayMessage as AssistantMessage)} first`;
				});
			},
			(pi) => {
				pi.registerAssistantMessageDisplayTransform("second", (_message, ctx) => {
					return `${assistantText(ctx.displayMessage as AssistantMessage)} second`;
				});
			},
		]);

		const raw = createAssistantMessage([{ type: "text", text: "raw" }]);
		const display = runner.applyAssistantMessageDisplayTransforms(raw, { phase: "restore" });

		expect(assistantText(display)).toBe("raw first second");
		expect(assistantText(raw)).toBe("raw");
	});

	test("freezes transform inputs so accidental mutation cannot alter the raw message", async () => {
		const runner = await createRunner([
			(pi) => {
				pi.registerAssistantMessageDisplayTransform("mutating", (message, ctx) => {
					Reflect.set(message.content[0] as object, "text", "mutated raw");
					Reflect.set(ctx.displayMessage.content[0] as object, "text", "mutated display");
					return "display only";
				});
			},
		]);

		const raw = createAssistantMessage([{ type: "text", text: "raw" }]);
		const display = runner.applyAssistantMessageDisplayTransforms(raw, { phase: "streaming" });

		expect(assistantText(display)).toBe("display only");
		expect(assistantText(raw)).toBe("raw");
	});

	test("reports and ignores malformed returned text blocks inside the transform boundary", async () => {
		const runner = await createRunner([
			(pi) => {
				pi.registerAssistantMessageDisplayTransform("malformed", () => {
					return [{ type: "text" }] as unknown as AssistantMessage["content"];
				});
				pi.registerAssistantMessageDisplayTransform("after", (_message, ctx) => {
					return `${assistantText(ctx.displayMessage as AssistantMessage)} after`;
				});
			},
		]);
		const errors: string[] = [];
		runner.onError((error) => errors.push(error.error));

		const raw = createAssistantMessage([{ type: "text", text: "raw" }]);
		const display = runner.applyAssistantMessageDisplayTransforms(raw, { phase: "final" });

		expect(assistantText(display)).toBe("raw after");
		expect(assistantText(raw)).toBe("raw");
		expect(errors).toEqual(["Assistant message display transform returned a text block without string text"]);
	});

	test("sanitizes returned messages to preserve metadata and non-text blocks", () => {
		const raw = createAssistantMessage([
			{ type: "text", text: "raw text" },
			{ type: "thinking", thinking: "raw thinking", thinkingSignature: "sig" },
			{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "raw.txt" } },
		]);
		const attempted = cloneAssistantMessage(raw);
		attempted.model = "changed-model";
		attempted.content = [
			{ type: "text", text: "display text" },
			{ type: "thinking", thinking: "changed thinking" },
			{ type: "toolCall", id: "tool-1", name: "write", arguments: { path: "changed.txt" } },
		];

		const display = sanitizeAssistantMessageDisplayTransformResult(raw, attempted);

		expect(display.model).toBe("gpt-4o-mini");
		expect(display.content).toEqual([
			{ type: "text", text: "display text" },
			{ type: "thinking", thinking: "raw thinking", thinkingSignature: "sig" },
			{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "raw.txt" } },
		]);
		expect(raw.content[0]).toEqual({ type: "text", text: "raw text" });
	});

	test("interactive assistant restore rendering uses display transform without mutating the raw message", () => {
		initTheme("dark");
		const raw = createAssistantMessage([{ type: "text", text: "Summary\n<submit_work/>" }]);
		const extensionRunner = {
			applyAssistantMessageDisplayTransforms(_message: AssistantMessage, _options: { phase: "restore" }) {
				return createAssistantMessage([{ type: "text", text: "Summary\nPlan submitted" }]);
			},
		};
		const fakeThis = {
			session: { extensionRunner },
			getAssistantDisplayMessage(message: AssistantMessage, phase: "restore") {
				return extensionRunner.applyAssistantMessageDisplayTransforms(message, { phase });
			},
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			chatContainer: new Container(),
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		};

		(
			InteractiveMode as unknown as { prototype: { addMessageToChat(message: AssistantMessage): void } }
		).prototype.addMessageToChat.call(fakeThis, raw);

		const rendered = stripVTControlCharacters(fakeThis.chatContainer.render(120).join("\n"));
		expect(rendered).toContain("Plan submitted");
		expect(rendered).not.toContain("submit_work");
		expect(assistantText(raw)).toBe("Summary\n<submit_work/>");
	});
});
