import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts } from "./harness.ts";

function barrier() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("fork instructions at canonical session boundaries", () => {
	for (const stopReason of ["error", "length"] as const) {
		it(`recovers ${stopReason} with a trailing developer instruction using persisted omissions`, async () => {
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100 }],
				settings: { compaction: { keepRecentTokens: 100, reserveTokens: 0 } },
				extensionFactories: [
					(pi) => {
						pi.on("agent_end", () => pi.appendDeveloperMessage("Keep going."));
						pi.on("session_before_compact", ({ preparation }) => ({
							compaction: {
								summary: "Prior history",
								firstKeptEntryId: preparation.firstKeptEntryId,
								tokensBefore: preparation.tokensBefore,
							},
						}));
					},
				],
			});
			try {
				harness.setResponses([fauxAssistantMessage("seed")]);
				await harness.session.prompt("seed history");
				harness.setResponses([
					fauxAssistantMessage("failed attempt", {
						stopReason,
						...(stopReason === "error" ? { errorMessage: "prompt is too long" } : {}),
					}),
					fauxAssistantMessage("recovered"),
				]);
				await harness.session.prompt("x".repeat(5000));
				expect(harness.faux.state.callCount).toBe(3);
				const entries = harness.sessionManager.getEntries();
				const failed = entries.find(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.stopReason === stopReason,
				);
				expect(failed).toBeDefined();
				expect(entries).toContainEqual(
					expect.objectContaining({ type: "context_edit", targetId: failed?.id, replacement: null }),
				);
				expect(getAssistantTexts(harness)).toContain("recovered");
				expect(getAssistantTexts(harness)).not.toContain("failed attempt");
				expect(harness.session.messages.some((message) => message.role === "developer")).toBe(true);
				expect(harness.session.messages).toEqual(harness.sessionManager.buildSessionProjection().messages);
				expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
			} finally {
				harness.cleanup();
			}
		});
	}

	it("does not treat a passive instruction after an assistant as runnable input at pre-settlement", async () => {
		let canContinue: boolean | undefined;
		const errors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => pi.appendDeveloperMessage("For the next user request."));
					pi.on("agent_before_settle", (event) => {
						canContinue = event.context.canContinue;
						return { continue: true };
					});
				},
			],
		});
		try {
			await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
			harness.setResponses([fauxAssistantMessage("done")]);
			await harness.session.prompt("hello");
			expect(canContinue).toBe(false);
			expect(harness.faux.state.callCount).toBe(1);
			expect(errors).toContain("agent_before_settle requested continuation without runnable model context");
		} finally {
			harness.cleanup();
		}
	});

	it("refreshes developer instructions from persisted context without retaining cache-only messages", async () => {
		const harness = await createHarness();
		try {
			harness.session.agent.state.messages.push({ role: "user", content: "not persisted", timestamp: Date.now() });
			harness.session.appendDeveloperMessage("persisted instruction");
			expect(harness.session.messages).toEqual(harness.sessionManager.buildSessionProjection().messages);
			expect(harness.session.messages.map((message) => message.role)).toEqual(["developer"]);
			harness.session.agent.followUp({ role: "user", content: "queued", timestamp: Date.now() });
			await expect(harness.session.agent.continue()).rejects.toThrow("No messages to continue from");
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});

describe("deferred replacement activity", () => {
	for (const outcome of ["cancelled", "failed"] as const) {
		it(`keeps idle waiters blocked across a ${outcome} replacement and its queued continuation`, async () => {
			const entered = barrier();
			const release = barrier();
			const continued = barrier();
			const finishContinuation = barrier();
			let requested = false;
			let completion: Promise<unknown> | undefined;
			let idleResolved = false;
			const harness = await createHarness({
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("agent_end", async (_event, ctx) => {
							if (requested) return;
							requested = true;
							const request = await ctx.requestNewSession();
							if (request.queued) completion = request.completion.catch((error: unknown) => error);
							pi.sendUserMessage("follow-up", { deliverAs: "followUp" });
						});
						pi.on("agent_start", async () => {
							if (!requested) return;
							continued.resolve();
							await finishContinuation.promise;
						});
					},
				],
			});
			await harness.session.bindExtensions({
				commandContextActions: {
					waitForIdle: () => harness.session.waitForIdle(),
					newSession: async () => {
						entered.resolve();
						await release.promise;
						if (outcome === "failed") throw new Error("replacement failed");
						return { cancelled: true };
					},
					fork: async () => ({ cancelled: true }),
					navigateTree: async () => ({ cancelled: true }),
					switchSession: async () => ({ cancelled: true }),
					reload: async () => {},
				},
			});
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			let idle: Promise<void> | undefined;
			harness.session.subscribe((event) => {
				if (event.type === "agent_start" && !idle)
					idle = harness.session.waitForIdle().then(() => {
						idleResolved = true;
					});
			});
			const prompt = harness.session.prompt("start");
			try {
				await entered.promise;
				await Promise.resolve();
				expect(harness.session.isIdle).toBe(false);
				expect(idleResolved).toBe(false);
				release.resolve();
				await continued.promise;
				expect(harness.session.isIdle).toBe(false);
				expect(idleResolved).toBe(false);
				finishContinuation.resolve();
				await prompt;
				await idle;
				expect(idleResolved).toBe(true);
				expect(harness.session.isIdle).toBe(true);
				expect(getAssistantTexts(harness)).toEqual(["first", "second"]);
				if (outcome === "cancelled") expect(await completion).toEqual({ cancelled: true });
				else expect(await completion).toBeInstanceOf(Error);
			} finally {
				release.resolve();
				finishContinuation.resolve();
				await prompt;
				harness.cleanup();
			}
		});
	}
});
