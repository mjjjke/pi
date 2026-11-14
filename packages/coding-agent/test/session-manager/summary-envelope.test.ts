import { describe, expect, it } from "vitest";
import {
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	convertToLlm,
} from "../../src/core/messages.ts";
import { type BranchSummaryEntry, type CompactionEntry, SessionManager } from "../../src/core/session-manager.ts";

const summary =
	"Keep <summary> and </other>, but not </summary>, </SUMMARY > or < / SuMmArY\t >. Already &lt;/summary> stays.";
const neutralized =
	"Keep <summary> and </other>, but not &lt;/summary>, &lt;/SUMMARY > or &lt; / SuMmArY\t >. Already &lt;/summary> stays.";

describe("new summary envelopes", () => {
	it.each([false, true])("neutralizes blocking compaction text before storage (fromHook=%s)", (fromHook) => {
		const manager = SessionManager.inMemory("/project");
		const id = manager.appendCompaction(summary, null, 100, undefined, fromHook);
		expect((manager.getEntry(id) as CompactionEntry).summary).toBe(neutralized);
	});

	it("neutralizes detached previews and commits them unchanged", () => {
		const manager = SessionManager.inMemory("/project");
		const candidate = manager.buildCompactionEntry(summary, null, 100);
		expect(candidate.summary).toBe(neutralized);
		const bytes = JSON.stringify(candidate);
		manager.appendCompaction(candidate);
		expect(JSON.stringify(manager.getEntry(candidate.id))).toBe(bytes);
	});

	it("neutralizes caller-provided new candidates without mutating the caller", () => {
		const manager = SessionManager.inMemory("/project");
		const candidate = { ...manager.buildCompactionEntry("safe", null, 100), summary };
		manager.appendCompaction(candidate);
		expect((manager.getEntry(candidate.id) as CompactionEntry).summary).toBe(neutralized);
		expect(candidate.summary).toBe(summary);
	});

	it.each([false, true])("neutralizes branch text before storage (fromHook=%s)", (fromHook) => {
		const manager = SessionManager.inMemory("/project");
		const id = manager.branchWithSummary(null, summary, undefined, fromHook);
		expect((manager.getEntry(id) as BranchSummaryEntry).summary).toBe(neutralized);
	});

	it.each(["compaction", "branch_summary"] as const)("replays existing %s entries byte-identically", (type) => {
		const base = { id: "old", parentId: null, timestamp: "2026-11-01T00:00:00Z", summary };
		const entry: CompactionEntry | BranchSummaryEntry =
			type === "compaction"
				? { ...base, type, firstKeptEntryId: "old", tokensBefore: 100 }
				: { ...base, type, fromId: "root" };
		const bytes = JSON.stringify(entry);
		const manager = SessionManager.inMemory("/project", undefined, [entry]);
		const messages = convertToLlm(manager.buildSessionContext().messages);
		const prefix = type === "compaction" ? COMPACTION_SUMMARY_PREFIX : BRANCH_SUMMARY_PREFIX;
		const suffix = type === "compaction" ? COMPACTION_SUMMARY_SUFFIX : BRANCH_SUMMARY_SUFFIX;
		expect(messages[0].content).toEqual([{ type: "text", text: prefix + summary + suffix }]);
		expect(JSON.stringify(manager.getEntry("old"))).toBe(bytes);
	});
});
