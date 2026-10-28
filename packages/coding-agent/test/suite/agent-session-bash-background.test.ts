import type { AssistantMessage, Context, SystemMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BashBackgroundEvent, ExtensionError } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";
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
		const seen: Array<{ command: string; spawnCommand: string; hasCtx: boolean }> = [];
		let secondHandlerCalls = 0;
		const harness = await createHarness({
			settings: { shellCommandPrefix: "export FROM_PREFIX=1" },
			extensionFactories: [
				(pi) => {
					pi.on("bash_background", (event, ctx) => {
						expect(event).not.toHaveProperty("notifyOn");
						seen.push({
							command: event.command,
							spawnCommand: event.spawn.command,
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
				[fauxToolCall("bash", { command: "npm run dev", run_in_background: true }, { id: "call-bg" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start it");

		expect(seen).toEqual([
			{
				command: "npm run dev",
				spawnCommand: "export FROM_PREFIX=1\nnpm run dev",
				hasCtx: true,
			},
		]);
		expect(secondHandlerCalls).toBe(0);
		const [result] = getToolResults(harness);
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toBe("started call-bg");
		expect(getBashCallArguments(harness)).toEqual([{ command: "npm run dev", run_in_background: true }]);
	});

	it("continues historical notify_on calls unchanged and declares the new bash schema just once", async () => {
		const manager = SessionManager.inMemory();
		const bash = createBashToolDefinition(process.cwd());
		manager.appendMessage({
			role: "system",
			content: "",
			sections: {},
			timestamp: 0,
			toolsAdded: [
				{
					name: "bash",
					description: bash.description,
					parameters: Type.Object({
						...bash.parameters.properties,
						notify_on: Type.Optional(Type.String()),
					}),
				},
			],
		});
		manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
		const historical = fauxAssistantMessage(
			[
				fauxToolCall(
					"bash",
					{ command: "echo ready", run_in_background: true, notify_on: "ready" },
					{ id: "old-bg" },
				),
			],
			{ stopReason: "toolUse", timestamp: 2 },
		);
		manager.appendMessage(historical);
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "old-bg",
			toolName: "bash",
			content: [{ type: "text", text: "started shell-1" }],
			isError: false,
			timestamp: 3,
		});
		const prefix = JSON.stringify(manager.getBranch());
		const requests: Context[] = [];
		const harness = await createHarness({ sessionManager: manager });
		harnesses.push(harness);
		harness.setResponses(
			[0, 1].map(() => (context: Context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			}),
		);
		await harness.session.prompt("continue");
		await harness.session.prompt("again");
		expect(JSON.stringify(manager.getBranch().slice(0, 4))).toBe(prefix);
		for (const request of requests) {
			expect(
				request.messages.find(
					(m) => m.role === "assistant" && m.content.some((p) => p.type === "toolCall" && p.id === "old-bg"),
				),
			).toEqual(historical);
			const changes = request.messages
				.filter((m): m is SystemMessage => m.role === "system")
				.flatMap((m) => m.toolsAdded ?? [])
				.filter((t) => t.name === "bash");
			expect(changes).toHaveLength(2);
			expect(changes[0].parameters).toHaveProperty("properties.notify_on");
			expect(changes[1].parameters).not.toHaveProperty("properties.notify_on");
		}
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
						throw new Error("background handler refused");
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
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi", run_in_background: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start it");

		const [result] = getToolResults(harness);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("background handler refused");
		expect(events).toEqual([]);
	});

	it("limits a claim to its handler: a returned handler's saved event cannot claim later", async () => {
		let saved: BashBackgroundEvent | undefined;
		const lateClaim: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_background", (event) => {
						saved = event;
					});
				},
				(pi) => {
					pi.on("bash_background", async (event) => {
						await new Promise((resolve) => setTimeout(resolve, 5));
						try {
							saved!.claim({ content: [{ type: "text", text: "stale" }] });
						} catch (error) {
							lateClaim.push((error as Error).message);
						}
						expect(event.claimed).toBe(false);
						event.claim({ content: [{ type: "text", text: "own claim" }] });
						expect(saved!.claimed).toBe(true);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi", run_in_background: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start it");

		expect(lateClaim).toEqual(["bash_background: handler already returned; claim before it returns"]);
		const [result] = getToolResults(harness);
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toBe("own claim");
	});

	it("stops dispatching once the call is aborted during an earlier handler", async () => {
		let laterHandlerCalls = 0;
		let signalAborted: boolean | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_background", async (event, ctx) => {
						await new Promise((resolve) => setTimeout(resolve, 5));
						ctx.abort();
						signalAborted = event.signal.aborted;
					});
				},
				(pi) => {
					pi.on("bash_background", (event) => {
						laterHandlerCalls++;
						event.claim({ content: [{ type: "text", text: "should not start" }] });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo hi", run_in_background: true })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start it");

		expect(signalAborted).toBe(true);
		expect(laterHandlerCalls).toBe(0);
		const [result] = getToolResults(harness);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("Command aborted");
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
