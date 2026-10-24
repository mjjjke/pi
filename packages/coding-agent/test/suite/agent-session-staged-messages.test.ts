import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * A6b: `ctx.getStagedMessages()` exposes content staged before the bootstrap commit (read-only), so an
 * extension can re-seed its pending sends after `/reload` (`hasPendingMessages()` excludes staged content).
 */

interface Observation {
	reason: string;
	staged: Array<{ customType?: string; details?: unknown }>;
	pending: boolean;
}

describe("ctx.getStagedMessages() (A6b)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		observations: Observation[],
		contexts: ExtensionContext[],
		sessionManager?: SessionManager,
	): Promise<Harness> {
		const factory = (pi: ExtensionAPI) => {
			pi.on("session_start", (event, ctx) => {
				contexts.push(ctx);
				if (event.reason === "startup") {
					pi.sendMessage(
						{ customType: "handoff-notice", content: "NOTICE", display: false, details: { noticeId: "n1" } },
						{ triggerTurn: false },
					);
				}
				observations.push({
					reason: event.reason,
					staged: ctx.getStagedMessages().map((message) => ({
						customType: message.role === "custom" ? message.customType : undefined,
						details: message.role === "custom" ? message.details : undefined,
					})),
					pending: ctx.hasPendingMessages(),
				});
			});
		};
		const harness = await createHarness({ extensionFactories: [factory], sessionManager });
		harnesses.push(harness);
		return harness;
	}

	it("shows staged passive content with details, survives /reload, is empty after commit", async () => {
		const observations: Observation[] = [];
		const contexts: ExtensionContext[] = [];
		const harness = await setup(observations, contexts);
		await harness.session.bindExtensions({});
		expect(observations).toEqual([
			{
				reason: "startup",
				staged: [{ customType: "handoff-notice", details: { noticeId: "n1" } }],
				pending: false,
			},
		]);

		await harness.session.reload();
		expect(observations[1]).toEqual({
			reason: "reload",
			staged: [{ customType: "handoff-notice", details: { noticeId: "n1" } }],
			pending: false,
		});
		// The pre-reload context is stale.
		expect(() => contexts[0].getStagedMessages()).toThrow();

		// A returned copy cannot change what is staged.
		const copy = contexts[1].getStagedMessages();
		if (copy[0]?.role === "custom") copy[0].details = { noticeId: "mutated" };
		expect(contexts[1].getStagedMessages()[0]).toMatchObject({ details: { noticeId: "n1" } });

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");
		expect(contexts[1].getStagedMessages()).toEqual([]);
	});

	it("is empty after staged content is discarded (tree navigation)", async () => {
		const observations: Observation[] = [];
		const contexts: ExtensionContext[] = [];
		// A branch without a system snapshot (an old session) stages; navigating discards the staged content.
		const sessionManager = SessionManager.inMemory();
		const target = sessionManager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		sessionManager.appendMessage({ role: "user", content: "later", timestamp: 2 });
		const harness = await setup(observations, contexts, sessionManager);
		await harness.session.bindExtensions({});
		expect(contexts[0].getStagedMessages()).toHaveLength(1);
		await harness.session.navigateTree(target);
		expect(contexts.at(-1)?.getStagedMessages()).toEqual([]);
	});
});
