import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
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

function createUserMessage(content: string): AgentMessage {
	return { role: "user", content, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages as Message[];
}

// Uses the same faux stream and low-level loop as agent-loop.test.ts; no provider requests.
describe("exclusive tool execution", () => {
	function deferred() {
		let resolve = () => {};
		const promise = new Promise<void>((done) => {
			resolve = done;
		});
		return { promise, resolve };
	}

	const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

	function startBatch(
		names: string[],
		options: {
			gates?: Record<string, ReturnType<typeof deferred>>;
			config?: Partial<AgentLoopConfig>;
			signal?: AbortSignal;
			execute?: AgentTool["execute"];
			emit?: (event: AgentEvent) => Promise<void> | void;
		} = {},
	) {
		const trace: string[] = [];
		const events: AgentEvent[] = [];
		const tools: AgentTool[] = ["parallel", "exclusive", "sequential", "invalid"].map((name) => ({
			name,
			label: name,
			description: name,
			parameters: name === "invalid" ? Type.Object({ value: Type.String() }) : Type.Object({}),
			executionMode: name === "exclusive" || name === "sequential" ? name : undefined,
			async execute(id, args, signal, onUpdate) {
				trace.push(`execute:${id}`);
				await options.gates?.[id]?.promise;
				if (options.execute) return options.execute(id, args, signal, onUpdate);
				return { content: [], details: {}, terminate: true };
			},
		}));
		let requests = 0;
		const done = runAgentLoop(
			[createUserMessage("run")],
			{ messages: [], tools },
			{ model: createModel(), convertToLlm: identityConverter, ...options.config },
			(event) => {
				events.push(event);
				if (event.type === "tool_execution_start") trace.push(`start:${event.toolCallId}`);
				if (event.type === "tool_execution_end") trace.push(`end:${event.toolCallId}`);
				return options.emit?.(event);
			},
			options.signal,
			() => {
				requests++;
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					const message =
						requests === 1
							? createAssistantMessage(
									names.map((name, i) => ({ type: "toolCall", id: String(i), name, arguments: {} })),
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]);
					response.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				});
				return response;
			},
		);
		return { done, trace, events, requests: () => requests };
	}

	it.each([
		["exclusive", "parallel"],
		["parallel", "exclusive"],
	] as const)("orders %s before %s through after-hooks and end events", async (first, second) => {
		const gate = deferred();
		const batch = startBatch([first, second], {
			config: {
				afterToolCall: async ({ toolCall }) => {
					if (toolCall.id === "0") await gate.promise;
					return undefined;
				},
			},
		});
		try {
			await flush();
			expect(batch.trace).toEqual(["start:0", "execute:0"]);
		} finally {
			gate.resolve();
		}
		await batch.done;
		expect(batch.trace).toEqual(["start:0", "execute:0", "end:0", "start:1", "execute:1", "end:1"]);
	});

	it.each(["tool_execution_update", "tool_execution_end"] as const)(
		"waits for awaited %s listeners before crossing the barrier",
		async (type) => {
			const gate = deferred();
			const batch = startBatch(["exclusive", "parallel"], {
				execute: async (_id, _args, _signal, onUpdate) => {
					onUpdate?.({ content: [], details: {} });
					return { content: [], details: {}, terminate: true };
				},
				emit: async (event) => {
					if (event.type === type && event.toolCallId === "0") await gate.promise;
				},
			});
			try {
				await flush();
				expect(batch.trace).not.toContain("start:1");
			} finally {
				gate.resolve();
			}
			await batch.done;
			expect(batch.trace.indexOf("end:0")).toBeLessThan(batch.trace.indexOf("start:1"));
		},
	);

	it("keeps two calls without a barrier concurrent", async () => {
		const gate = deferred();
		const batch = startBatch(["parallel", "parallel"], { gates: { "0": gate } });
		try {
			await flush();
			expect(batch.trace).toEqual(["start:0", "start:1", "execute:0", "execute:1", "end:1"]);
		} finally {
			gate.resolve();
		}
		await batch.done;
	});

	it("runs parallel calls between exclusives concurrently, pairs events, and emits results in source order", async () => {
		const first = deferred();
		const slow = deferred();
		const batch = startBatch(["exclusive", "parallel", "parallel", "exclusive"], {
			gates: { "0": first, "1": slow },
		});
		try {
			await flush();
			expect(batch.trace).toEqual(["start:0", "execute:0"]);
			first.resolve();
			await flush();
			expect(batch.trace).toEqual([
				"start:0",
				"execute:0",
				"end:0",
				"start:1",
				"start:2",
				"execute:1",
				"execute:2",
				"end:2",
			]);
			expect(batch.events.filter((e) => e.type === "message_end" && e.message.role === "toolResult")).toHaveLength(
				0,
			);
		} finally {
			first.resolve();
			slow.resolve();
		}
		const messages = await batch.done;
		expect(batch.trace.slice(-4)).toEqual(["end:1", "start:3", "execute:3", "end:3"]);
		expect(batch.events.flatMap((e) => (e.type === "tool_execution_end" ? [e.toolCallId] : []))).toEqual([
			"0",
			"2",
			"1",
			"3",
		]);
		expect(messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : []))).toEqual(["0", "1", "2", "3"]);
		expect(
			batch.events.flatMap((e) =>
				e.type === "message_end" && e.message.role === "toolResult" ? [e.message.toolCallId] : [],
			),
		).toEqual(["0", "1", "2", "3"]);
		expect(
			batch.events.flatMap((e) => (e.type === "turn_end" ? e.toolResults.map((m) => m.toolCallId) : [])),
		).toEqual(["0", "1", "2", "3"]);
	});

	it("prepares later segments only after the exclusive call is finalized", async () => {
		let state = "before";
		const prepared: string[] = [];
		const batch = startBatch(["exclusive", "parallel", "parallel", "exclusive"], {
			config: {
				beforeToolCall: async ({ toolCall }) => {
					prepared.push(`${toolCall.id}:${state}`);
					return undefined;
				},
				afterToolCall: async ({ toolCall }) => {
					if (toolCall.id === "0") state = "after";
					return undefined;
				},
			},
		});
		await batch.done;
		expect(prepared).toEqual(["0:before", "1:after", "2:after", "3:after"]);
	});

	it.each([
		["exclusive", "parallel", "exclusive"],
		["parallel", "exclusive", "parallel"],
	] as const)("skips calls still waiting behind a barrier on abort (%j)", async (...names) => {
		const controller = new AbortController();
		const gate = deferred();
		const batch = startBatch(names, { gates: { "0": gate }, signal: controller.signal });
		await flush();
		controller.abort();
		gate.resolve();
		const messages = await batch.done;
		expect(batch.trace).toEqual(["start:0", "execute:0", "end:0"]);
		expect(messages.flatMap((m) => (m.role === "toolResult" ? [m.toolCallId] : []))).toEqual(["0"]);
	});

	it("pairs started preflight calls on abort and does not admit later segments", async () => {
		const controller = new AbortController();
		const batch = startBatch(["parallel", "parallel", "exclusive", "parallel"], {
			signal: controller.signal,
			config: {
				beforeToolCall: async ({ toolCall }) => {
					if (toolCall.id === "1") controller.abort();
					return undefined;
				},
			},
		});
		const messages = await batch.done;
		expect(batch.trace).toEqual(["start:0", "start:1", "end:1", "end:0"]);
		expect(messages.filter((m) => m.role === "toolResult")).toMatchObject([
			{ toolCallId: "0", isError: true, content: [{ text: "Operation aborted" }] },
			{ toolCallId: "1", isError: true, content: [{ text: "Operation aborted" }] },
		]);
	});

	it.each(["tool", "config"] as const)(
		"lets sequential %s override exclusive scheduling for the whole batch",
		async (source) => {
			const gate = deferred();
			const batch = startBatch(["parallel", "parallel", "exclusive", ...(source === "tool" ? ["sequential"] : [])], {
				gates: { "0": gate },
				config: source === "config" ? { toolExecution: "sequential" } : {},
			});
			try {
				await flush();
				expect(batch.trace).toEqual(["start:0", "execute:0"]);
			} finally {
				gate.resolve();
			}
			await batch.done;
			expect(batch.trace.slice(0, 6)).toEqual(["start:0", "execute:0", "end:0", "start:1", "execute:1", "end:1"]);
		},
	);

	it.each([true, false])("aggregates terminate across every segment (all terminating: %s)", async (all) => {
		const batch = startBatch(["exclusive", "parallel", "exclusive"], {
			execute: async (id) => ({ content: [], details: {}, terminate: all || id !== "1" }),
		});
		await batch.done;
		expect(batch.requests()).toBe(all ? 1 : 2);
	});

	it("does not drain steering between segments", async () => {
		let polls = 0;
		let completed = 0;
		const seen: number[] = [];
		const batch = startBatch(["exclusive", "parallel", "exclusive"], {
			config: {
				afterToolCall: async () => {
					completed++;
					return undefined;
				},
				getSteeringMessages: async () => {
					polls++;
					seen.push(completed);
					return polls === 2 ? [createUserMessage("steer")] : [];
				},
			},
		});
		await batch.done;
		expect(seen).toEqual([0, 3, 3]);
		expect(batch.requests()).toBe(2);
	});

	it("keeps validation, blocked calls, unknown tools, failures and hook overrides on the shared pipeline", async () => {
		const batch = startBatch(["exclusive", "missing", "invalid", "parallel", "exclusive"], {
			execute: async () => {
				throw new Error("failed");
			},
			config: {
				beforeToolCall: async ({ toolCall }) =>
					toolCall.id === "0" ? { block: true, reason: "blocked" } : undefined,
				afterToolCall: async () => ({ content: [{ type: "text", text: "patched" }], isError: false }),
			},
		});
		const messages = await batch.done;
		expect(messages.filter((m) => m.role === "toolResult")).toMatchObject([
			{ toolCallId: "0", isError: true, content: [{ text: "blocked" }] },
			{ toolCallId: "1", isError: true, content: [{ text: "Tool missing not found" }] },
			{ toolCallId: "2", isError: true, content: [{ text: expect.stringContaining("value") }] },
			{ toolCallId: "3", isError: false, content: [{ text: "patched" }] },
			{ toolCallId: "4", isError: false, content: [{ text: "patched" }] },
		]);
	});
});
