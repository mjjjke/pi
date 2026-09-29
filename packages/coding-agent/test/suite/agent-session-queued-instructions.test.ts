import type { AgentMessage, AgentTool, AgentTurnDecision } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolve = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Tool that blocks each call until the test releases it. */
function createBarrierTool(name = "barrier") {
	let started = deferred();
	let gate: Deferred | undefined;
	let onStart: (() => void | Promise<void>) | undefined;
	const tool: AgentTool = {
		name,
		label: name,
		description: "Blocks until released",
		parameters: Type.Object({}),
		execute: async () => {
			const current = deferred();
			gate = current;
			await onStart?.();
			started.resolve();
			await current.promise;
			return { content: [{ type: "text", text: `${name} released` }], details: {} };
		},
	};
	return {
		tool,
		/** Run inside the tool call, before it waits on the gate. */
		setOnStart(fn: () => void | Promise<void>) {
			onStart = fn;
		},
		async waitStarted() {
			await started.promise;
			started = deferred();
		},
		release() {
			gate?.resolve();
		},
	};
}

/** Role:text summary of a provider request, without the leading system prompt. */
function describeRequest(messages: ReadonlyArray<{ role: string }>): string[] {
	return messages
		.filter((message, index) => !(index === 0 && message.role === "system"))
		.map((message) => {
			const text = getMessageText(message);
			return message.role === "user" || message.role === "developer" ? `${message.role}:${text}` : message.role;
		});
}

function developerEntries(harness: Harness) {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "developer");
}

function entryKinds(harness: Harness): string[] {
	return harness.sessionManager.getEntries().map((entry) => {
		if (entry.type !== "message") return entry.type;
		const text = getMessageText(entry.message);
		return entry.message.role === "developer" || entry.message.role === "user"
			? `${entry.message.role}:${text}`
			: entry.message.role;
	});
}

