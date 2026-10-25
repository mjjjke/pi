import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const custom = (text: string) => ({ customType: "task", content: text, display: false });
const texts = (h: Harness) =>
	h.sessionManager
		.getBranch()
		.filter((e) => e.type === "custom_message")
		.map((e) => getMessageText(e));

describe("AgentSession custom ownership", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it("pumps a trigger accepted by the final run-end flush after settlement", async () => {
		let h!: Harness;
		let sent = false;
		h = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", async () => {
						if (sent) return;
						sent = true;
						await h.session.sendCustomMessage(custom("final passive"), { triggerTurn: false });
					});
				},
			],
		});
		cleanups.push(h.cleanup);
		const activeAtStarts: boolean[] = [];
		h.session.agent.steeringMode = "one-at-a-time";
		h.session.subscribe((event) => {
			if (event.type === "message_end" && getMessageText(event.message) === "final passive") {
				void h.session.sendCustomMessage(custom("wake trigger"), { triggerTurn: true });
				void h.session.sendCustomMessage(custom("rider"), { triggerTurn: false });
			}
			if (event.type === "agent_start") activeAtStarts.push(h.session.isStreaming);
		});
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("done")]);
		await h.session.prompt("start");
		await h.session.waitForIdle();
		expect(texts(h)).toEqual(["final passive", "wake trigger", "rider"]);
		expect(h.faux.state.callCount).toBe(2);
		expect(activeAtStarts).toEqual([true, true]);
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
		expect((h.session as unknown as { _customStore: Map<unknown, unknown> })._customStore.size).toBe(0);
	});

	it.each(["live", "dispose", "aborted"] as const)("owns settlement triggers immediately: %s", async (schedule) => {
		let h!: Harness;
		let sent = false;
		const ownershipErrors: unknown[] = [];
		h = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					if (schedule === "aborted")
						pi.on("turn_end", () => {
							void h.session.abort();
						});
					pi.on("agent_settled", async () => {
						if (sent) return;
						sent = true;
						await h.session.sendCustomMessage(custom("A"), { triggerTurn: true, orderKey: "k" });
						try {
							expect((h.session as unknown as { _customStore: Map<unknown, unknown> })._customStore.size).toBe(
								1,
							);
						} catch (error) {
							ownershipErrors.push(error);
						}
						await h.session.sendCustomMessage(custom("B"), { triggerTurn: false, orderKey: "k" });
						if (schedule === "dispose") h.session.dispose();
					});
				},
			],
		});
		cleanups.push(h.cleanup);
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await h.session.prompt("start");
		await h.session.waitForIdle();
		expect(ownershipErrors).toEqual([]);
		expect(texts(h)).toEqual(["A", "B"]);
		expect(h.faux.state.callCount).toBe(schedule === "live" ? 2 : 1);
		expect((h.session as unknown as { _customStore: Map<unknown, unknown> })._customStore.size).toBe(0);
	});

	for (const mode of ["all", "one-at-a-time"] as const) {
		for (const stop of [false, true]) {
			it.each([7, 19, 47])(`seed %s: bounded receipts in ${mode}, stop=${stop}`, async (seed) => {
				let h!: Harness;
				let sent = false;
				let state = seed;
				const arrivals: Array<{ text: string; key: string; follow: boolean }> = [];
				h = await createHarness({
					settings: { compaction: { enabled: false } },
					extensionFactories: [
						(pi) => {
							pi.on("turn_end", async () => {
								if (sent) return;
								sent = true;
								for (let i = 0; i < 12; i++) {
									state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
									const lane = state % 3;
									const key = `k${(state >>> 8) % 3}`;
									const text = `s${seed}-${i}`;
									arrivals.push({ text, key, follow: lane === 2 });
									await h.session.sendCustomMessage(custom(text), {
										triggerTurn: lane !== 0,
										deliverAs: lane === 2 ? "followUp" : "steer",
										orderKey: key,
									});
								}
								if (stop) void h.session.abort();
							});
						},
					],
				});
				cleanups.push(h.cleanup);
				h.session.agent.steeringMode = mode;
				h.session.agent.followUpMode = mode;
				const append = h.sessionManager.appendCustomMessageEntry.bind(h.sessionManager);
				let attempts = 0;
				// First/second receipt failure, never sticky: settlement must recover ownership.
				vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementation((...args) => {
					if (++attempts === (seed === 7 ? 1 : seed === 19 ? 2 : -1))
						throw new Error("synthetic transient append");
					return append(...args);
				});
				h.setResponses(
					Array.from({ length: 20 }, () => (context) => {
						expect(context.messages).toEqual(convertToLlm(h.sessionManager.buildSessionProjection().messages));
						return fauxAssistantMessage("reply");
					}),
				);
				await h.session.prompt("start");
				await h.session.waitForIdle();
				// Transient append errors can stop the low-level loop. One explicit idle stop
				// is a bounded recovery step, not another provider turn.
				await h.session.abort();
				const journal = texts(h);
				expect([...journal].sort()).toEqual(arrivals.map((item) => item.text).sort());
				for (const key of ["k0", "k1", "k2"]) {
					const ordered = arrivals.filter((item) => item.key === key && !item.follow).map((item) => item.text);
					expect(journal.filter((text) => ordered.includes(text))).toEqual(ordered);
				}
				expect((h.session as unknown as { _customStore: Map<unknown, unknown> })._customStore.size).toBe(0);
				expect(h.session.agent.hasQueuedMessages()).toBe(false);
				expect(h.faux.state.callCount).toBeLessThanOrEqual(14);
			});
		}
	}

	it("admits a same-key passive rider with its steer in request and journal order", async () => {
		let h!: Harness;
		const requests: string[][] = [];
		h = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					let sent = false;
					pi.on("turn_end", async () => {
						if (sent) return;
						sent = true;
						await h.session.sendCustomMessage(custom("running"), { deliverAs: "steer" });
						await h.session.sendCustomMessage(custom("stopped"), { triggerTurn: false });
					});
					pi.on("context", (event) => {
						requests.push(event.messages.filter((m) => m.role === "custom").map(getMessageText));
					});
				},
			],
		});
		cleanups.push(h.cleanup);
		h.session.agent.steeringMode = "one-at-a-time";
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("done")]);
		await h.session.prompt("start");
		expect(texts(h)).toEqual(["running", "stopped"]);
		expect(requests).toEqual([[], ["running", "stopped"]]);
	});

	it("writes queued custom input passively on stop, preserving queued user input", async () => {
		let h!: Harness;
		h = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					let stopped = false;
					pi.on("turn_end", async () => {
						if (stopped) return;
						stopped = true;
						await h.session.steer("user");
						await h.session.sendCustomMessage(custom("running"), { deliverAs: "steer" });
						await h.session.sendCustomMessage(custom("stopped"), { triggerTurn: false });
						void h.session.abort();
					});
				},
			],
		});
		cleanups.push(h.cleanup);
		h.setResponses([fauxAssistantMessage("first")]);
		await h.session.prompt("start");
		expect(texts(h)).toEqual(["running", "stopped"]);
		expect(h.session.clearQueue()).toEqual({ steering: ["user"], followUp: [] });
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
		expect(h.eventsOfType("agent_start")).toHaveLength(1);
	});

	it("recovers the failed and later admitted items once without overtaking", async () => {
		let h!: Harness;
		let injected = false;
		h = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", async () => {
						if (injected) return;
						injected = true;
						await h.session.sendCustomMessage(custom("A"), { deliverAs: "steer" });
						await h.session.sendCustomMessage(custom("B"), { deliverAs: "steer" });
						await h.session.sendCustomMessage(custom("C"), { triggerTurn: false });
					});
				},
			],
		});
		cleanups.push(h.cleanup);
		const append = h.sessionManager.appendCustomMessageEntry.bind(h.sessionManager);
		let failed = false;
		vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementation((...args) => {
			if (args[1] === "B" && !failed) {
				failed = true;
				throw new Error("transient append");
			}
			return append(...args);
		});
		h.setResponses([fauxAssistantMessage("first")]);
		await h.session.prompt("start");
		expect(texts(h)).toEqual(["A", "B", "C"]);
		expect(h.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("keeps independent same-key ingress behind its steer while a context-change handler awaits", async () => {
		let h!: Harness;
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let drafted = false;
		h = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", async (event, ctx) => {
						if (drafted) return;
						drafted = true;
						await h.session.steer("U");
						pi.sendMessage(custom("A"), { deliverAs: "steer", orderKey: "task:k" });
						const target = ctx.sessionManager
							.getBranch()
							.find((entry) => entry.type === "message" && entry.message.role === "user")!;
						return {
							entries: [
								...event.entries,
								{ type: "context_edit", targetId: target.id, replacement: { content: "edited" } },
							],
						};
					});
					pi.on("session_context_change", async () => {
						enter();
						await gate;
					});
				},
			],
		});
		cleanups.push(() => {
			release();
			h.cleanup();
		});
		h.session.agent.steeringMode = "one-at-a-time";
		const requests: string[][] = [];
		h.setResponses(
			Array.from({ length: 3 }, (_, index) => (context) => {
				expect(context.messages).toEqual(convertToLlm(h.sessionManager.buildSessionProjection().messages));
				requests.push(context.messages.map(getMessageText).filter((text) => ["U", "A", "B"].includes(text)));
				return fauxAssistantMessage(`reply ${index}`);
			}),
		);
		const run = h.session.prompt("start");
		await entered;
		await h.session.sendCustomMessage(custom("B"), { triggerTurn: false, orderKey: "task:k" });
		release();
		await run;
		expect(requests).toEqual([[], ["U"], ["U", "A", "B"]]);
		expect(texts(h)).toEqual(["A", "B"]);
	});

	it("keeps an unrelated passive eligible while a follow-up is pending", async () => {
		let h!: Harness;
		let sent = false;
		h = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", async () => {
						if (sent) return;
						sent = true;
						await h.session.sendCustomMessage(custom("follow"), { deliverAs: "followUp", orderKey: "k" });
						await h.session.sendCustomMessage(custom("passive"), { triggerTurn: false, orderKey: "k" });
						await h.session.sendCustomMessage(custom("completion"), { deliverAs: "steer", orderKey: "other" });
					});
				},
			],
		});
		cleanups.push(h.cleanup);
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("next"), fauxAssistantMessage("done")]);
		await h.session.prompt("start");
		expect(texts(h)).toEqual(["passive", "completion", "follow"]);
	});

	it("writes an older unreceipted same-key passive before an idle trigger", async () => {
		const h = await createHarness({ settings: { compaction: { enabled: false } } });
		cleanups.push(h.cleanup);
		h.setResponses([fauxAssistantMessage("seed")]);
		await h.session.prompt("seed");
		vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("transient failure");
		});
		await expect(h.session.sendCustomMessage(custom("older"), { triggerTurn: false })).rejects.toThrow();
		h.setResponses([
			(context) => {
				expect(context.messages.map(getMessageText).slice(-2)).toEqual(["older", "trigger"]);
				return fauxAssistantMessage("done");
			},
		]);
		await h.session.sendCustomMessage(custom("trigger"), { triggerTurn: true });
		expect(texts(h)).toEqual(["older", "trigger"]);
	});

	it("releases the run reservation when an older passive still cannot append", async () => {
		const h = await createHarness({ settings: { compaction: { enabled: false } } });
		cleanups.push(h.cleanup);
		h.setResponses([fauxAssistantMessage("seed")]);
		await h.session.prompt("seed");
		const calls = h.faux.state.callCount;
		vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementation(() => {
			throw new Error("append unavailable");
		});
		await expect(h.session.sendCustomMessage(custom("older"), { triggerTurn: false })).rejects.toThrow();
		await expect(h.session.sendCustomMessage(custom("trigger"), { triggerTurn: true })).rejects.toThrow(
			"append unavailable",
		);
		expect(h.session.isStreaming).toBe(false);
		expect(h.faux.state.callCount).toBe(calls);
	});

	it("stages a failed bootstrap trigger before its passive rider", async () => {
		let h!: Harness;
		h = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.messageType !== "custom") return;
						await h.session.sendCustomMessage(custom("rider"), { triggerTurn: false });
						throw new Error("preflight failure");
					});
				},
			],
		});
		cleanups.push(h.cleanup);
		// A throwing extension is isolated by the runner; force B itself to fail instead.
		const append = h.sessionManager.appendMessage.bind(h.sessionManager);
		vi.spyOn(h.sessionManager, "appendMessage").mockImplementationOnce(() => {
			throw new Error("bootstrap failure");
		});
		await expect(h.session.sendCustomMessage(custom("trigger"), { triggerTurn: true })).rejects.toThrow(
			"bootstrap failure",
		);
		expect(h.session.stagedMessages.map(getMessageText)).toEqual(["trigger", "rider"]);
		vi.spyOn(h.sessionManager, "appendMessage").mockImplementation(append);
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.prompt("start");
		expect(texts(h)).toEqual(["trigger", "rider"]);
	});

	for (const lifecycle of ["dispose", "tree"] as const) {
		it(`writes unreceipted passive input to the old branch before ${lifecycle}`, async () => {
			const h = await createHarness({ settings: { compaction: { enabled: false } } });
			cleanups.push(h.cleanup);
			h.setResponses([fauxAssistantMessage("done")]);
			await h.session.prompt("start");
			const oldLeaf = h.sessionManager.getLeafId();
			vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementationOnce(() => {
				throw new Error("transient failure");
			});
			await expect(h.session.sendCustomMessage(custom("owned"), { triggerTurn: false })).rejects.toThrow(
				"transient failure",
			);
			if (lifecycle === "dispose") h.session.dispose();
			else {
				const target = h.sessionManager
					.getBranch()
					.find((entry) => entry.type === "message" && entry.message.role === "user")!;
				await h.session.navigateTree(target.id);
				expect(texts(h)).toEqual([]);
			}
			const entry = h.sessionManager.getEntries().find((entry) => entry.type === "custom_message");
			expect(entry).toMatchObject({ parentId: oldLeaf, content: "owned" });
		});
	}

	it("keeps reentrant triggered sends passive during an idle stop writer", async () => {
		const h = await createHarness({ settings: { compaction: { enabled: false } } });
		cleanups.push(h.cleanup);
		h.setResponses([fauxAssistantMessage("seed")]);
		await h.session.prompt("seed");
		const calls = h.faux.state.callCount;
		vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("transient failure");
		});
		await expect(h.session.sendCustomMessage(custom("A"), { triggerTurn: false })).rejects.toThrow();
		h.session.subscribe((event) => {
			if (event.type !== "message_end" || getMessageText(event.message) !== "A") return;
			void h.session.sendCustomMessage(custom("B"), { triggerTurn: true });
			void h.session.sendCustomMessage(custom("C"), { triggerTurn: false });
		});
		await h.session.abort();
		expect(texts(h)).toEqual(["A", "B", "C"]);
		expect(h.faux.state.callCount).toBe(calls);
	});

	it("retires an admitted item before its public message_end announcement", async () => {
		let h!: Harness;
		let ownedAtAnnouncement: boolean | undefined;
		h = await createHarness({ settings: { compaction: { enabled: false } } });
		cleanups.push(h.cleanup);
		h.session.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "custom") return;
			const store = (h.session as unknown as { _customStore: Map<unknown, unknown> })._customStore;
			ownedAtAnnouncement = store.has(event.message);
		});
		h.setResponses([fauxAssistantMessage("done")]);
		await h.session.sendCustomMessage(custom("trigger"), { triggerTurn: true });
		expect(ownedAtAnnouncement).toBe(false);
	});

	it("keeps a passive behind an older admitted item whose append fails", async () => {
		let h!: Harness;
		let sent = false;
		h = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", async () => {
						if (sent) return;
						sent = true;
						await h.session.sendCustomMessage(custom("A"), { deliverAs: "steer" });
					});
					pi.on("message_start", async (event) => {
						if (getMessageText(event.message) === "A")
							await h.session.sendCustomMessage(custom("younger"), { triggerTurn: false });
					});
				},
			],
		});
		cleanups.push(h.cleanup);
		const append = h.sessionManager.appendCustomMessageEntry.bind(h.sessionManager);
		let failed = false;
		vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementation((...args) => {
			if (args[1] === "A" && !failed) {
				failed = true;
				throw new Error("transient append");
			}
			return append(...args);
		});
		h.setResponses([fauxAssistantMessage("first")]);
		await h.session.prompt("start");
		expect(texts(h)).toEqual(["A", "younger"]);
	});

	it("retains the receipt token through a message_end transformation", async () => {
		let h!: Harness;
		let sent = false;
		h = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", async () => {
						if (sent) return;
						sent = true;
						await h.session.sendCustomMessage(custom("original"), { deliverAs: "steer" });
					});
					pi.on("message_end", (event) => {
						if (event.message.role === "custom")
							return { message: { ...event.message, customType: "changed", content: "transformed" } };
					});
				},
			],
		});
		cleanups.push(h.cleanup);
		h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("done")]);
		await h.session.prompt("start");
		await h.session.abort();
		expect(texts(h)).toEqual(["transformed"]);
	});

	it("does not let a younger send from an admitted message_start overtake the batch on stop", async () => {
		let h!: Harness;
		let sent = false;
		h = await createHarness({
			settings: { compaction: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", async () => {
						if (sent) return;
						sent = true;
						await h.session.sendCustomMessage(custom("A"), { deliverAs: "steer" });
						await h.session.sendCustomMessage(custom("B"), { deliverAs: "steer" });
					});
					pi.on("message_start", async (event) => {
						if (getMessageText(event.message) !== "A") return;
						void h.session.abort();
						await Promise.resolve();
						await h.session.sendCustomMessage(custom("younger"), { triggerTurn: false });
					});
				},
			],
		});
		cleanups.push(h.cleanup);
		h.setResponses([fauxAssistantMessage("first")]);
		await h.session.prompt("start");
		expect(texts(h)).toEqual(["A", "B", "younger"]);
		expect(h.faux.state.callCount).toBe(1);
	});
});
