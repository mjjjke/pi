import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMPACTION_BOUNDARY_TEXT_V1 } from "../../src/core/messages.ts";
import { type CompactionEntry, type FileEntry, SessionManager } from "../../src/core/session-manager.ts";

const APPROVED_TEXT =
	"Compaction boundary (not a request). Any messages between the compaction summary above and this point were kept from before the compaction: they are older than the summary, and the state they report describes when they were sent. Context-size readings from before the compaction no longer describe the current context; its size is unknown until a newer reading. Messages after this point are new. Standing instructions and running tasks are not affected by this boundary.";

function seeded(): SessionManager {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 0 });
	manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
	return manager;
}

describe("compaction boundary field (A1)", () => {
	it("the constant is the approved wording", () => {
		expect(COMPACTION_BOUNDARY_TEXT_V1).toBe(APPROVED_TEXT);
	});

	it("appendCompaction writes the literal boundary in the same entry", () => {
		const manager = seeded();
		const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
		const id = manager.appendCompaction("SUMMARY", kept, 100);
		const entry = manager.getEntry(id) as CompactionEntry;
		expect(entry.type).toBe("compaction");
		expect(entry.boundary).toBe(APPROVED_TEXT);
	});

	it("hook and empty-kept compactions carry it too", () => {
		const manager = seeded();
		const id = manager.appendCompaction("SUMMARY", null, 100, { x: 1 }, true);
		expect((manager.getEntry(id) as CompactionEntry).boundary).toBe(APPROVED_TEXT);
	});

	it("the boundary is persisted with the compaction line in the journal", () => {
		const dir = `${process.env.TMPDIR ?? "/tmp"}/boundary-a1-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 0 });
		manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "a" }],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		manager.appendCompaction("SUMMARY", null, 100);
		const lines = readFileSync(manager.getSessionFile() as string, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as FileEntry);
		const compactions = lines.filter((line) => line.type === "compaction") as CompactionEntry[];
		expect(compactions).toHaveLength(1);
		expect(compactions[0].boundary).toBe(APPROVED_TEXT);
	});

	it("an old compaction without the field stays without it", () => {
		const header = { type: "session" as const, version: 4, id: "s", timestamp: "2025-01-01T00:00:00Z", cwd: "/" };
		const old: CompactionEntry = {
			type: "compaction",
			id: "c1",
			parentId: null,
			timestamp: "2025-01-01T00:00:00Z",
			summary: "S",
			firstKeptEntryId: "c1",
			tokensBefore: 1,
		};
		const manager = SessionManager.inMemory("/", undefined, [header, old]);
		expect((manager.getEntry("c1") as CompactionEntry).boundary).toBeUndefined();
	});

	it("an existing entry keeps its stored text, whatever the constant says", () => {
		const header = { type: "session" as const, version: 4, id: "s", timestamp: "2025-01-01T00:00:00Z", cwd: "/" };
		const stored: CompactionEntry = {
			type: "compaction",
			id: "c1",
			parentId: null,
			timestamp: "2025-01-01T00:00:00Z",
			summary: "S",
			firstKeptEntryId: "c1",
			tokensBefore: 1,
			boundary: "OLDER WORDING",
		};
		const manager = SessionManager.inMemory("/", undefined, [header, stored]);
		expect((manager.getEntry("c1") as CompactionEntry).boundary).toBe("OLDER WORDING");
	});
});
