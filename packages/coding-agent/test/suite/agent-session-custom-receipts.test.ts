import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { createHarness, getMessageText } from "./harness.ts";
import { createRuntimeHarness } from "./runtime-harness.ts";

const custom = (content: string) => ({ customType: "receipt", content, display: false });

describe("§15.12 explicit custom receipt schedules", () => {
	it("a custom trigger retried once has one receipt and a canonical retry prefix", async () => {
		const h = await createHarness({
			settings: { compaction: { enabled: false }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		try {
			const requests: string[] = [];
			const errors: unknown[] = [];
			h.setResponses(
				[0, 1].map((attempt) => (context) => {
					try {
						expect(context.messages).toEqual(convertToLlm(h.sessionManager.buildSessionProjection().messages));
						expect(context.messages.filter((message) => getMessageText(message) === "trigger")).toHaveLength(1);
						requests.push(JSON.stringify(context.messages));
					} catch (error) {
						errors.push(error);
					}
					return attempt === 0
						? fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 service unavailable" })
						: fauxAssistantMessage("done");
				}),
			);
			await h.session.sendCustomMessage(custom("trigger"), { triggerTurn: true });
			expect(errors).toEqual([]);
			expect(requests).toHaveLength(2);
			expect(requests[1]).toBe(requests[0]);
			expect(h.eventsOfType("auto_retry_start")).toHaveLength(1);
			expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(1);
			expect((h.session as unknown as { _customStore: Map<unknown, unknown> })._customStore.size).toBe(0);
		} finally {
			h.cleanup();
		}
	});

	it("tree away/back retains pending store receipts on the source branch only", async () => {
		const h = await createHarness({ settings: { compaction: { enabled: false } } });
		try {
			h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
			await h.session.prompt("first");
			const target = h.sessionManager.getLeafId()!;
			await h.session.prompt("second");
			const source = h.sessionManager.getLeafId();
			const append = vi.spyOn(h.sessionManager, "appendCustomMessageEntry").mockImplementation(() => {
				throw new Error("temporarily unavailable");
			});
			await expect(
				h.session.sendCustomMessage(custom("A"), { triggerTurn: false, orderKey: "k" }),
			).rejects.toThrow();
			await expect(
				h.session.sendCustomMessage(custom("B"), { triggerTurn: false, orderKey: "k" }),
			).rejects.toThrow();
			append.mockRestore();
			// A custom-message selection opens its parent for editing. A non-message
			// anchor selects the complete source branch, including the final receipt.
			let returnLeaf = "";
			h.session.subscribe((event) => {
				if (event.type === "message_end" && getMessageText(event.message) === "B")
					returnLeaf = h.sessionManager.appendCustomEntry("source-receipt-anchor", {});
			});
			const calls = h.faux.state.callCount;
			await h.session.navigateTree(target);
			expect(h.sessionManager.getBranch().filter((entry) => entry.type === "custom_message")).toHaveLength(0);
			const receipts = h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message");
			expect(receipts.map(getMessageText)).toEqual(["A", "B"]);
			expect(receipts[0].parentId).toBe(source);
			expect(receipts[1].parentId).toBe(receipts[0].id);
			await h.session.navigateTree(returnLeaf);
			expect(
				h.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "custom_message")
					.map(getMessageText),
			).toEqual(["A", "B"]);
			expect(h.faux.state.callCount).toBe(calls);
			expect((h.session as unknown as { _customStore: Map<unknown, unknown> })._customStore.size).toBe(0);
			let request: ReturnType<typeof convertToLlm> = [];
			let canonical: ReturnType<typeof convertToLlm> = [];
			h.setResponses([
				(context) => {
					request = structuredClone(context.messages);
					canonical = convertToLlm(h.sessionManager.buildSessionProjection().messages);
					return fauxAssistantMessage("back");
				},
			]);
			await h.session.prompt("back");
			expect(request).toEqual(canonical);
			expect(request.map(getMessageText).filter((text) => text === "A" || text === "B")).toEqual(["A", "B"]);
			expect(h.sessionManager.getEntries().filter((entry) => entry.type === "custom_message")).toHaveLength(2);
		} finally {
			h.cleanup();
		}
	});

	it("switch away/back persists pending store receipts on the outgoing file exactly once", async () => {
		const h = await createRuntimeHarness();
		try {
			h.faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("other")]);
			await h.runtime.session.prompt("first");
			const original = h.runtime.session.sessionFile!;
			await h.runtime.newSession();
			await h.runtime.session.prompt("other");
			const other = h.runtime.session.sessionFile!;
			await h.runtime.switchSession(original);
			const outgoing = h.runtime.session;
			const source = outgoing.sessionManager.getLeafId();
			const append = vi.spyOn(outgoing.sessionManager, "appendCustomMessageEntry").mockImplementation(() => {
				throw new Error("temporarily unavailable");
			});
			await expect(outgoing.sendCustomMessage(custom("A"), { triggerTurn: false, orderKey: "k" })).rejects.toThrow();
			await expect(outgoing.sendCustomMessage(custom("B"), { triggerTurn: false, orderKey: "k" })).rejects.toThrow();
			append.mockRestore();
			const calls = h.faux.state.callCount;
			await h.runtime.switchSession(other);
			expect(
				h.runtime.session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message"),
			).toHaveLength(0);
			await h.runtime.switchSession(original);
			const receipts = h.runtime.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom_message");
			expect(receipts.map(getMessageText)).toEqual(["A", "B"]);
			expect(receipts[0].parentId).toBe(source);
			expect(receipts[1].parentId).toBe(receipts[0].id);
			expect(h.faux.state.callCount).toBe(calls);
			expect((outgoing as unknown as { _customStore: Map<unknown, unknown> })._customStore.size).toBe(0);
			let request: ReturnType<typeof convertToLlm> = [];
			let canonical: ReturnType<typeof convertToLlm> = [];
			h.faux.setResponses([
				(context) => {
					request = structuredClone(context.messages);
					canonical = convertToLlm(h.runtime.session.sessionManager.buildSessionProjection().messages);
					return fauxAssistantMessage("back");
				},
			]);
			await h.runtime.session.prompt("back");
			expect(request).toEqual(canonical);
			expect(request.map(getMessageText).filter((text) => text === "A" || text === "B")).toEqual(["A", "B"]);
			expect(
				h.runtime.session.sessionManager.getBranch().filter((entry) => entry.type === "custom_message"),
			).toHaveLength(2);
		} finally {
			await h.cleanup();
		}
	});
});
