import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager, SessionPersistenceError } from "../../src/core/session-manager.ts";
import { createBootstrappedSessionManager, createHarness, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function setup(retry = false) {
	const sessionManager = createBootstrappedSessionManager();
	sessionManager.appendMessage({ role: "user", content: "original task", timestamp: 1 });
	const harness = await createHarness({
		sessionManager,
		settings: { retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1 } },
	});
	harnesses.push(harness);
	return harness;
}

describe("AgentSession.continueInterrupted", () => {
	it.each(["error", "aborted"] as const)("durably omits an %s assistant without adding input", async (stopReason) => {
		const h = await setup();
		const failed = fauxAssistantMessage("partial answer", { stopReason, errorMessage: "interrupted" });
		const id = h.sessionManager.appendMessage(failed);
		h.session.refreshContext();
		h.setResponses([
			(context) => {
				expect(context.messages).not.toContainEqual(failed);
				expect(context.messages.filter((message) => message.role === "user")).toHaveLength(1);
				return fauxAssistantMessage("recovered");
			},
		]);

		expect(await h.session.continueInterrupted()).toBe(true);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.sessionManager.getEntry(id)).toMatchObject({ type: "message", message: failed });
		expect(h.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "context_edit", targetId: id, replacement: null }),
		);
		expect(h.sessionManager.buildSessionProjection().messages).not.toContainEqual(failed);
		expect(
			h.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(1);
		expect(h.eventsOfType("agent_start")).toHaveLength(1);
		expect(h.eventsOfType("agent_end")).toHaveLength(1);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
		expect(h.session.isIdle).toBe(true);
	});

	it.each(["user", "toolResult"] as const)("continues directly from %s", async (leaf) => {
		const h = await setup();
		if (leaf === "toolResult") {
			const call = fauxToolCall("echo", {});
			h.sessionManager.appendMessage(fauxAssistantMessage([call], { stopReason: "toolUse" }));
			h.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: "echo",
				content: [{ type: "text", text: "Command aborted" }],
				isError: true,
				timestamp: 2,
			});
		}
		h.session.refreshContext();
		h.setResponses([
			(context) => {
				expect(context.messages.at(-1)?.role).toBe(leaf);
				return fauxAssistantMessage("done");
			},
		]);
		expect(await h.session.continueInterrupted()).toBe(true);
		expect(h.faux.state.callCount).toBe(1);
		expect(h.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toEqual([]);
		expect(h.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("refuses completed replies and empty branches", async () => {
		const h = await setup();
		h.sessionManager.appendMessage(fauxAssistantMessage("done"));
		h.session.refreshContext();
		expect(await h.session.continueInterrupted()).toBe(false);
		h.sessionManager.resetLeaf();
		h.session.refreshContext();
		expect(await h.session.continueInterrupted()).toBe(false);
		expect(h.faux.state.callCount).toBe(0);
	});

	it("refuses streaming, compaction and retry without changing history", async () => {
		const h = await setup();
		const entries = h.sessionManager.getEntries();
		for (const property of ["isStreaming", "isCompacting", "isRetrying"] as const) {
			const busy = vi.spyOn(h.session, property, "get").mockReturnValue(true);
			expect(await h.session.continueInterrupted()).toBe(false);
			busy.mockRestore();
		}
		expect(h.sessionManager.getEntries()).toEqual(entries);
		expect(h.faux.state.callCount).toBe(0);
	});

	it("refuses closed, disposed and write-blocked sessions", async () => {
		const h = await setup();
		const blocked = vi
			.spyOn(h.sessionManager, "getPersistenceError")
			.mockReturnValue(new SessionPersistenceError(new Error("write failed")));
		expect(await h.session.continueInterrupted()).toBe(false);
		blocked.mockRestore();
		h.session.closeAdmission();
		expect(await h.session.continueInterrupted()).toBe(false);
		h.session.dispose();
		expect(await h.session.continueInterrupted()).toBe(false);
	});

	it("persists the omission across reopening the session file", async () => {
		const owner = await setup();
		const sessionManager = SessionManager.create(owner.tempDir, join(owner.tempDir, "sessions"));
		const h = await createHarness({ sessionManager });
		harnesses.unshift(h);
		h.setResponses([fauxAssistantMessage("partial", { stopReason: "aborted" }), fauxAssistantMessage("done")]);
		await h.session.prompt("task");
		const failed = h.session.messages.at(-1);
		expect(await h.session.continueInterrupted()).toBe(true);
		const reopened = SessionManager.open(sessionManager.getSessionFile()!);
		expect(reopened.getEntries()).toContainEqual(expect.objectContaining({ type: "message", message: failed }));
		expect(reopened.buildSessionProjection().messages).not.toContainEqual(failed);
	});

	it("a resumed run still performs automatic retry and settles once", async () => {
		const h = await setup(true);
		h.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);
		expect(await h.session.continueInterrupted()).toBe(true);
		expect(h.faux.state.callCount).toBe(2);
		expect(h.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(h.eventsOfType("agent_settled")).toHaveLength(1);
	});

	it.each(["abort", "dispose", "close", "write failure"] as const)(
		"does not request after %s during omission",
		async (action) => {
			const h = await setup();
			h.sessionManager.appendMessage(fauxAssistantMessage("partial", { stopReason: "aborted" }));
			vi.spyOn(h.session.extensionRunner, "hasHandlers").mockImplementation(
				(event) => event === "session_context_change",
			);
			const emit = vi.spyOn(h.session.extensionRunner, "emit").mockImplementation(async (event) => {
				if (event.type !== "session_context_change") return;
				expect(h.session.isStreaming).toBe(true);
				expect(await h.session.continueInterrupted()).toBe(false);
				if (action === "abort") void h.session.abort();
				else if (action === "dispose") h.session.dispose();
				else if (action === "close") h.session.closeAdmission();
				else
					vi.spyOn(h.sessionManager, "getPersistenceError").mockReturnValue(
						new SessionPersistenceError(new Error("write failed")),
					);
			});
			expect(await h.session.continueInterrupted()).toBe(false);
			expect(h.faux.state.callCount).toBe(0);
			expect(h.session.isStreaming).toBe(false);
			emit.mockRestore();
		},
	);

	it("abort cancels an actively continued stream and leaves it continuable", async () => {
		const h = await setup();
		h.setResponses([fauxAssistantMessage("x".repeat(20000)), fauxAssistantMessage("done")]);
		let stop = true;
		h.session.subscribe((event) => {
			if (stop && event.type === "message_update") {
				stop = false;
				void h.session.abort();
			}
		});
		const run = h.session.continueInterrupted();
		expect(await h.session.continueInterrupted()).toBe(false);
		expect(await run).toBe(true);
		expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(h.eventsOfType("agent_settled").at(-1)?.aborted).toBe(true);
		expect(await h.session.continueInterrupted()).toBe(true);
		expect(h.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
		expect(h.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("exposes the real extension API and rejects stale APIs", async () => {
		let api!: ExtensionAPI;
		const sessionManager = createBootstrappedSessionManager();
		sessionManager.appendMessage({ role: "user", content: "task", timestamp: 1 });
		const h = await createHarness({
			sessionManager,
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(h);
		await h.session.bindExtensions({});
		h.setResponses([fauxAssistantMessage("done")]);
		expect(await api.continueInterrupted()).toBe(true);
		expect(await api.continueInterrupted()).toBe(false);
		h.session.dispose();
		expect(() => api.continueInterrupted()).toThrow(/stale/);
	});
});
