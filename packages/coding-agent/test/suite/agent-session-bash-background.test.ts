import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { BashBackgroundEvent, ExtensionError } from "../../src/core/extensions/types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function getToolResults(harness: Harness): ToolResultMessage[] {
	return harness.session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function getBashCallArguments(harness: Harness): Record<string, unknown>[] {
	return harness.session.messages
		.filter((message): message is AssistantMessage => message.role === "assistant")
		.flatMap((message) => message.content)
		.flatMap((part) => (part.type === "toolCall" && part.name === "bash" ? [part.arguments] : []));
}

describe("AgentSession bash_background", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("offers run_in_background calls to extension handlers; the first claim completes the call", async () => {
		const seen: Array<{ command: string; spawnCommand: string; notifyOn?: string; hasCtx: boolean }> = [];
		let secondHandlerCalls = 0;
		const harness = await createHarness({
			settings: { shellCommandPrefix: "export FROM_PREFIX=1" },
			extensionFactories: [
				(pi) => {
					pi.on("bash_background", (event, ctx) => {
						seen.push({
							command: event.command,
							spawnCommand: event.spawn.command,
							notifyOn: event.notifyOn,
							hasCtx: ctx !== undefined,
						});
						event.claim({ content: [{ type: "text", text: `started ${event.toolCallId}` }] });
					});
				},
				(pi) => {
					pi.on("bash_background", () => {
						secondHandlerCalls++;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall(
						"bash",
						{ command: "npm run dev", run_in_background: true, notify_on: "ready" },
						{ id: "call-bg" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start it");

		expect(seen).toEqual([
			{
				command: "npm run dev",
				spawnCommand: "export FROM_PREFIX=1\nnpm run dev",
				notifyOn: "ready",
				hasCtx: true,
			},
		]);
		expect(secondHandlerCalls).toBe(0);
		const [result] = getToolResults(harness);
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toBe("started call-bg");
		expect(getBashCallArguments(harness)).toEqual([
			{ command: "npm run dev", run_in_background: true, notify_on: "ready" },
		]);
	});

	it("fails the call when no extension handles bash_background", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi", run_in_background: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start it");

		const [result] = getToolResults(harness);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toMatch(/Background execution is not available/);
	});

	it("fails the call with a handler's error and does not offer it to later handlers", async () => {
		const errors: ExtensionError[] = [];
		const events: BashBackgroundEvent[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_background", () => {
						throw new Error("Invalid notify_on regular expression: bad");
					});
				},
				(pi) => {
					pi.on("bash_background", (event) => {
						events.push(event);
						event.claim({ content: [{ type: "text", text: "second" }] });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.extensionRunner.onError((error) => errors.push(error));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi", run_in_background: true, notify_on: "(" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start it");

		const [result] = getToolResults(harness);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("Invalid notify_on regular expression: bad");
		expect(events).toEqual([]);
	});

	it("runs foreground calls without emitting bash_background", async () => {
		let emitted = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_background", () => {
						emitted++;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo fg" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		const [result] = getToolResults(harness);
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toBe("fg\n");
		expect(emitted).toBe(0);
	});
});
