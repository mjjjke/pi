import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemMessage,
	getCurrentSystemPrompt,
	type ImageContent,
	renderSystemMessageUpdate,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BeforeAgentStartEvent } from "../../src/core/extensions/index.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
import { createHarness, type Harness } from "./harness.ts";

const probe: AgentTool = {
	name: "probe",
	label: "Probe",
	description: "Probe the next turn",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "probed" }], details: {} }),
};

const image: ImageContent = { type: "image", data: "ZmFrZQ==", mimeType: "image/png" };

describe("triggered custom-message prompt preflight", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	for (const deferred of [false, true]) {
		for (const content of [
			"/literal notification",
			[{ type: "text" as const, text: "/literal" }, image, { type: "text" as const, text: "notification" }],
		]) {
			it(`preserves extension sections through a tool turn (${deferred ? "deferred" : "immediate"}, ${typeof content === "string" ? "text" : "blocks"})`, async () => {
				const starts: BeforeAgentStartEvent[] = [];
				const requests: Array<{ section: string | null | undefined; prompt: string }> = [];
				let settled = false;
				let settlementComplete = false;
				const settlementAtStart: boolean[] = [];
				const notification: Pick<CustomMessage, "customType" | "content" | "display" | "details"> = {
					customType: "task-notification",
					content,
					display: true,
					details: { taskId: "child", status: "completed" },
				};
				const harness = await createHarness({
					tools: [probe],
					extensionFactories: [
						(pi) => {
							pi.on("before_agent_start", (event) => {
								starts.push(event);
								settlementAtStart.push(settlementComplete);
								event.systemPromptOptions.sections.handoff = "Keep the handoff goal.";
							});
							if (deferred) {
								pi.on("agent_settled", () => {
									if (settled) return;
									settled = true;
									pi.sendMessage(notification, { triggerTurn: true });
								});
								pi.on("agent_settled", () => {
									settlementComplete = true;
								});
							}
							pi.on("input", () => {
								if (starts.length > 0) throw new Error("Custom messages must skip input handlers");
							});
						},
					],
				});
				harnesses.push(harness);
				const errors: string[] = [];
				await harness.session.bindExtensions({ onError: (event) => errors.push(event.error) });
				harness.setResponses([
					fauxAssistantMessage("first"),
					(context) => {
						requests.push({
							section: getCurrentSystemMessage(context.messages)?.sections?.handoff,
							prompt: getCurrentSystemPrompt(context.messages),
						});
						return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
					},
					(context) => {
						requests.push({
							section: getCurrentSystemMessage(context.messages)?.sections?.handoff,
							prompt: getCurrentSystemPrompt(context.messages),
						});
						return fauxAssistantMessage("done");
					},
				]);

				await harness.session.prompt("work");
				if (!deferred) await harness.session.sendCustomMessage(notification, { triggerTurn: true });

				expect(requests.map((request) => request.section)).toEqual([
					"<handoff>\nKeep the handoff goal.\n</handoff>",
					"<handoff>\nKeep the handoff goal.\n</handoff>",
				]);
				expect(requests[0]?.prompt).toBe(requests[1]?.prompt);
				expect(starts).toHaveLength(2);
				if (deferred) expect(settlementAtStart).toEqual([false, true]);
				expect(starts[1]?.prompt).toBe(typeof content === "string" ? content : "/literal\nnotification");
				expect(starts[1]?.images).toEqual(typeof content === "string" ? undefined : [image]);
				expect(errors).toEqual([]);
				expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
				expect(harness.session.messages.find((message) => message.role === "custom")).toMatchObject(notification);
				const systemMessages = harness.session.messages.filter((message) => message.role === "system");
				expect(systemMessages.filter((message) => message.sections?.handoff !== undefined)).toHaveLength(1);
				expect(systemMessages.map(renderSystemMessageUpdate).join("\n")).not.toContain(
					'Removed system prompt section "handoff"',
				);
				expect(harness.getPendingResponseCount()).toBe(0);
			});
		}
	}

	it.each(["live", "explicit"] as const)(
		"honors %s hook tool selection and returned messages on a first custom run",
		async (selection) => {
			let starts = 0;
			const providerTools: string[][] = [];
			const providerPrompts: string[] = [];
			const harness = await createHarness({
				tools: [probe],
				initialActiveToolNames: [],
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", (event) => {
							starts++;
							event.systemPromptOptions.sections.handoff = "First custom run goal.";
							if (selection === "explicit") {
								pi.setActiveTools([]);
								event.systemPromptOptions.selectedTools = ["probe"];
							} else {
								pi.setActiveTools(["probe"]);
							}
							return { message: { customType: "preflight-context", content: "hook context", display: false } };
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([
				(context) => {
					providerTools.push(
						(getCurrentSystemMessage(context.messages)?.toolsAdded ?? []).map((tool) => tool.name),
					);
					providerPrompts.push(getCurrentSystemPrompt(context.messages));
					return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
				},
				(context) => {
					providerPrompts.push(getCurrentSystemPrompt(context.messages));
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.sendCustomMessage(
				{ customType: "task-notification", content: "ready", display: true },
				{ triggerTurn: true },
			);

			expect(starts).toBe(1);
			expect(providerTools).toEqual([["probe"]]);
			expect(providerPrompts).toHaveLength(2);
			for (const prompt of providerPrompts) expect(prompt).toContain("First custom run goal.");
			expect(harness.session.messages.map((message) => message.role)).toEqual([
				"system",
				"custom",
				"custom",
				"assistant",
				"toolResult",
				"assistant",
			]);
			expect(harness.session.messages[2]).toMatchObject({
				customType: "preflight-context",
				content: "hook context",
			});
			expect(harness.eventsOfType("tool_execution_end")[0]?.isError).toBe(false);
		},
	);

	it("rebuilds run-specific sections rather than retaining stale hook contributions", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (event.prompt === "work") event.systemPromptOptions.sections.temporary = "Only for user work.";
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("done")]);
		await harness.session.prompt("work");
		await harness.session.sendCustomMessage(
			{ customType: "notice", content: "ready", display: false },
			{ triggerTurn: true },
		);
		expect(
			harness.session.messages
				.filter((message) => message.role === "system")
				.map((message) => message.sections?.temporary),
		).toEqual(["<temporary>\nOnly for user work.\n</temporary>", null]);
	});

	it("honors a forced prompt throughout a triggered tool run", async () => {
		const prompts: string[] = [];
		const harness = await createHarness({
			tools: [probe],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({ systemPrompt: "Exact forced prompt." }));
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
		await harness.session.sendCustomMessage(
			{ customType: "notice", content: "ready", display: false },
			{ triggerTurn: true },
		);
		expect(prompts).toEqual(["Exact forced prompt.", "Exact forced prompt."]);
	});

	it("cancels a triggered run when admission closes during its preflight", async () => {
		let started = () => {};
		const preflightStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release = () => {};
		const preflightReleased = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						started();
						await preflightReleased;
						event.systemPromptOptions.sections.handoff = "Cancelled goal.";
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain queued")]);
		const run = harness.session.sendCustomMessage(
			{ customType: "notice", content: "ready", display: false },
			{ triggerTurn: true },
		);
		await preflightStarted;
		harness.session.closeAdmission();
		release();
		await expect(run).rejects.toThrow("prompt cancelled: session shutting down");
		expect(harness.session.messages).toEqual([]);
		expect(harness.eventsOfType("agent_start")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("cancels deferred triggered work when a later settled handler closes admission", async () => {
		let starts = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						starts++;
					});
					pi.on("agent_settled", () => {
						pi.sendMessage({ customType: "notice", content: "ready", display: false }, { triggerTurn: true });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") harness.session.closeAdmission();
		});
		harness.setResponses([fauxAssistantMessage("done"), fauxAssistantMessage("must remain queued")]);
		await harness.session.prompt("work");
		expect(starts).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages.filter((message) => message.role === "custom")).toEqual([]);
	});

	for (const deliverAs of ["steer", "followUp"] as const) {
		for (const source of ["custom", "user"] as const) {
			it(`keeps the prepared run for ${source} ${deliverAs} delivery from agent_end`, async () => {
				let starts = 0;
				let queued = false;
				const prompts: string[] = [];
				const harness = await createHarness({
					tools: [probe],
					extensionFactories: [
						(pi) => {
							pi.on("before_agent_start", (event) => {
								starts++;
								event.systemPromptOptions.sections.handoff = "Queued goal.";
							});
							pi.on("agent_end", () => {
								if (queued) return;
								queued = true;
								pi.appendDeveloperMessage("Passive boundary instruction.");
								if (source === "custom")
									pi.sendMessage(
										{ customType: "notice", content: "queued", display: false },
										{ triggerTurn: true, deliverAs },
									);
								else pi.sendUserMessage("queued", { deliverAs });
							});
						},
					],
				});
				harnesses.push(harness);
				harness.setResponses([
					fauxAssistantMessage("first"),
					(context) => {
						prompts.push(getCurrentSystemPrompt(context.messages));
						return fauxAssistantMessage(fauxToolCall("probe", {}), { stopReason: "toolUse" });
					},
					(context) => {
						prompts.push(getCurrentSystemPrompt(context.messages));
						return fauxAssistantMessage("done");
					},
				]);
				await harness.session.prompt("work");
				expect(starts).toBe(1);
				expect(prompts).toHaveLength(2);
				for (const prompt of prompts) expect(prompt).toContain("Queued goal.");
				expect(harness.getPendingResponseCount()).toBe(0);
			});
		}
	}
});
