import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import { runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentMessage } from "../src/types.ts";

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
function response() {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
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
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
	return stream;
}

describe("input admission receipts", () => {
	for (const kind of ["prompt", "startup", "drain", "continueSteer", "continueFollowUp"] as const) {
		it(`carries ${kind} tokens separately from replaced message objects`, async () => {
			const input = user("input"),
				rider = user("rider"),
				later = user("later");
			const token = {},
				riderToken = {};
			const receipts: unknown[] = [];
			const requests: AgentMessage[][] = [];
			const agent = new Agent({
				initialState: { model },
				getMessageAdmissionToken: (message) =>
					message === input ? token : message === rider ? riderToken : undefined,
				getMessageRiders: (message) => (message === input ? [rider] : []),
				streamFn: (_model, context) => {
					requests.push([...context.messages]);
					return response();
				},
			});
			agent.subscribe((event) => {
				if (event.type === "message_start" && event.admissionToken) event.message = { ...event.message };
				if (event.type === "message_end" && event.admissionToken) receipts.push(event.admissionToken);
				if (kind === "drain" && event.type === "turn_end" && requests.length === 1) {
					agent.steer(input);
					agent.steer(later);
				}
			});
			if (kind === "prompt") await agent.prompt(input);
			else if (kind === "startup") {
				agent.steer(input);
				await agent.prompt("start");
			} else if (kind === "drain") await agent.prompt("start");
			else {
				agent.state.messages = [
					{
						role: "assistant",
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: 0,
					},
				];
				if (kind === "continueSteer") agent.steer(input);
				else agent.followUp(input);
				await agent.continue();
			}
			expect(receipts).toEqual([token, riderToken]);
			const request = requests.find((messages) => messages.includes(input));
			expect(request).toBeDefined();
			expect(request!.indexOf(rider)).toBe(request!.indexOf(input) + 1);
			if (kind === "drain") {
				expect(request).not.toContain(later);
				expect(requests).toHaveLength(3);
			}
		});
	}

	it("riders do not select requests and queued removal is identity-based", async () => {
		const input = user("same"),
			other = user("same");
		let calls = 0;
		const agent = new Agent({
			initialState: { model },
			getMessageRiders: () => [user("passive")],
			streamFn: () => {
				calls++;
				return response();
			},
		});
		agent.steer(input);
		agent.followUp(other);
		expect(agent.removeQueued(user("same"))).toBe(false);
		expect(agent.removeQueued(input)).toBe(true);
		expect(agent.peekQueuedMessages()[0]).toBe(other);
		expect(agent.removeQueued(other)).toBe(true);
		await agent.prompt("start");
		expect(calls).toBe(1);
	});

	it("removal cannot retract an admitted input and abort still receipts its riders", async () => {
		const input = user("input"),
			rider = user("rider");
		const token = {},
			riderToken = {};
		const receipts: unknown[] = [];
		let starts = 0,
			calls = 0,
			removed: boolean | undefined;
		const agent = new Agent({
			initialState: { model },
			getMessageRiders: (message) => (message === input ? [rider] : []),
			getMessageAdmissionToken: (message) =>
				message === input ? token : message === rider ? riderToken : undefined,
			streamFn: () => {
				calls++;
				return response();
			},
		});
		agent.subscribe((event) => {
			if (event.type === "turn_start" && ++starts === 2) {
				removed = agent.removeQueued(input);
				agent.abort();
			}
			if (event.type === "turn_end" && starts === 1) agent.steer(input);
			if (event.type === "message_end" && event.admissionToken) receipts.push(event.admissionToken);
		});
		await agent.prompt("start");
		expect(removed).toBe(false);
		expect(calls).toBe(1);
		expect(receipts).toEqual([token, riderToken]);
	});

	it("captures the entire drained batch before turn_start or a failed append", async () => {
		const first = user("first"),
			second = user("second"),
			third = user("third");
		const admitted: AgentMessage[] = [];
		let calls = 0,
			starts = 0;
		let atTurnStart: AgentMessage[] = [];
		const agent = new Agent({
			initialState: { model },
			steeringMode: "all",
			getMessageAdmissionToken: (message) => {
				admitted.push(message);
				return message;
			},
			streamFn: () => {
				calls++;
				return response();
			},
		});
		agent.subscribe((event) => {
			if (event.type === "turn_start" && ++starts === 2) atTurnStart = [...admitted];
			if (event.type === "turn_end" && starts === 1) {
				agent.steer(first);
				agent.steer(second);
				agent.steer(third);
			}
			if (event.type === "message_start" && event.admissionToken === second) throw new Error("append refused");
		});
		await agent.prompt("start");
		expect(atTurnStart.slice(-3)).toEqual([first, second, third]);
		expect(calls).toBe(1);
		expect(agent.hasQueuedMessages()).toBe(false);
	});

	it("does not add receipt fields to legacy caller events", async () => {
		const events: AgentEvent[] = [];
		await runAgentLoop(
			[user("start")],
			{ messages: [] },
			{ model, convertToLlm: (messages) => messages as Message[] },
			(event) => {
				events.push(event);
			},
			undefined,
			response,
		);
		for (const event of events) expect(event).not.toHaveProperty("admissionToken");
	});
});
