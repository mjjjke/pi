import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { agentLoop, agentLoopContinue, runAgentLoop, runAgentLoopContinue } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "../src/types.ts";

const model: Model<"openai-responses"> = {
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
const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 0 });
function assistant(tool = false): AssistantMessage {
	return {
		role: "assistant",
		content: tool ? [{ type: "toolCall", id: "call", name: "noop", arguments: {} }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: tool ? "toolUse" : "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function provider(onCall: () => unknown): StreamFn {
	return () => {
		const tool = onCall() === true;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message: assistant(tool) }));
		return stream;
	};
}
const config = (): AgentLoopConfig => ({ model, convertToLlm: (messages) => messages as Message[] });

// Design §15.9: no provider is used; all request streams are local fixtures.
describe("aborted preparation", () => {
	for (const entry of ["run", "continue", "stream", "streamContinue"] as const) {
		for (const abort of ["throw", "signal"] as const) {
			it(`${entry}: ${abort} abort finalizes once and completes`, async () => {
				const controller = new AbortController();
				const events: AgentEvent[] = [];
				let calls = 0;
				const cfg = config();
				cfg.prepareRequest = () => {
					if (abort === "signal") controller.abort();
					else throw new DOMException("Stopped", "AbortError");
				};
				const context = { messages: [user("existing")] };
				const emit = (event: AgentEvent) => {
					events.push(event);
				};
				const streamFn = provider(() => {
					calls++;
				});
				if (entry === "run") await runAgentLoop([user("start")], context, cfg, emit, controller.signal, streamFn);
				else if (entry === "continue") await runAgentLoopContinue(context, cfg, emit, controller.signal, streamFn);
				else {
					const stream =
						entry === "stream"
							? agentLoop([user("start")], context, cfg, controller.signal, streamFn)
							: agentLoopContinue(context, cfg, controller.signal, streamFn);
					for await (const event of stream) events.push(event);
					await stream.result();
				}
				expect(calls).toBe(0);
				expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
				const ends = events.filter((event) => event.type === "turn_end");
				expect(ends).toHaveLength(1);
				expect(ends[0].message).toMatchObject({ role: "assistant", stopReason: "aborted" });
			});
		}
	}

	for (const entry of ["run", "continue", "stream", "streamContinue"] as const) {
		for (const abort of ["throw", "signal"] as const) {
			it(`${entry}: next-turn ${abort} abort leaves queued inputs untouched`, async () => {
				const controller = new AbortController();
				const steer = user("steer"),
					follow = user("follow");
				const steering = [steer],
					followUps = [follow];
				const events: AgentEvent[] = [];
				let calls = 0;
				const cfg = config();
				cfg.hasQueuedMessages = () => ({ steering: true, followUp: true });
				// Preserve the documented run-start poll: input arrives only after request 1.
				cfg.getSteeringMessages = async () => (calls ? steering.splice(0) : []);
				cfg.getFollowUpMessages = async () => followUps.splice(0);
				cfg.prepareNextTurn = async () => {
					await Promise.resolve();
					if (abort === "signal") controller.abort();
					else throw new DOMException("Stopped", "AbortError");
				};
				const context = { messages: [user("existing")] };
				const emit = (event: AgentEvent) => {
					events.push(event);
				};
				const streamFn = provider(() => {
					calls++;
				});
				if (entry === "run") await runAgentLoop([user("start")], context, cfg, emit, controller.signal, streamFn);
				else if (entry === "continue") await runAgentLoopContinue(context, cfg, emit, controller.signal, streamFn);
				else {
					const stream =
						entry === "stream"
							? agentLoop([user("start")], context, cfg, controller.signal, streamFn)
							: agentLoopContinue(context, cfg, controller.signal, streamFn);
					for await (const event of stream) events.push(event);
					await stream.result();
				}
				expect(calls).toBe(1);
				expect(steering[0]).toBe(steer);
				expect(followUps[0]).toBe(follow);
				expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
				expect(
					events.filter(
						(event) =>
							event.type === "turn_end" &&
							event.message.role === "assistant" &&
							event.message.stopReason === "aborted",
					),
				).toHaveLength(1);
			});
		}
	}

	it("preserves non-abort preparation failures", async () => {
		const cfg = config();
		cfg.prepareRequest = () => {
			throw new Error("broken");
		};
		await expect(
			runAgentLoop(
				[user("start")],
				{ messages: [] },
				cfg,
				() => {},
				undefined,
				provider(() => {}),
			),
		).rejects.toThrow("broken");
	});

	it("keeps both queues owned during failed next-turn preparation", async () => {
		const steer = user("steer"),
			follow = user("follow");
		let calls = 0;
		let observed: AgentMessage | undefined;
		const agent = new Agent({
			initialState: { model },
			streamFn: provider(() => {
				calls++;
			}),
			prepareNextTurn: () => {
				observed = agent.peekQueuedMessages()[0];
				throw new DOMException("Stopped", "AbortError");
			},
		});
		agent.subscribe((event) => {
			if (event.type === "turn_end" && calls === 1) {
				agent.steer(steer);
				agent.followUp(follow);
			}
		});
		await agent.prompt("start");
		expect(calls).toBe(1);
		expect(observed).toBe(steer);
		expect(agent.peekQueuedMessages()[0]).toBe(steer);
		agent.clearSteeringQueue();
		expect(agent.peekQueuedMessages()[0]).toBe(follow);
	});

	it("admits steering arriving during preparation only once per turn", async () => {
		const first = user("first"),
			second = user("second");
		const requests: AgentMessage[][] = [];
		const agent = new Agent({
			initialState: { model },
			streamFn: (_model, context) => {
				requests.push([...context.messages]);
				return provider(() => {})(_model, context);
			},
			prepareNextTurn: () => {
				if (requests.length === 1) agent.steer(second);
			},
		});
		agent.subscribe((event) => {
			if (event.type === "turn_end" && requests.length === 1) agent.steer(first);
		});
		await agent.prompt("start");
		expect(requests).toHaveLength(3);
		expect(requests[1]).toContain(first);
		expect(requests[1]).not.toContain(second);
		expect(requests[2]).toContain(second);
	});

	it("ends without a request when queues are cleared during preparation", async () => {
		let calls = 0;
		const agent = new Agent({
			initialState: { model },
			streamFn: provider(() => {
				calls++;
			}),
			prepareNextTurn: () => {
				agent.clearAllQueues();
				return undefined;
			},
		});
		agent.subscribe((event) => {
			if (event.type === "turn_end" && calls === 1) agent.followUp(user("queued"));
		});
		await agent.prompt("start");
		expect(calls).toBe(1);
	});

	// Review A B1: clearing a selected queue must not discard replacement input returned by preparation.
	it("preserves prepared input when preparation removes the selected queue item", async () => {
		const prepared = user("PREPARED_INPUT");
		const ended: AgentMessage[] = [];
		const requests: AgentMessage[][] = [];
		let queued = false;
		const agent = new Agent({
			initialState: { model },
			streamFn: (_model, context) => {
				requests.push([...context.messages]);
				return provider(() => {})(_model, context);
			},
			finishTurn: () => {
				if (!queued) {
					queued = true;
					agent.followUp(user("placeholder"));
				}
			},
			prepareNextTurn: () => {
				agent.clearAllQueues();
				return { messages: [prepared] };
			},
		});
		agent.subscribe((event) => {
			if (event.type === "message_end") ended.push(event.message);
		});
		await agent.prompt("start");
		expect(agent.state.messages).toContain(prepared);
		expect(ended.filter((message) => message === prepared)).toHaveLength(1);
		expect(requests).toHaveLength(2);
		expect(requests[1]).toContain(prepared);
	});

	it("persists a drained batch once if turn_start aborts", async () => {
		const queued = user("queued");
		let calls = 0,
			starts = 0;
		const ended: AgentMessage[] = [];
		const agent = new Agent({
			initialState: { model },
			streamFn: provider(() => {
				calls++;
			}),
		});
		agent.subscribe((event) => {
			if (event.type === "turn_start" && ++starts === 2) agent.abort();
			if (event.type === "turn_end" && calls === 1 && starts === 1) agent.steer(queued);
			if (event.type === "message_end") ended.push(event.message);
		});
		await agent.prompt("start");
		expect(calls).toBe(1);
		expect(ended.filter((message) => message === queued)).toHaveLength(1);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("keeps legacy drained input on a rejected preparation", async () => {
		const cfg = config();
		const queued = user("queued");
		let polls = 0,
			calls = 0;
		cfg.getSteeringMessages = async () => (++polls === 2 ? [queued] : []);
		cfg.prepareNextTurn = () => {
			throw new DOMException("Stopped", "AbortError");
		};
		const messages = await runAgentLoop(
			[user("start")],
			{ messages: [] },
			cfg,
			() => {},
			undefined,
			provider(() => {
				calls++;
			}),
		);
		expect(calls).toBe(1);
		expect(messages.filter((message) => message === queued)).toHaveLength(1);
	});

	it("honors terminate:true but still admits a follow-up", async () => {
		let calls = 0;
		const tool: AgentTool = {
			name: "noop",
			label: "noop",
			description: "noop",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: undefined, terminate: true }),
		};
		const agent = new Agent({ initialState: { model, tools: [tool] }, streamFn: provider(() => ++calls === 1) });
		agent.followUp(user("follow"));
		await agent.prompt("start");
		expect(calls).toBe(2);
	});
});
