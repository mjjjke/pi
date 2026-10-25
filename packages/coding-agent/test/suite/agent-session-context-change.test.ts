import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI, SessionContextChangeEvent } from "../../src/index.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

/**
 * A8: `session_context_change` fires once per committed draft compaction, draft context edit and recovery
 * omission, after the whole batch is committed, inside the compaction-notice capture (a passive send from it
 * is written at the next request boundary). Aborting while it is awaited arms no retry or recovery compaction.
 */

type Trace = Array<{ id: string; type: string; onBranch: boolean }>;

function observe(trace: Trace, onChange?: (pi: ExtensionAPI, event: SessionContextChangeEvent) => unknown) {
	return (pi: ExtensionAPI) => {
		pi.on("session_context_change", async (event, ctx) => {
			trace.push({
				id: event.entry.id,
				type: event.entry.type,
				onBranch: ctx.sessionManager.getBranch().some((entry) => entry.id === event.entry.id),
			});
			await Promise.resolve();
			await onChange?.(pi, event);
		});
	};
}

function changes(harness: Harness) {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "compaction" || entry.type === "context_edit");
}

describe("session_context_change (A8)", () => {
	const cleanups: Array<() => void | Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(options: HarnessOptions): Promise<Harness> {
		const harness = await createHarness(options);
		cleanups.push(() => harness.cleanup());
		await harness.session.bindExtensions({});
		return harness;
	}

	for (const position of ["turn_end", "agent_before_settle"] as const) {
		it(`a draft edit batch from ${position}: one event per edit, after the batch commit; passive sends reach the next request`, async () => {
			const trace: Trace = [];
			let armed = false;
			let inputId = "";
			const requests: string[][] = [];
			const harness = await setup({
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					observe(trace, (pi, event) => {
						pi.sendMessage(
							{ customType: "change-notice", content: `CHANGED ${event.entry.type}`, display: false },
							{ triggerTurn: false },
						);
					}),
					(pi) => {
						const draft = (event: { entries: unknown[] }) => {
							if (!armed) return;
							armed = false;
							return {
								entries: [
									...(event.entries as never[]),
									{ type: "context_edit" as const, targetId: inputId, replacement: { content: "one" } },
									{ type: "context_edit" as const, targetId: inputId, replacement: { content: "two" } },
									{
										type: "custom_message" as const,
										customType: "continue",
										content: "CONTINUE",
										display: false,
									},
								],
								continue: true,
							};
						};
						if (position === "turn_end") pi.on("turn_end", draft);
						else pi.on("agent_before_settle", draft);
					},
				],
			});
			harness.setResponses([
				fauxAssistantMessage("SEED"),
				fauxAssistantMessage("RUN"),
				(context: Context) => {
					requests.push(context.messages.map(getMessageText));
					return fauxAssistantMessage("CONTINUED");
				},
			]);
			await harness.session.prompt("seed");
			inputId = harness.sessionManager
				.getBranch()
				.find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
			armed = true;
			await harness.session.prompt("run");
			const committed = changes(harness);
			expect(committed).toHaveLength(2);
			expect(trace).toEqual(committed.map((entry) => ({ id: entry.id, type: "context_edit", onBranch: true })));
			expect(requests).toHaveLength(1);
			expect(requests[0].filter((text) => text.startsWith("CHANGED"))).toEqual([
				"CHANGED context_edit",
				"CHANGED context_edit",
			]);
		});
	}

	it("a rejected draft batch emits nothing", async () => {
		const trace: Trace = [];
		let armed = false;
		let inputId = "";
		const harness = await setup({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				observe(trace),
				(pi) => {
					pi.on("turn_end", (event) => {
						if (!armed) return;
						armed = false;
						return {
							entries: [
								...event.entries,
								{ type: "context_edit", targetId: inputId, replacement: { content: "one" } },
								{ type: "context_edit", targetId: "missing-id", replacement: { content: "two" } },
							],
						};
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("SEED"), fauxAssistantMessage("RUN")]);
		await harness.session.prompt("seed");
		inputId = harness.sessionManager.getBranch().find((entry) => entry.type === "message")!.id;
		armed = true;
		await harness.session.prompt("run");
		expect(changes(harness)).toHaveLength(0);
		expect(trace).toEqual([]);
	});

	it("a draft compaction emits it once and no session_compact", async () => {
		const trace: Trace = [];
		let compactEvents = 0;
		let armed = false;
		let inputId = "";
		const harness = await setup({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				observe(trace),
				(pi) => {
					pi.on("session_compact", () => {
						compactEvents++;
					});
					pi.on("turn_end", (event) => {
						if (!armed) return;
						armed = false;
						return {
							entries: [...event.entries, { type: "compaction", summary: "DRAFT", firstKeptEntryId: inputId }],
						};
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("SEED"), fauxAssistantMessage("RUN")]);
		await harness.session.prompt("seed");
		inputId = harness.sessionManager.getBranch().find((entry) => entry.type === "message")!.id;
		armed = true;
		await harness.session.prompt("run");
		expect(trace.map((item) => item.type)).toEqual(["compaction"]);
		expect(compactEvents).toBe(0);
	});

	it("three retry omissions: one event each, in order", async () => {
		const trace: Trace = [];
		const harness = await setup({
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionFactories: [observe(trace)],
		});
		harness.setResponses([
			...Array.from({ length: 3 }, () =>
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			),
			fauxAssistantMessage("success"),
		]);
		await harness.session.prompt("work");
		const committed = changes(harness);
		expect(committed).toHaveLength(3);
		expect(trace.map((item) => item.id)).toEqual(committed.map((entry) => entry.id));
		expect(trace.every((item) => item.onBranch)).toBe(true);
	});

	it("overflow recovery omissions emit it before the recovery compaction", async () => {
		const order: string[] = [];
		const harness = await setup({
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_context_change", (event) => {
						order.push(`change:${event.entry.type}`);
					});
					pi.on("session_before_compact", (event) => {
						order.push("compaction");
						return {
							compaction: {
								summary: "S",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(`OLD ${"a".repeat(400)}`),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
			fauxAssistantMessage("RETRIED"),
		]);
		await harness.session.prompt(`OLD ${"o".repeat(400)}`);
		await harness.session.prompt("OVERFLOW");
		expect(order).toEqual(["change:context_edit", "compaction"]);
	});

	it("abort while the retry omission event is awaited: the run settles, no retry is armed", async () => {
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await setup({
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 60000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_context_change", async () => {
						enter();
						await gate;
					});
				},
			],
		});
		cleanups.push(() => {
			release();
			harness.session.abortRetry();
		});
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })]);
		let settled = false;
		const run = harness.session.prompt("retry").then(() => {
			settled = true;
		});
		await entered;
		const aborted = harness.session.abort();
		release();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(harness.session.isRetrying).toBe(false);
		expect(settled).toBe(true);
		await run;
		await aborted;
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({ success: false });
	});

	it("abort while the overflow omission event is awaited: no recovery compaction starts", async () => {
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let compactions = 0;
		const harness = await setup({
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_context_change", async () => {
						enter();
						await gate;
					});
					pi.on("session_before_compact", () => {
						compactions++;
						return undefined;
					});
				},
			],
		});
		cleanups.push(() => release());
		harness.setResponses([
			fauxAssistantMessage(`OLD ${"a".repeat(400)}`),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
		]);
		await harness.session.prompt(`OLD ${"o".repeat(400)}`);
		let settled = false;
		const run = harness.session.prompt("OVERFLOW").then(() => {
			settled = true;
		});
		await entered;
		const aborted = harness.session.abort();
		release();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(settled).toBe(true);
		await run;
		await aborted;
		expect(compactions).toBe(0);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.session.isCompacting).toBe(false);
	});

	it.skipIf(process.getuid?.() === 0)("a failed write of a notice sent from it refuses the next request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-change-"));
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		let file = "";
		let calls = 0;
		cleanups.push(() => {
			if (file) chmodSync(file, 0o644);
			rmSync(dir, { recursive: true, force: true });
		});
		const harness = await setup({
			sessionManager,
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_context_change", () => {
						pi.sendMessage(
							{ customType: "change-notice", content: "INVALIDATE", display: false },
							{ triggerTurn: false },
						);
						chmodSync(file, 0o444);
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage("seed"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			() => {
				calls++;
				return fauxAssistantMessage("UNEXPECTED");
			},
		]);
		await harness.session.prompt("seed");
		file = sessionManager.getSessionFile()!;
		await harness.session.prompt("run");
		expect(sessionManager.getPersistenceError()?.code).toBe("EACCES");
		expect(calls).toBe(0);
		expect(harness.session.isStreaming).toBe(false);
		const pending = (harness.session as unknown as { _customStore: Map<unknown, { handle: { customType: string } }> })
			._customStore;
		expect([...pending.values()].map((item) => item.handle.customType)).toEqual(["change-notice"]);
	});

	/** Edits the first user entry once, from `position`; the change handler sends a passive notice (and a follow-up). */
	function editThenNotice(position: "turn_end" | "agent_before_settle", followUp: boolean) {
		let armed = true;
		return (pi: ExtensionAPI) => {
			const draft = (
				event: { entries: unknown[] },
				ctx: { sessionManager: { getBranch(): SessionEntryLike[] } },
			) => {
				if (!armed) return;
				armed = false;
				const targetId = ctx.sessionManager
					.getBranch()
					.find((entry) => entry.type === "message" && entry.message?.role === "user")!.id;
				return {
					entries: [
						...(event.entries as never[]),
						{ type: "context_edit" as const, targetId, replacement: { content: "EDITED" } },
					],
				};
			};
			if (position === "turn_end") pi.on("turn_end", draft as never);
			else pi.on("agent_before_settle", draft as never);
			pi.on("session_context_change", () => {
				pi.sendMessage({ customType: "notice", content: "PASSIVE NOTICE", display: false }, { triggerTurn: false });
				if (followUp) pi.sendUserMessage("FOLLOWUP", { deliverAs: "followUp" });
			});
		};
	}

	function journalTexts(harness: Harness): string[] {
		return harness.sessionManager.buildSessionProjection().messages.map(getMessageText);
	}

	for (const position of ["turn_end", "agent_before_settle"] as const) {
		it(`${position} edit + passive notice + queued follow-up: one request, follow-up before the notice`, async () => {
			const requests: string[][] = [];
			const harness = await setup({
				settings: { compaction: { enabled: false } },
				extensionFactories: [editThenNotice(position, true)],
			});
			harness.setResponses([
				fauxAssistantMessage("DONE"),
				...Array.from({ length: 3 }, () => (context: Context) => {
					requests.push(context.messages.map(getMessageText));
					return fauxAssistantMessage("REPLY");
				}),
			]);
			await harness.session.prompt("WORK");
			expect(requests).toHaveLength(1);
			const tail = requests[0].slice(-2);
			expect(tail).toEqual(["FOLLOWUP", "PASSIVE NOTICE"]);
			// The journal holds exactly what was sent, then the reply.
			expect(journalTexts(harness)).toEqual([...requests[0], "REPLY"]);
		});

		it(`${position} edit + passive notice, no follow-up: no extra request, the notice is written at run end`, async () => {
			let calls = 0;
			const harness = await setup({
				settings: { compaction: { enabled: false } },
				extensionFactories: [editThenNotice(position, false)],
			});
			harness.setResponses([
				fauxAssistantMessage("DONE"),
				() => {
					calls++;
					return fauxAssistantMessage("UNEXPECTED");
				},
			]);
			await harness.session.prompt("WORK");
			expect(calls).toBe(0);
			expect(journalTexts(harness).slice(-2)).toEqual(["DONE", "PASSIVE NOTICE"]);
		});
	}

	for (const variant of ["explicit continuation", "queued follow-up", "draft compaction"] as const) {
		it(`dispose while the agent_before_settle change event is awaited (${variant}): no request after disposal`, async () => {
			let armed = true;
			let enter!: () => void;
			let release!: () => void;
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let calls = 0;
			const harness = await setup({
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("agent_before_settle", (event, ctx) => {
							if (!armed) return;
							armed = false;
							const target = ctx.sessionManager
								.getBranch()
								.find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
							if (variant === "queued follow-up") pi.sendUserMessage("FOLLOWUP", { deliverAs: "followUp" });
							const change =
								variant === "draft compaction"
									? { type: "compaction" as const, summary: "DRAFT", firstKeptEntryId: target }
									: { type: "context_edit" as const, targetId: target, replacement: { content: "EDITED" } };
							return {
								entries: [
									...event.entries,
									change,
									...(variant === "queued follow-up"
										? []
										: [
												{
													type: "custom_message" as const,
													customType: "continue",
													content: "CONTINUE",
													display: false,
												},
											]),
								],
								continue: variant !== "queued follow-up",
							};
						});
						pi.on("session_context_change", async () => {
							enter();
							await gate;
						});
					},
				],
			});
			cleanups.push(() => release());
			harness.setResponses([
				fauxAssistantMessage("DONE"),
				() => {
					calls++;
					return fauxAssistantMessage("UNEXPECTED");
				},
			]);
			const run = harness.session.prompt("WORK");
			await entered;
			harness.session.dispose();
			release();
			await run;
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(calls).toBe(0);
			expect(harness.session.isStreaming).toBe(false);
		});
	}

	const turnEndDisposalVariants = [
		"queued follow-up",
		"queued follow-up, threshold compaction with an extension summary",
		"queued follow-up, threshold compaction with the default summarizer",
		"natural tool continuation",
	] as const;
	for (const variant of turnEndDisposalVariants) {
		it(`dispose while the turn_end change event is awaited (${variant}): the loop ends, no compaction, no adapter call`, async () => {
			let armed = true;
			let enter!: () => void;
			let release!: () => void;
			const entered = new Promise<void>((resolve) => {
				enter = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const compacting = variant.includes("compaction");
			const tool: AgentTool = {
				name: "noop",
				label: "Noop",
				description: "Noop",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
			};
			let compactions = 0;
			let calls = 0;
			const harness = await setup({
				tools: [tool],
				// 20k window, threshold 2k: the ~2.5k-token reply fits the model but crosses the threshold.
				models: [{ id: "faux-1", contextWindow: 20000, maxTokens: 4000 }],
				settings: {
					compaction: compacting
						? { enabled: true, reserveTokens: 18000, keepRecentTokens: 10 }
						: { enabled: false },
				},
				extensionFactories: [
					(pi) => {
						pi.on("turn_end", (event, ctx) => {
							if (!armed) return;
							armed = false;
							if (variant !== "natural tool continuation")
								pi.sendUserMessage("FOLLOWUP", { deliverAs: "followUp" });
							const targetId = ctx.sessionManager
								.getBranch()
								.find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
							return {
								entries: [
									...event.entries,
									{ type: "context_edit", targetId, replacement: { content: "EDITED" } },
								],
							};
						});
						pi.on("session_context_change", async () => {
							enter();
							await gate;
						});
						pi.on("session_before_compact", (event) => {
							compactions++;
							if (!variant.includes("extension summary")) return;
							return {
								compaction: {
									summary: "SUMMARY",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			cleanups.push(() => release());
			harness.setResponses([
				variant === "natural tool continuation"
					? fauxAssistantMessage(fauxToolCall("noop", {}), { stopReason: "toolUse" })
					: fauxAssistantMessage(`DONE ${"x".repeat(10000)}`),
				...Array.from({ length: 4 }, () => () => {
					calls++;
					return fauxAssistantMessage("UNEXPECTED");
				}),
			]);
			const run = harness.session.prompt("WORK");
			await entered;
			harness.session.dispose();
			const adapterCalls = harness.faux.state.callCount;
			const journal = harness.sessionManager.getBranch().map((entry) => entry.id);
			release();
			await run;
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(compactions).toBe(0);
			expect(calls).toBe(0);
			// Not even an aborted stream reaches the adapter after disposal.
			expect(harness.faux.state.callCount).toBe(adapterCalls);
			expect(harness.sessionManager.getBranch().map((entry) => entry.id)).toEqual(journal);
			expect(harness.session.isStreaming).toBe(false);
		});
	}
});

type SessionEntryLike = { id: string; type: string; message?: { role: string } };
