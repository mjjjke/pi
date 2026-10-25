import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("AgentSession: clearQueue transfers only still-queued user input", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it("leaves custom and developer handles in their original queues", async () => {
		let harness!: Harness;
		let result: { steering: string[]; followUp: string[] } | undefined;
		let remaining: AgentMessage[] = [];
		const custom: AgentMessage = {
			role: "custom",
			customType: "task",
			content: "completion",
			display: false,
			timestamp: 0,
		};
		const developer: AgentMessage = { role: "developer", content: "restriction", timestamp: 0 };
		harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						harness.session.agent.steer(custom);
						harness.session.agent.followUp(developer);
						await harness.session.steer("user steer");
						await harness.session.followUp("user follow-up");
						result = harness.session.clearQueue();
						remaining = harness.session.agent.peekQueuedMessages();
					});
				},
			],
		});
		cleanups.push(harness.cleanup);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("start");
		expect(result).toEqual({ steering: ["user steer"], followUp: ["user follow-up"] });
		expect(remaining).toEqual([custom]);
		expect(remaining[0]).toBe(custom);
		expect(harness.session.messages.filter((m) => m.role === "custom").map(getMessageText)).toContain("completion");
		expect(harness.session.messages.filter((m) => m.role === "developer").map(getMessageText)).toContain(
			"restriction",
		);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("does not return an admitted batch from an awaited turn_start handler", async () => {
		let harness!: Harness;
		let result: { steering: string[]; followUp: string[] } | undefined;
		harness = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					let queued = false;
					pi.on("turn_end", async () => {
						if (!queued) {
							queued = true;
							await harness.session.steer("admitted");
						}
					});
					pi.on("turn_start", async (event) => {
						if (event.turnIndex === 0) return;
						await Promise.resolve();
						result = harness.session.clearQueue();
					});
				},
			],
		});
		cleanups.push(harness.cleanup);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("done")]);
		await harness.session.prompt("start");
		expect(result).toEqual({ steering: [], followUp: [] });
		expect(harness.session.messages.filter((m) => m.role === "user").map(getMessageText)).toEqual([
			"start",
			"admitted",
		]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});
});
