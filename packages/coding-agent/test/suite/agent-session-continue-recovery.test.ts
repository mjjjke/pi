import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../../../ai/src/api/anthropic-messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});
it("keeps interrupted run prompt sections throughout the resumed tool turns", async () => {
	const h = await createHarness({
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", (event) => {
					event.systemPromptOptions.sections.review_mode = "Do not modify files; inspect only.";
				});
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({});
	const contexts: Context[] = [];
	h.setResponses([
		(context) => {
			contexts.push(structuredClone(context));
			return fauxAssistantMessage("partial", { stopReason: "aborted" });
		},
		(context) => {
			contexts.push(structuredClone(context));
			return fauxAssistantMessage([fauxToolCall("read", { path: "missing" })], { stopReason: "toolUse" });
		},
		(context) => {
			contexts.push(structuredClone(context));
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("inspect");
	expect(await h.session.continueInterrupted()).toBe(true);
	expect(contexts).toHaveLength(3);
	expect(contexts[1].messages.slice(0, contexts[0].messages.length)).toEqual(contexts[0].messages);
	expect(contexts[2].messages.slice(0, contexts[1].messages.length)).toEqual(contexts[1].messages);
	expect(getCurrentSystemPrompt(contexts[1].messages)).toContain("Do not modify files; inspect only.");
	expect(getCurrentSystemPrompt(contexts[2].messages)).toContain("Do not modify files; inspect only.");
});
it("partial exclusive tool execution continues without replaying executed calls", async () => {
	let h: Harness;
	const executed: number[] = [];
	h = await createHarness({
		tools: [
			{
				name: "probe",
				label: "probe",
				description: "probe",
				parameters: Type.Object({ n: Type.Number() }),
				executionMode: "exclusive",
				execute: async (_id, args) => {
					expect(args).toEqual(expect.objectContaining({ n: expect.any(Number) }));
					const { n } = args as { n: number };
					executed.push(n);
					if (n === 1) void h.session.abort();
					return { content: [{ type: "text", text: `executed ${n}` }], details: {} };
				},
			},
		],
	});
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("probe", { n: 1 }), fauxToolCall("probe", { n: 2 })], {
			stopReason: "toolUse",
		}),
		(context) => {
			expect(context.messages.some((m) => m.role === "toolResult")).toBe(true);
			expect(context.messages.filter((m) => m.role === "assistant").every((m) => m.stopReason !== "aborted")).toBe(
				true,
			);
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("go");
	expect(executed).toEqual([1]);
	expect(await h.session.continueInterrupted()).toBe(true);
	expect(executed).toEqual([1]);
	expect(h.faux.state.callCount).toBe(2);
});
it("refuses actual in-progress binding", async () => {
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const entry = new Promise<void>((r) => {
		entered = r;
	});
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_start", async () => {
					entered();
					await gate;
				});
			},
		],
	});
	harnesses.push(h);
	h.sessionManager.appendMessage({ role: "user", content: "go", timestamp: 1 });
	const bind = h.session.bindExtensions({});
	await entry;
	expect(await h.session.continueInterrupted()).toBe(false);
	release();
	await bind;
});
it("settled-triggered continuation keeps lifecycle observers active", async () => {
	let awake = false;
	let once = true;
	let resumed: Promise<boolean> | undefined;
	const trace: string[] = [];
	const h = await createHarness({
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("agent_settled", () => {
					if (once) {
						once = false;
						trace.push("request-continue");
						resumed = pi.continueInterrupted();
					}
				});
			},
			(pi) => {
				pi.on("agent_start", () => {
					awake = true;
					trace.push("awake");
				});
				pi.on("agent_settled", () => {
					awake = false;
					trace.push("asleep");
				});
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({});
	let awakeAtContinuedRequest: boolean | undefined;
	h.setResponses([
		fauxAssistantMessage("partial", { stopReason: "aborted" }),
		() => {
			awakeAtContinuedRequest = awake;
			trace.push(`continued-request:${awake}`);
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("go");
	await resumed;
	expect(trace).toEqual(["awake", "request-continue", "asleep", "awake", "continued-request:true", "asleep"]);
	expect(awakeAtContinuedRequest).toBe(true);
});
it("settled-triggered direct continuation keeps lifecycle observers active", async () => {
	let awake = false;
	let once = true;
	let resumed: Promise<boolean> | undefined;
	const trace: string[] = [];
	const h = await createHarness({
		settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("agent_settled", () => {
					if (once) {
						once = false;
						trace.push("request-continue");
						resumed = pi.continueInterrupted();
					}
				});
			},
			(pi) => {
				pi.on("agent_start", () => {
					awake = true;
					trace.push("awake");
				});
				pi.on("agent_settled", () => {
					awake = false;
					trace.push("asleep");
				});
			},
		],
	});
	harnesses.push(h);
	h.session.subscribe((event) => {
		if (event.type === "auto_retry_start") queueMicrotask(() => h.session.abortRetry());
	});
	await h.session.bindExtensions({});
	let awakeAtContinuedRequest: boolean | undefined;
	h.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
		() => {
			awakeAtContinuedRequest = awake;
			trace.push(`continued-request:${awake}`);
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("go");
	await resumed;
	expect(trace).toEqual(["awake", "request-continue", "asleep", "awake", "continued-request:true", "asleep"]);
	expect(awakeAtContinuedRequest).toBe(true);
});
it("keeps a forced prompt byte-identical on the resumed Anthropic wire", async () => {
	const h = await createHarness({
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", () => ({ systemPrompt: "Review-only instructions. Do not modify files." }));
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({});
	const contexts: Context[] = [];
	h.setResponses([
		(context) => {
			contexts.push(structuredClone(context));
			return fauxAssistantMessage("partial", { stopReason: "aborted" });
		},
		(context) => {
			contexts.push(structuredClone(context));
			return fauxAssistantMessage([fauxToolCall("read", { path: "missing" })], { stopReason: "toolUse" });
		},
		(context) => {
			contexts.push(structuredClone(context));
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("inspect");
	expect(await h.session.continueInterrupted()).toBe(true);
	expect(h.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
	expect(getCurrentSystemPrompt(contexts[0].messages)).toBe("Review-only instructions. Do not modify files.");
	const bodies: string[] = [];
	for (const context of contexts) {
		const result = await streamAnthropic(
			{
				...h.getModel(),
				api: "anthropic-messages",
				provider: "anthropic",
				id: "claude-opus-4-6",
				baseUrl: "https://example.test",
			},
			normalizeContext(context),
			{
				apiKey: "sk-ant-offline-test",
				maxRetries: 0,
				fetch: async (input, init) => {
					bodies.push(await new Request(input, init).text());
					return new Response(
						'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
						{ headers: { "content-type": "text/event-stream" } },
					);
				},
			},
		).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
	}
	expect(bodies).toHaveLength(3);
	for (const body of bodies.slice(1)) expect(JSON.parse(body).system).toEqual(JSON.parse(bodies[0]).system);
});
it("control: existing automatic retry preserves the forced system prefix", async () => {
	const h = await createHarness({
		settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", () => ({ systemPrompt: "Review-only instructions. Do not modify files." }));
			},
		],
	});
	harnesses.push(h);
	const contexts: Context[] = [];
	h.setResponses([
		(context) => {
			contexts.push(structuredClone(context));
			return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
		},
		(context) => {
			contexts.push(structuredClone(context));
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("inspect");
	expect(contexts).toHaveLength(2);
	expect(contexts[1].messages).toEqual(contexts[0].messages);
	expect(getCurrentSystemPrompt(contexts[1].messages)).toBe("Review-only instructions. Do not modify files.");
});
it("aborted assistant tool calls are omitted rather than executed", async () => {
	let executions = 0;
	const h = await createHarness({
		tools: [
			{
				name: "probe",
				label: "probe",
				description: "probe",
				parameters: Type.Object({}),
				execute: async () => {
					executions++;
					return { content: [{ type: "text", text: "executed" }], details: {} };
				},
			},
		],
	});
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "aborted" }),
		(context) => {
			expect(context.messages.filter((m) => m.role === "assistant")).toEqual([]);
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("go");
	expect(await h.session.continueInterrupted()).toBe(true);
	expect(executions).toBe(0);
	expect(h.faux.state.callCount).toBe(2);
});

it("allows a settled handler to await acceptance without starting before later observers", async () => {
	let once = true;
	let requests = 0;
	const trace: string[] = [];
	const h = await createHarness({
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("agent_settled", async () => {
					if (!once) return;
					once = false;
					expect(await pi.continueInterrupted()).toBe(true);
					expect(requests).toBe(1);
					trace.push("accepted");
				});
			},
			(pi) => {
				pi.on("agent_settled", () => {
					trace.push("settled");
				});
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({});
	h.setResponses([
		() => {
			requests++;
			return fauxAssistantMessage("partial", { stopReason: "aborted" });
		},
		() => {
			requests++;
			trace.push("resumed");
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("go");
	expect(requests).toBe(2);
	expect(trace).toEqual(["accepted", "settled", "resumed", "settled"]);
});
it.each(["abort", "close", "branch"] as const)(
	"cancels deferred continuation after %s during settlement",
	async (action) => {
		let once = true;
		const h = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", async () => {
						if (!once) return;
						once = false;
						expect(await pi.continueInterrupted()).toBe(true);
						if (action === "abort") await h.session.abort();
						else if (action === "close") h.session.closeAdmission();
						else h.sessionManager.resetLeaf();
					});
				},
			],
		});
		harnesses.push(h);
		await h.session.bindExtensions({});
		h.setResponses([fauxAssistantMessage("partial", { stopReason: "aborted" })]);
		await h.session.prompt("go");
		expect(h.faux.state.callCount).toBe(1);
	},
);
it("retains the forced prompt after tool execution, repeated interruptions and metadata entries, not a new prompt", async () => {
	let preflights = 0;
	let inputs = 0;
	let h: Harness;
	h = await createHarness({
		settings: { retry: { enabled: false } },
		tools: [
			{
				name: "probe",
				label: "probe",
				description: "probe",
				parameters: Type.Object({}),
				execute: async () => {
					void h.session.abort();
					return { content: [{ type: "text", text: "interrupted" }], details: {} };
				},
			},
		],
		extensionFactories: [
			(pi) => {
				pi.on("input", () => {
					inputs++;
				});
				pi.on("before_agent_start", () => {
					preflights++;
					return preflights === 1 ? { systemPrompt: "Review-only instructions." } : undefined;
				});
			},
		],
	});
	harnesses.push(h);
	await h.session.bindExtensions({});
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
		(context) => {
			expect(getCurrentSystemPrompt(context.messages)).toBe("Review-only instructions.");
			return fauxAssistantMessage("partial", { stopReason: "aborted" });
		},
		(context) => {
			expect(getCurrentSystemPrompt(context.messages)).toBe("Review-only instructions.");
			return fauxAssistantMessage("done");
		},
		(context) => {
			expect(getCurrentSystemPrompt(context.messages)).not.toBe("Review-only instructions.");
			return fauxAssistantMessage("new task done");
		},
	]);
	await h.session.prompt("inspect");
	expect(h.session.messages.some((message) => message.role === "toolResult")).toBe(true);
	h.session.setSessionName("metadata does not change projected leaf");
	expect(await h.session.continueInterrupted()).toBe(true);
	expect(await h.session.continueInterrupted()).toBe(true);
	expect(preflights).toBe(1);
	expect(inputs).toBe(1);
	await h.session.prompt("new task");
	expect(preflights).toBe(2);
	expect(inputs).toBe(2);
});
it.each(["restart", "branch", "different leaf"] as const)(
	"uses current base options before the first continued request after %s, without inventing preflight state",
	async (reason) => {
		const h = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.sections.review_mode = "Old run section.";
						return { systemPrompt: "Old forced prompt." };
					});
				},
			],
		});
		harnesses.push(h);
		h.setResponses([fauxAssistantMessage("partial", { stopReason: "aborted" })]);
		await h.session.prompt("inspect");
		const before = structuredClone(h.sessionManager.getEntries());
		const failedId = h.sessionManager.getLeafId()!;
		let resumed = h;
		if (reason === "restart") {
			const header = h.sessionManager.getHeader()!;
			resumed = await createHarness({
				sessionManager: SessionManager.inMemory(undefined, undefined, [header, ...before]),
			});
			harnesses.push(resumed);
		} else if (reason === "branch") {
			const other = h.sessionManager.appendMessage(fauxAssistantMessage("other branch"));
			await h.session.navigateTree(other);
			await h.session.navigateTree(failedId);
		} else {
			h.sessionManager.appendMessage({ role: "user", content: "another task", timestamp: Date.now() });
		}
		const base = resumed.session.systemPrompt;
		const preflight = vi.spyOn(resumed.session.extensionRunner, "emitBeforeAgentStart");
		const contexts: Context[] = [];
		resumed.setResponses([
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage([fauxToolCall("read", { path: "missing" })], { stopReason: "toolUse" });
			},
			(context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		expect(await resumed.session.continueInterrupted()).toBe(true);
		expect(contexts).toHaveLength(2);
		for (const context of contexts) expect(getCurrentSystemPrompt(context.messages)).toBe(base);
		expect(preflight).not.toHaveBeenCalled();
		expect(resumed.sessionManager.getEntries().slice(0, before.length)).toEqual(before);
		expect(
			contexts[0].messages.some((message) => message.role === "system" && message.sections?.review_mode === null),
		).toBe(true);
	},
);

it("keeps the live tool selection while restoring interrupted prompt sections", async () => {
	const h = await createHarness({
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("before_agent_start", (event) => {
					event.systemPromptOptions.sections.review_mode = "Inspect only.";
				});
			},
		],
	});
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage("partial", { stopReason: "aborted" }),
		(context) => {
			expect(h.session.getActiveToolNames()).toEqual(["read"]);
			expect(getCurrentSystemPrompt(context.messages)).toContain("Inspect only.");
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("inspect");
	h.session.setActiveToolsByName(["read"]);
	expect(await h.session.continueInterrupted()).toBe(true);
	expect(h.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
});
