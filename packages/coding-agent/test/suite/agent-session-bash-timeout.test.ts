import type { ChildProcess } from "node:child_process";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionError } from "../../src/core/extensions/types.ts";
import { killProcessTree } from "../../src/utils/shell.ts";
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

describe("AgentSession bash_timeout", () => {
	const harnesses: Harness[] = [];
	const pids = new Set<number>();

	afterEach(() => {
		for (const pid of pids) killProcessTree(pid);
		pids.clear();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("routes bash timeouts to extension handlers that can take over the process", async () => {
		let child: ChildProcess | undefined;
		const seen: Array<{ command: string; timeout: number; hasCtx: boolean }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_timeout", (event, ctx) => {
						pids.add(event.pid);
						seen.push({ command: event.command, timeout: event.timeout, hasCtx: ctx !== undefined });
						const handover = event.takeOver();
						child = handover.child;
						handover.complete({ content: [{ type: "text", text: `backgrounded ${event.pid}` }] });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo start; sleep 30", timeout: 0.3 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		expect(seen).toEqual([{ command: "echo start; sleep 30", timeout: 0.3, hasCtx: true }]);
		const [result] = getToolResults(harness);
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toBe(`backgrounded ${child!.pid}`);
		expect(child!.exitCode).toBeNull();
		expect(child!.signalCode).toBeNull();
	});

	it("reports handler errors and falls back to the stock timeout", async () => {
		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_timeout", (event) => {
						pids.add(event.pid);
						throw new Error("handler exploded");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.extensionRunner.onError((error) => errors.push(error));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30", timeout: 0.3 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		const [result] = getToolResults(harness);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("Command timed out after 0.3 seconds");
		expect(errors).toMatchObject([{ event: "bash_timeout", error: "handler exploded" }]);
	});

	it("kills a timed-out shell whose descendant holds the pipe when no extension handles bash_timeout", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const command = '(while true; do echo x; sleep 0.02; done) & echo "bg:$!"; exit 0';
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command, timeout: 0.3 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const startedAt = Date.now();
		await harness.session.prompt("run it");

		expect(Date.now() - startedAt).toBeLessThan(3000);
		const [result] = getToolResults(harness);
		const text = getMessageText(result);
		const descendant = Number(text.match(/bg:(\d+)/)?.[1]);
		if (descendant) pids.add(descendant);
		expect(result.isError).toBe(true);
		expect(text).toMatch(/Command timed out after 0\.3 seconds$/);
	});

	it("applies a tool_call timeout mutation to execution without changing the recorded arguments", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event) => {
						if (event.toolName === "bash" && event.input.timeout === undefined) {
							event.input.timeout = 0.3;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const startedAt = Date.now();
		await harness.session.prompt("run it");

		expect(Date.now() - startedAt).toBeLessThan(10_000);
		const [result] = getToolResults(harness);
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toBe("Command timed out after 0.3 seconds");
		expect(getBashCallArguments(harness)).toEqual([{ command: "sleep 30" }]);
	});
});
