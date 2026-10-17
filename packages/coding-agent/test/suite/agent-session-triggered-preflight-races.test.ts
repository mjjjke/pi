import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	renderSystemMessageUpdate,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InputEvent } from "../../src/core/extensions/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const probe: AgentTool = {
	name: "probe",
	label: "Probe",
	description: "Probe a continuation",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "probed" }], details: {} }),
};

describe("triggered preflight races", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each(["steer", "followUp"] as const)(
		"handles user %s and rejects plain user prompts during custom preflight",
		async (streamingBehavior) => {
			let started = () => {};
			const preflightStarted = new Promise<void>((resolve) => {
				started = resolve;
			});
			let release = () => {};
			const preflightReleased = new Promise<void>((resolve) => {
				release = resolve;
			});
			let starts = 0;
			const inputs: InputEvent[] = [];
			const prompts: string[] = [];
			const harness = await createHarness({
				tools: [probe],
				extensionFactories: [
					(pi) => {
						pi.on("input", (event) => {
							inputs.push(event);
						});
						pi.on("before_agent_start", async (event) => {
							starts++;
							started();
							await preflightReleased;
							event.systemPromptOptions.sections.handoff = "Race goal.";
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				(context) => {
					prompts.push(getCurrentSystemPrompt(context.messages));
					return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
				},
				(context) => {
					prompts.push(getCurrentSystemPrompt(context.messages));
					return fauxAssistantMessage("done");
				},
			]);
			if (streamingBehavior === "followUp") harness.appendResponses([fauxAssistantMessage("followed")]);
			const customRun = harness.session.sendCustomMessage(
				{ customType: "notice", content: "ready", display: false },
				{ triggerTurn: true },
			);
			await preflightStarted;
			const plain = harness.session.prompt("plain").then(
				() => "started",
				(error: Error) => error.message,
			);
			const queued = harness.session.prompt("queued user", { streamingBehavior });
			// Observe rejections immediately, including on the unfixed implementation.
			const outcomes = Promise.allSettled([customRun, queued]);
			release();
			const result = await outcomes;
			const plainError = await plain;

			expect(result.map((outcome) => outcome.status)).toEqual(["fulfilled", "fulfilled"]);
			expect(plainError).toBe(
				"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
			);
			expect(starts).toBe(1);
			expect(inputs.map((event) => event.streamingBehavior)).toEqual([undefined, streamingBehavior]);
			expect(harness.session.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
				"queued user",
			]);
			for (const prompt of prompts) expect(prompt).toContain("Race goal.");
			expect(
				harness.session.messages
					.filter((message) => message.role === "system")
					.map(renderSystemMessageUpdate)
					.join("\n"),
			).not.toContain('Removed system prompt section "handoff"');
			expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it("rejects an older user preflight without mutating the custom run that won the start", async () => {
		let started = () => {};
		const userPreflightStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let releaseUser = () => {};
		const userPreflightReleased = new Promise<void>((resolve) => {
			releaseUser = resolve;
		});
		let toolStarted = () => {};
		const toolExecutionStarted = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		let releaseTool = () => {};
		const toolReleased = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const prompts: string[] = [];
		const harness = await createHarness({
			tools: [
				{
					...probe,
					execute: async () => {
						toolStarted();
						await toolReleased;
						return { content: [{ type: "text", text: "probed" }], details: {} };
					},
				},
			],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (event.messageType === "user") {
							event.systemPromptOptions.sections.handoff = "Losing user goal.";
							event.systemPromptOptions.selectedTools = [];
						} else event.systemPromptOptions.sections.handoff = "Winning custom goal.";
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				prompts.push(getCurrentSystemPrompt(context.messages));
				return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
			},
			(context) => {
				prompts.push(getCurrentSystemPrompt(context.messages));
				return fauxAssistantMessage("done");
			},
		]);
		// Upstream reserves the run before before_agent_start. Hold the earlier auth phase
		// instead, after the user has already made its idle/queue decision.
		const checkAuth = harness.session.modelRuntime.checkAuth.bind(harness.session.modelRuntime);
		vi.spyOn(harness.session.modelRuntime, "hasConfiguredAuth").mockReturnValueOnce(false);
		vi.spyOn(harness.session.modelRuntime, "checkAuth").mockImplementationOnce(async (provider, options) => {
			started();
			await userPreflightReleased;
			return checkAuth(provider, options);
		});
		const userOutcome = harness.session.prompt("user").then(
			() => "started",
			(error: Error) => error.message,
		);
		await userPreflightStarted;
		const customRun = harness.session.sendCustomMessage(
			{ customType: "notice", content: "ready", display: false },
			{ triggerTurn: true },
		);
		await toolExecutionStarted;
		const winningPrompt = harness.session.systemPrompt;
		releaseUser();
		const userError = await userOutcome;
		const stillStreaming = harness.session.isStreaming;
		const remainingPrompt = harness.session.systemPrompt;
		const remainingTools = harness.session.getActiveToolNames();
		releaseTool();
		await customRun;

		expect(userError).toContain("Agent is already processing");
		expect(stillStreaming).toBe(true);
		expect(remainingPrompt).toBe(winningPrompt);
		expect(remainingTools).toEqual(["probe"]);
		expect(prompts).toHaveLength(2);
		for (const prompt of prompts) expect(prompt).toContain("Winning custom goal.");
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(harness.session.messages.filter((message) => message.role === "user")).toEqual([]);
	});

	it("keeps a passive preflight message after the earlier triggering custom message", async () => {
		let started = () => {};
		const preflightStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release = () => {};
		const preflightReleased = new Promise<void>((resolve) => {
			release = resolve;
		});
		const requestTexts: string[][] = [];
		const harness = await createHarness({
			tools: [probe],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						started();
						await preflightReleased;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				requestTexts.push(context.messages.filter((message) => message.role !== "system").map(getMessageText));
				return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
			},
			(context) => {
				requestTexts.push(context.messages.filter((message) => message.role !== "system").map(getMessageText));
				return fauxAssistantMessage("done");
			},
		]);
		const run = harness.session.sendCustomMessage(
			{ customType: "notice", content: "trigger", display: false },
			{ triggerTurn: true },
		);
		await preflightStarted;
		await harness.session.sendCustomMessage(
			{ customType: "aside", content: "passive", display: false },
			{ triggerTurn: false },
		);
		release();
		await run;

		expect(harness.session.messages.filter((message) => message.role === "custom").map(getMessageText)).toEqual([
			"trigger",
			"passive",
		]);
		expect(requestTexts[0]).toEqual(["trigger"]);
		expect(requestTexts[1]).toContain("passive");
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"custom",
			"assistant",
			"toolResult",
			"custom",
			"assistant",
		]);
	});
});
