import type { ChildProcess } from "node:child_process";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, ExtensionError } from "../../src/core/extensions/types.ts";
import { killProcessTree } from "../../src/utils/shell.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function getToolResults(harness: Harness): ToolResultMessage[] {
	return harness.session.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await delay(10);
	}
}

function resultText(harness: Harness, toolCallId: string): string {
	const result = getToolResults(harness).find((message) => message.toolCallId === toolCallId);
	return result ? getMessageText(result) : "";
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
		const seen: Array<{ reason: string; command: string; timeout: number; hasCtx: boolean }> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("bash_timeout", (event, ctx) => {
						pids.add(event.pid);
						if (event.reason !== "timeout") return;
						seen.push({
							reason: event.reason,
							command: event.command,
							timeout: event.timeout,
							hasCtx: ctx !== undefined,
						});
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

		expect(seen).toEqual([{ reason: "timeout", command: "echo start; sleep 30", timeout: 0.3, hasCtx: true }]);
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
	it("hands running bash calls over on request and resolves with the count", async () => {
		let ctx: ExtensionContext | undefined;
		const started = new Set<string>();
		const reasons: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_execution_start", (event, eventCtx) => {
						ctx = eventCtx;
						started.add(event.toolCallId);
					});
					pi.on("bash_timeout", (event) => {
						pids.add(event.pid);
						reasons.push(event.reason);
						event.takeOver().complete({ content: [{ type: "text", text: `moved ${event.toolCallId}` }] });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "sleep 30" }, { id: "call-a" }),
					fauxToolCall("bash", { command: "sleep 30" }, { id: "call-b" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		const prompt = harness.session.prompt("run them");
		await waitFor(() => started.size === 2);
		const count = await ctx!.requestBashHandover();
		await prompt;

		expect(count).toBe(2);
		expect(reasons).toEqual(["steer", "steer"]);
		expect(resultText(harness, "call-a")).toBe("moved call-a");
		expect(resultText(harness, "call-b")).toBe("moved call-b");
	});

	it("targets only the requested toolCallId", async () => {
		let ctx: ExtensionContext | undefined;
		const started = new Set<string>();
		const handled: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_execution_start", (event, eventCtx) => {
						ctx = eventCtx;
						started.add(event.toolCallId);
					});
					pi.on("bash_timeout", (event) => {
						pids.add(event.pid);
						handled.push(event.toolCallId);
						event.takeOver().complete({ content: [{ type: "text", text: "moved" }] });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "sleep 30" }, { id: "target" }),
					fauxToolCall("bash", { command: "sleep 0.5; echo finished" }, { id: "other" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		const prompt = harness.session.prompt("run them");
		await waitFor(() => started.size === 2);
		const count = await ctx!.requestBashHandover({ toolCallId: "target" });
		await prompt;

		expect(count).toBe(1);
		expect(handled).toEqual(["target"]);
		expect(resultText(harness, "target")).toBe("moved");
		expect(resultText(harness, "other")).toBe("finished\n");
	});

	it("holds a request for a bash call that has started but not spawned yet", async () => {
		const counts: number[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_execution_start", (event, ctx) => {
						if (event.toolName !== "bash") return;
						void ctx.requestBashHandover({ toolCallId: event.toolCallId }).then((count) => counts.push(count));
					});
					pi.on("bash_timeout", (event) => {
						pids.add(event.pid);
						event.takeOver().complete({ content: [{ type: "text", text: `moved on ${event.reason}` }] });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" }, { id: "early" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		expect(resultText(harness, "early")).toBe("moved on steer");
		await waitFor(() => counts.length === 1);
		expect(counts).toEqual([1]);
	});

	it("resolves a held request with 0 when the call ends without spawning", async () => {
		const counts: number[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_execution_start", (event, ctx) => {
						void ctx.requestBashHandover({ toolCallId: event.toolCallId }).then((count) => counts.push(count));
					});
					pi.on("tool_call", () => ({ block: true, reason: "blocked" }));
					pi.on("bash_timeout", (event) => {
						event.takeOver().complete({ content: [{ type: "text", text: "moved" }] });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" }, { id: "blocked" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		await waitFor(() => counts.length === 1);
		expect(counts).toEqual([0]);
	});

	it("keeps a declined bash call running when handlers decline the request", async () => {
		let ctx: ExtensionContext | undefined;
		let started = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("tool_execution_start", (_event, eventCtx) => {
						ctx = eventCtx;
						started = true;
					});
					pi.on("bash_timeout", () => {});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo a; sleep 0.5; echo b" }, { id: "kept" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		const prompt = harness.session.prompt("run it");
		await waitFor(() => started);
		const count = await ctx!.requestBashHandover();
		await prompt;

		expect(count).toBe(0);
		expect(resultText(harness, "kept")).toBe("a\nb\n");
	});

	it("returns 0 when no bash call is running", async () => {
		let ctx: ExtensionContext | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, eventCtx) => {
						ctx = eventCtx;
					});
					pi.on("agent_end", (_event, eventCtx) => {
						ctx = eventCtx;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("hi");
		expect(await ctx!.requestBashHandover()).toBe(0);
		expect(await ctx!.requestBashHandover({ toolCallId: "missing" })).toBe(0);
	});
});
