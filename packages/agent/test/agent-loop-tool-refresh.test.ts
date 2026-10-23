import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type SystemMessage,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, type AgentTool, type StreamFn } from "../src/index.ts";

function reply(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createTool(name: string, executed: string[]): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({}),
		execute: async () => {
			executed.push(name);
			return { content: [{ type: "text", text: name }], details: {} };
		},
	};
}

/** Scripted stream: the first response calls `firstCall`, the second calls `secondCall`, then stops. */
function scriptedStream(requests: Message[][], calls: string[]): StreamFn {
	return (_model, context) => {
		requests.push(context.messages.slice());
		const index = requests.length - 1;
		const name = calls[index];
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message = name
				? reply([{ type: "toolCall", id: `call_${index}`, name, arguments: {} }], "toolUse")
				: reply([{ type: "text", text: "done" }], "stop");
			stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
		});
		return stream;
	};
}

function declared(messages: Message[]): string[] {
	return messages.flatMap((message) =>
		message.role === "system" ? ((message as SystemMessage).toolsAdded ?? []).map((tool) => tool.name) : [],
	);
}

describe("agent loop tool refresh at the request boundary", () => {
	it("without getTools, a prepareNextTurnWithContext loadout is declared and executed as today", async () => {
		const executed: string[] = [];
		const first = createTool("first", executed);
		const extra = createTool("extra", executed);
		const requests: Message[][] = [];
		const agent = new Agent({
			initialState: { systemPrompt: "base", tools: [first] },
			streamFn: scriptedStream(requests, ["first", "extra"]),
			prepareNextTurnWithContext: (turn) => ({ context: { ...turn.context, tools: [first, extra] } }),
		});

		await agent.prompt("go");

		expect(executed).toEqual(["first", "extra"]);
		expect(declared(requests[1]!)).toEqual(["first", "extra"]);
		expect(agent.state.tools.map((tool) => tool.name)).toEqual(["first"]);
	});

	it("with getTools set, a boundary whose prepareNextTurn returned a context uses that context's tools", async () => {
		const executed: string[] = [];
		const first = createTool("first", executed);
		const extra = createTool("extra", executed);
		const stateOnly = createTool("state_only", executed);
		const requests: Message[][] = [];
		let turns = 0;
		const agent = new Agent({
			initialState: { systemPrompt: "base", tools: [first] },
			streamFn: scriptedStream(requests, ["first", "extra"]),
			prepareNextTurnWithContext: (turn) => {
				turns++;
				return turns === 1 ? { context: { ...turn.context, tools: [first, extra] } } : undefined;
			},
		});
		agent.getTools = () => agent.state.tools.slice();
		agent.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === "first") {
				agent.state.tools = [first, stateOnly];
			}
		});

		await agent.prompt("go");

		expect(executed).toEqual(["first", "extra"]);
		expect(declared(requests[1]!)).toEqual(["first", "extra"]);
		// The next boundary has no replacement context, so the live state is declared there.
		expect(declared(requests[2]!)).toContain("state_only");
	});

	it("with getTools set, the first request declares a tool added to state in agent_start", async () => {
		const executed: string[] = [];
		const first = createTool("first", executed);
		const late = createTool("late", executed);
		const requests: Message[][] = [];
		const agent = new Agent({
			initialState: { systemPrompt: "base", tools: [first] },
			streamFn: scriptedStream(requests, ["late"]),
		});
		agent.getTools = () => agent.state.tools.slice();
		agent.subscribe((event) => {
			if (event.type === "agent_start") agent.state.tools = [first, late];
		});

		await agent.prompt("go");

		expect(declared(requests[0]!)).toEqual(["first", "late"]);
		expect(executed).toEqual(["late"]);
	});
});
