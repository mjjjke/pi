import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
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
