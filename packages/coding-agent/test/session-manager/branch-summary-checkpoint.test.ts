import type { SystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type BranchSummaryEntry, SessionManager } from "../../src/core/session-manager.ts";

const system = (prompt: string): SystemMessage =>
	({ role: "system", content: prompt, timestamp: 1 }) as unknown as SystemMessage;
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const assistant = () => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "ok" }],
	api: "test",
	provider: "test",
	model: "test",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
	timestamp: 1,
});

/** model_change · system · user · assistant */
function conversation(): { manager: SessionManager; modelId: string; systemId: string; userId: string } {
	const manager = SessionManager.inMemory("/tmp");
	const modelId = manager.appendModelChange("p", "m");
	const systemId = manager.appendMessage(system("prompt"));
	const userId = manager.appendMessage(user("hi"));
	manager.appendMessage(assistant());
	return { manager, modelId, systemId, userId };
}

const roles = (manager: SessionManager) => manager.buildSessionContext().messages.map((message) => message.role);

describe("branch-summary checkpoint (§4.1, §7.5)", () => {
	it.each([
		["the root", (_ids: ReturnType<typeof conversation>) => null],
		["a pre-system point", (ids: ReturnType<typeof conversation>) => ids.modelId],
	])("a summary at %s carries the source system state and projects it first", (_name, target) => {
		const ids = conversation();
		const { manager } = ids;
		const summaryId = manager.branchWithSummary(target(ids), "summary of the abandoned path");
		const entry = manager.getEntry(summaryId) as BranchSummaryEntry;
		expect(entry.systemMessage).toMatchObject({ role: "system", content: "prompt" });
		expect(entry.systemMessage?.timestamp).toBe(new Date(entry.timestamp).getTime());
		expect(entry).not.toHaveProperty("standing");
		expect(roles(manager)).toEqual(["system", "branchSummary"]);
	});

	it("a summary at a point that already has a system message carries none", () => {
		const { manager, userId } = conversation();
		const summaryId = manager.branchWithSummary(userId, "summary");
		expect((manager.getEntry(summaryId) as BranchSummaryEntry).systemMessage).toBeUndefined();
		expect(roles(manager)).toEqual(["system", "user", "branchSummary"]);
	});

	it("root summary → compaction keeping the summary: exactly one system message, at index 0, plus the summary text", () => {
		const { manager } = conversation();
		const summaryId = manager.branchWithSummary(null, "branch summary text");
		manager.appendMessage(user("next"));
		manager.appendMessage(assistant());
		manager.appendCompaction("compaction summary", summaryId, 100);
		const messages = manager.buildSessionContext().messages;
		expect(messages.filter((message) => message.role === "system")).toHaveLength(1);
		expect(messages[0]?.role).toBe("system");
		expect(messages.map((message) => message.role)).toEqual([
			"system",
			"compactionSummary",
			"branchSummary",
			"user",
			"assistant",
			"compactionBoundary",
		]);
		expect(JSON.stringify(messages)).toContain("branch summary text");
	});
});