describe("AgentSession.queueDeveloperMessage", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
		const harness = await createHarness(options);
		harnesses.push(harness);
		return harness;
	}

	it("commits immediately while idle and calls onCommit once with the entry id", async () => {
		const harness = await setup();
		const onCommit = vi.fn();

		const result = harness.session.queueDeveloperMessage("Idle instruction.", { onCommit });

		expect(result.status).toBe("committed");
		const entries = developerEntries(harness);
		expect(entries).toHaveLength(1);
		expect(result).toEqual({ status: "committed", entryId: entries[0]!.id });
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenCalledWith(entries[0]!.id);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["developer"]);
	});

	it("rejects blank content and calls after dispose", async () => {
		const harness = await setup();
		expect(() => harness.session.queueDeveloperMessage("   ")).toThrow(/non-blank/);
		harness.session.dispose();
		expect(() => harness.session.queueDeveloperMessage("late")).toThrow(/disposed/);
		expect(developerEntries(harness)).toHaveLength(0);
	});

	it("commits an instruction queued during a tool batch in the next request, after tool results and steers", async () => {
		const barrier = createBarrierTool();
		const harness = await setup({ tools: [barrier.tool] });
		const requests: string[][] = [];
		const onCommit = vi.fn();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("barrier", {}), { stopReason: "toolUse" }),
			(context) => {
				requests.push(describeRequest(context.messages));
				return fauxAssistantMessage("done");
			},
		]);

		const run = harness.session.prompt("start");
		await barrier.waitStarted();
		const result = harness.session.queueDeveloperMessage("Tighten.", { onCommit });
		await harness.session.steer("steer text");
		expect(result.status).toBe("pending");
		expect(developerEntries(harness)).toHaveLength(0);
		expect(onCommit).not.toHaveBeenCalled();

		barrier.release();
		await run;

		expect(requests[0]).toEqual(["user:start", "assistant", "toolResult", "user:steer text", "developer:Tighten."]);
		const entries = developerEntries(harness);
		expect(entries).toHaveLength(1);
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenCalledWith(entries[0]!.id);
		expect(entryKinds(harness)).toEqual([
			"system",
			"user:start",
			"assistant",
			"toolResult",
			"user:steer text",
			"developer:Tighten.",
			"assistant",
		]);
		const devEvents = harness.events.filter(
			(event) =>
				(event.type === "message_start" || event.type === "message_end") && event.message.role === "developer",
		);
		expect(devEvents.map((event) => event.type)).toEqual(["message_start", "message_end"]);
	});

	it("includes an instruction queued during a retry delay in the retry request", async () => {
		const harness = await setup({ settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } } });
		const requests: string[][] = [];
		let result: ReturnType<typeof harness.session.queueDeveloperMessage> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") result = harness.session.queueDeveloperMessage("Retry rule.");
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			(context) => {
				requests.push(describeRequest(context.messages));
				return fauxAssistantMessage("recovered");
			},
		]);

		await harness.session.prompt("test");

		expect(result?.status).toBe("pending");
		expect(requests[0]).toEqual(["user:test", "developer:Retry rule."]);
		expect(developerEntries(harness)).toHaveLength(1);
	});

	it("commits immediately from an agent_end handler and reaches the queued continuation's first request", async () => {
		const requests: string[][] = [];
		const results: string[] = [];
		const harness = await setup({
			extensionFactories: [
				(pi) => {
					let done = false;
					pi.on("agent_end", () => {
						if (done) return;
						done = true;
						results.push(pi.queueDeveloperMessage("From agent_end.").status);
						pi.sendUserMessage("follow-up", { deliverAs: "followUp" });
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage("first"),
			(context) => {
				requests.push(describeRequest(context.messages));
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("prompt");

		expect(results).toEqual(["committed"]);
		expect(requests[0]).toEqual(["user:prompt", "assistant", "developer:From agent_end.", "user:follow-up"]);
		expect(developerEntries(harness)).toHaveLength(1);
	});

	it("includes an instruction queued during overflow recovery in the recovery request", async () => {
		const requests: string[][] = [];
		let status: string | undefined;
		const harness = await setup({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						status ??= pi.queueDeveloperMessage("Recovery rule.").status;
						return {
							compaction: {
								summary: "overflow compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage("partial response", { stopReason: "length" }),
			(context) => {
				requests.push(describeRequest(context.messages));
				return fauxAssistantMessage("completed response");
			},
		]);

		await harness.session.prompt("x".repeat(5000));

		expect(status).toBe("pending");
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({ reason: "overflow", willRetry: true });
		expect(requests[0]?.at(-1)).toBe("developer:Recovery rule.");
		expect(developerEntries(harness)).toHaveLength(1);
		const kinds = entryKinds(harness);
		expect(kinds.indexOf("developer:Recovery rule.")).toBeGreaterThan(kinds.indexOf("compaction"));
	});

	it("keeps an instruction pending over a context-only continuation and commits it at the next anchored request", async () => {
		const echo: AgentTool = {
			name: "echo",
			label: "echo",
			description: "echo",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
		};
		const harness = await setup({ tools: [echo] });
		const sessionFinishTurn = harness.session.agent.finishTurn;
		let forced = false;
		harness.session.agent.finishTurn = async (turn, signal): Promise<AgentTurnDecision | undefined> => {
			const decision = await sessionFinishTurn?.(turn, signal);
			if (!forced) {
				forced = true;
				return { action: "continue" };
			}
			return decision ?? undefined;
		};
		const requests: string[][] = [];
		const onCommit = vi.fn();
		harness.setResponses([
			() => {
				harness.session.queueDeveloperMessage("Deferred.", { onCommit });
				return fauxAssistantMessage("first");
			},
			(context) => {
				requests.push(describeRequest(context.messages));
				expect(onCommit).not.toHaveBeenCalled();
				return fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" });
			},
			(context) => {
				requests.push(describeRequest(context.messages));
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("go");

		expect(requests[0]).toEqual(["user:go", "assistant"]);
		expect(requests[1]).toEqual(["user:go", "assistant", "assistant", "toolResult", "developer:Deferred."]);
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(developerEntries(harness)).toHaveLength(1);
	});

	it("survives clearQueue and abort, is committed at run end and reaches the next run", async () => {
		const harness = await setup();
		const requests: string[][] = [];
		const onCommit = vi.fn();
		let aborting: Promise<void> | undefined;
		const observed: number[] = [];
		harness.setResponses([
			async () => {
				expect(harness.session.queueDeveloperMessage("Survive.", { onCommit }).status).toBe("pending");
				await harness.session.steer("dropped steer");
				harness.session.clearQueue();
				aborting = harness.session.abort();
				observed.push(developerEntries(harness).length);
				return fauxAssistantMessage("partial", { stopReason: "aborted" });
			},
			(context) => {
				requests.push(describeRequest(context.messages));
				return fauxAssistantMessage("next run");
			},
		]);

		await harness.session.prompt("start");
		await aborting;

		expect(observed).toEqual([0]);
		const entries = developerEntries(harness);
		expect(entries).toHaveLength(1);
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(onCommit).toHaveBeenCalledWith(entries[0]!.id);
		expect(entryKinds(harness)).toEqual(["system", "user:start", "assistant", "developer:Survive."]);
		expect(harness.session.messages.at(-1)?.role).toBe("developer");

		await harness.session.prompt("again");
		expect(requests[0]).toEqual(["user:start", "assistant", "developer:Survive.", "user:again"]);
		expect(developerEntries(harness)).toHaveLength(1);
	});

	it("keeps exactly one entry when disposed from a message_start handler of the committed instruction", async () => {
		const barrier = createBarrierTool();
		let harness: Harness | undefined;
		harness = await setup({
			tools: [barrier.tool],
			extensionFactories: [
				(pi) => {
					pi.on("message_start", (event) => {
						if (event.message.role !== "developer") return;
						harness?.session.dispose();
						harness?.session.dispose();
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("barrier", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after"),
		]);

		const run = harness.session.prompt("start");
		await barrier.waitStarted();
		harness.session.queueDeveloperMessage("Once.");
		barrier.release();
		await run;

		expect(developerEntries(harness)).toHaveLength(1);
	});

	it("keeps exactly one entry when disposed from an async message_end handler while pending", async () => {
		const barrier = createBarrierTool();
		let harness: Harness | undefined;
		const onCommit = vi.fn();
		harness = await setup({
			tools: [barrier.tool],
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role !== "toolResult") return;
						await new Promise((resolve) => setTimeout(resolve, 0));
						harness?.session.dispose();
						harness?.session.dispose();
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("barrier", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after"),
		]);

		const run = harness.session.prompt("start");
		await barrier.waitStarted();
		harness.session.queueDeveloperMessage("Once.", { onCommit });
		barrier.release();
		await run;

		expect(developerEntries(harness)).toHaveLength(1);
		expect(onCommit).toHaveBeenCalledTimes(1);
		expect(() => harness?.session.queueDeveloperMessage("late")).toThrow(/disposed/);
	});

	it("treats lifecycle events of committed instructions as observation-only", async () => {
		const barrier = createBarrierTool();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const mutationErrors: string[] = [];
		const harness = await setup({
			tools: [barrier.tool],
			extensionFactories: [
				(pi) => {
					pi.on("message_end", (event) => {
						if (event.message.role !== "developer") return;
						try {
							(event.message.content as TextContent[])[0]!.text = "MUTATED";
						} catch (error) {
							mutationErrors.push(String(error));
						}
						try {
							(event.message as { content: unknown }).content = "MUTATED";
						} catch (error) {
							mutationErrors.push(String(error));
						}
					});
					pi.on("message_end", (event) => {
						if (event.message.role !== "developer") return;
						return { message: { ...event.message, content: [{ type: "text", text: "REPLACED" }] } };
					});
				},
			],
		});
		const requests: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("barrier", {}), { stopReason: "toolUse" }),
			(context) => {
				requests.push(describeRequest(context.messages));
				return fauxAssistantMessage("done");
			},
			(context) => {
				requests.push(describeRequest(context.messages));
				return fauxAssistantMessage("again");
			},
		]);

		const run = harness.session.prompt("start");
		await barrier.waitStarted();
		harness.session.queueDeveloperMessage([{ type: "text", text: "ORIGINAL" }]);
		barrier.release();
		await run;
		await harness.session.prompt("next");

		expect(mutationErrors).toHaveLength(2);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(requests[0]?.at(-1)).toBe("developer:ORIGINAL");
		expect(requests[1]).toContain("developer:ORIGINAL");
		const entries = developerEntries(harness);
		expect(entries).toHaveLength(1);
		expect(getMessageText(entries[0]!.type === "message" ? entries[0]!.message : undefined)).toBe("ORIGINAL");
		const developerMessages = harness.session.messages.filter((message) => message.role === "developer");
		expect(developerMessages.map((message) => getMessageText(message))).toEqual(["ORIGINAL"]);

		const header = harness.sessionManager.getHeader();
		const reloaded = SessionManager.inMemory(
			harness.tempDir,
			undefined,
			JSON.parse(JSON.stringify([header, ...harness.sessionManager.getEntries()])),
		);
		const reloadedDeveloper = reloaded
			.buildSessionContext()
			.messages.filter((message: AgentMessage) => message.role === "developer");
		expect(reloadedDeveloper.map((message) => getMessageText(message))).toEqual(["ORIGINAL"]);
	});

	it("keeps the item pending when appendMessage throws and retries at the next request without duplicates", async () => {
		const barrier = createBarrierTool();
		const harness = await setup({ tools: [barrier.tool] });
		const errors: string[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		const originalAppend = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		let failures = 0;
		vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message) => {
			if (message.role === "developer" && failures === 0) {
				failures++;
				throw new Error("disk full");
			}
			return originalAppend(message);
		});
		const requests: string[][] = [];
		const onCommit = vi.fn();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("barrier", {}), { stopReason: "toolUse" }),
			(context) => {
				requests.push(describeRequest(context.messages));
				return fauxAssistantMessage(fauxToolCall("barrier", {}), { stopReason: "toolUse" });
			},
			(context) => {
				requests.push(describeRequest(context.messages));
				return fauxAssistantMessage("done");
			},
		]);

		const run = harness.session.prompt("start");
		await barrier.waitStarted();
		harness.session.queueDeveloperMessage("Retry me.", { onCommit });
		barrier.release();
		await barrier.waitStarted();
		expect(developerEntries(harness)).toHaveLength(0);
		expect(onCommit).not.toHaveBeenCalled();
		barrier.release();
		await run;

		expect(failures).toBe(1);
		expect(errors.some((error) => error.includes("disk full"))).toBe(true);
		expect(requests[0]).not.toContain("developer:Retry me.");
		expect(requests[1]?.at(-1)).toBe("developer:Retry me.");
		expect(developerEntries(harness)).toHaveLength(1);
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("isolates a throwing onCommit callback from the commit", async () => {
		const barrier = createBarrierTool();
		const harness = await setup({ tools: [barrier.tool] });
		const errors: string[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		const requests: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("barrier", {}), { stopReason: "toolUse" }),
			(context) => {
				requests.push(describeRequest(context.messages));
				return fauxAssistantMessage("done");
			},
		]);

		const run = harness.session.prompt("start");
		await barrier.waitStarted();
		harness.session.queueDeveloperMessage("Callback throws.", {
			onCommit: () => {
				throw new Error("callback failed");
			},
		});
		barrier.release();
		await run;

		expect(requests[0]?.at(-1)).toBe("developer:Callback throws.");
		expect(developerEntries(harness)).toHaveLength(1);
		expect(errors.some((error) => error.includes("callback failed"))).toBe(true);
		expect(harness.session.getLastAssistantText()).toBe("done");
	});

	it("commits after the compaction entry when threshold compaction runs before the same request", async () => {
		const toolResult = `large-tool-result:${"x".repeat(8000)}`;
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Returns enough content to cross the compaction threshold",
			parameters: Type.Object({}),
			execute: async () => {
				harness.session.queueDeveloperMessage("After compaction.");
				return { content: [{ type: "text", text: toolResult }], details: {} };
			},
		};
		const harness: Harness = await setup({
			models: [{ id: "faux-1", contextWindow: 2600, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 400, keepRecentTokens: 1750 } },
			tools: [largeTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted history",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		const requests: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				requests.push(describeRequest(context.messages));
				return fauxAssistantMessage("finished after compaction");
			},
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		await harness.session.prompt("run the large tool");

		expect(harness.eventsOfType("compaction_start").at(-1)).toMatchObject({ reason: "threshold" });
		expect(requests[0]?.at(-1)).toBe("developer:After compaction.");
		const kinds = entryKinds(harness);
		expect(kinds.indexOf("developer:After compaction.")).toBe(kinds.indexOf("compaction") + 1);
		expect(developerEntries(harness)).toHaveLength(1);
	});
});
