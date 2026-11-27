import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const fixtures: { h: Harness; session: AgentSession }[] = [];
afterEach(() => {
	for (const { h, session } of fixtures.splice(0)) {
		session.dispose();
		h.cleanup();
	}
	vi.useRealTimers();
});

async function setup() {
	vi.stubEnv("PI_CACHE_RETENTION", "long");
	const h = await createHarness({
		api: "anthropic-messages",
		settings: { cacheWarming: "idle", compaction: { enabled: false } },
	});
	const extensionsResult = await createTestExtensionsResult(
		[
			(pi) => {
				pi.on("turn_end", () => {
					pi.appendEntry("turn-state", { settled: true });
				});
				pi.on("agent_end", () => {
					pi.appendEntry("agent-state", { settled: true });
				});
				// Keep policy/economics out of this context-validity regression.
				pi.on("cache_warming_decision", () => ({ action: "warm" }));
			},
		],
		h.tempDir,
	);
	const { session } = await createAgentSession({
		cwd: h.tempDir,
		agentDir: h.tempDir,
		model: { ...h.getModel(), promptCache: { long: 3600 } },
		modelRuntime: h.session.modelRuntime,
		sessionManager: h.sessionManager,
		settingsManager: h.settingsManager,
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		customTools: [
			{
				name: "probe",
				label: "probe",
				description: "probe",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "tool result" }], details: {} }),
			},
		],
	});
	fixtures.push({ h, session });
	await session.bindExtensions({ mode: "tui" });
	await session.sendCustomMessage({ customType: "handoff", content: "startup snapshot", display: false });
	const requests: string[] = [];
	let sentMessages: AgentMessage[] = [];
	const capture = (context: Context) => {
		if (requests.length === 0) sentMessages = session.messages.slice();
		requests.push(JSON.stringify(context));
		return fauxAssistantMessage("done");
	};
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
		capture,
		capture,
		capture,
		capture,
	]);
	vi.useFakeTimers();
	await session.sendCustomMessage(
		{ customType: "task-notification", content: "task completed", display: true },
		{ triggerTurn: true },
	);
	expect(session.messages.some((m) => m.role === "toolResult")).toBe(true);
	return { h, session, requests, sentMessages };
}

function warms(h: Harness) {
	return h.sessionManager.getEntries().filter((e) => e.type === "usage" && e.kind === "cache_warm");
}

function stops(h: Harness) {
	return h.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === "cache_warm_stop");
}

describe("idle warming after session projection refresh", () => {
	it("replays the request at the first and later refreshes despite custom-message reconstruction and non-context writes", async () => {
		const { h, session, requests, sentMessages } = await setup();
		const customIndex = sentMessages.findIndex((m) => m.role === "custom");
		// turn_end -> _commitBoundaryDrafts -> _refreshFinalizedContext reconstructs custom messages.
		expect(session.messages[customIndex]).not.toBe(sentMessages[customIndex]);
		expect(session.messages.slice(0, sentMessages.length)).toEqual(sentMessages);
		h.sessionManager.appendCustomEntry("idle-state", {});
		await vi.advanceTimersByTimeAsync(54 * 60_000);
		expect(stops(h)).toEqual([]);
		expect(warms(h)).toHaveLength(1);
		session.refreshContext(); // Includes the warmer's own usage entry.
		await vi.advanceTimersByTimeAsync(54 * 60_000);
		expect(warms(h)).toHaveLength(2);
		expect(stops(h)).toEqual([]);
		expect(requests).toHaveLength(3);
		expect(requests[1]).toBe(requests[0]);
		expect(requests[2]).toBe(requests[0]);
		await session.prompt("next real input");
		expect(requests).toHaveLength(4);
		const sent: Context = JSON.parse(requests[0]);
		const next: Context = JSON.parse(requests[3]);
		expect(JSON.stringify(next.messages.slice(0, sent.messages.length))).toBe(JSON.stringify(sent.messages));
	});

	it.each(["model", "provider", "changed", "removed", "inserted", "history-edit", "tree", "compaction"] as const)(
		"stops when the sent prefix is no longer current: %s",
		async (change) => {
			const { h, session } = await setup();
			// Establish a usable prefix first, so invalidation cannot pass merely because
			// warming was already broken by the fixture's boundary reconstruction.
			await vi.advanceTimersByTimeAsync(54 * 60_000);
			expect(warms(h)).toHaveLength(1);
			const customIndex = session.messages.findIndex((m) => m.role === "custom");
			if (change === "model") session.agent.state.model = { ...session.model!, id: "other-model" };
			if (change === "provider") session.agent.state.model = { ...session.model!, provider: "other-provider" };
			if (change === "changed") {
				const message = session.messages[customIndex];
				if (message.role !== "custom") throw new Error("Missing custom fixture");
				message.content = "changed in place";
			}
			if (change === "removed") session.agent.state.messages.splice(customIndex, 1);
			if (change === "inserted")
				session.agent.state.messages.splice(customIndex, 0, {
					role: "user",
					content: "inserted in prefix",
					timestamp: Date.now(),
				});
			const firstCustom = h.sessionManager.getBranch().find((e) => e.type === "custom_message");
			if (!firstCustom) throw new Error("Missing custom entry");
			if (change === "history-edit") {
				h.sessionManager.appendContextEdit(firstCustom.id, { content: "edited history" });
				session.refreshContext();
			}
			if (change === "tree") {
				h.sessionManager.branch(firstCustom.id);
				session.refreshContext();
			}
			if (change === "compaction") {
				const last = h.sessionManager.getBranch().findLast((e) => e.type === "message");
				if (!last) throw new Error("Missing assistant entry");
				h.sessionManager.appendCompaction("new summary", last.id, 1000);
				session.refreshContext();
			}
			await vi.advanceTimersByTimeAsync(54 * 60_000);
			expect(warms(h)).toHaveLength(1);
			expect(stops(h)).toMatchObject([{ data: { reason: "conversation context changed", successfulRefreshes: 1 } }]);
		},
	);
});
