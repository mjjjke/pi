import { readFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { describe, expect, it } from "vitest";
import { prepareCompaction } from "../../src/core/compaction/compaction.ts";
import { COMPACTION_BOUNDARY_TEXT_V1, COMPACTION_BOUNDARY_TEXT_V2, convertToLlm } from "../../src/core/messages.ts";
import {
	buildContextEntries,
	buildSessionProjection,
	type CompactionEntry,
	type FileEntry,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.ts";

const APPROVED_TEXT_V1 =
	"Compaction boundary (not a request). Any messages between the compaction summary above and this point were kept from before the compaction: they are older than the summary, and the state they report describes when they were sent. Context-size readings from before the compaction no longer describe the current context; its size is unknown until a newer reading. Messages after this point are new. Standing instructions and running tasks are not affected by this boundary.";

const APPROVED_TEXT =
	"Compaction boundary (not a request). Any messages between the compaction summary above and this point were kept from before the compaction; they may contain later updates than the summary, and those updates take precedence. The state they report describes when they were sent. Context-size readings from before the compaction no longer describe the current context; its size is unknown until a newer reading. Messages after this point are new. Standing instructions and running tasks are not affected by this boundary.";

function seeded(): SessionManager {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 0 });
	manager.appendMessage({ role: "user", content: "old", timestamp: 1 });
	return manager;
}

describe("compaction boundary field (A1)", () => {
	it("the constant is the approved wording", () => {
		expect(COMPACTION_BOUNDARY_TEXT_V1).toBe(APPROVED_TEXT_V1);
		expect(COMPACTION_BOUNDARY_TEXT_V2).toBe(APPROVED_TEXT);
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

	it("loading and appending do not rewrite an existing V1 boundary or its projection", () => {
		const manager = seeded();
		const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
		const candidate = manager.buildCompactionEntry("OLD", kept, 100, undefined, false, undefined, {
			boundary: APPROVED_TEXT_V1,
		});
		manager.appendCompaction(candidate);
		const bytes = JSON.stringify(candidate);
		const projection = JSON.stringify(manager.buildSessionProjection().messages);
		const loaded = SessionManager.inMemory("/", undefined, [manager.getHeader()!, ...manager.getEntries()]);
		expect(JSON.stringify(loaded.buildSessionProjection().messages)).toBe(projection);
		loaded.appendMessage({ role: "user", content: "new", timestamp: 3 });
		expect(JSON.stringify(loaded.getEntry(candidate.id))).toBe(bytes);
		expect(loaded.buildCompactionEntry("NEW", null, 100).boundary).toBe(APPROVED_TEXT);
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

// ---------------------------------------------------------------------------
// A3: projection span
// ---------------------------------------------------------------------------

const T = "2026-10-24T00:00:00.000Z";
const usage = (total: number) => ({
	input: total,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: total,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function user(id: string, parentId: string | null, text: string): SessionEntry {
	return { type: "message", id, parentId, timestamp: T, message: { role: "user", content: text, timestamp: 1 } };
}

function reply(id: string, parentId: string | null, text: string, calls: string[] = [], total = 10): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: T,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text },
				...calls.map((call) => ({ type: "toolCall" as const, id: call, name: "read", arguments: {} })),
			],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: usage(total),
			stopReason: calls.length > 0 ? "toolUse" : "stop",
			timestamp: 2,
		},
	};
}

function result(id: string, parentId: string | null, call: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: T,
		message: { role: "toolResult", toolCallId: call, toolName: "read", content: [], isError: false, timestamp: 3 },
	};
}

function notice(id: string, parentId: string | null, text: string): SessionEntry {
	return { type: "custom_message", id, parentId, timestamp: T, customType: "n", content: text, display: false };
}

function compact(
	id: string,
	parentId: string | null,
	firstKeptEntryId: string,
	marked = true,
	extra: Partial<CompactionEntry> = {},
): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: T,
		summary: `SUMMARY ${id}`,
		firstKeptEntryId,
		tokensBefore: 100,
		systemMessage: { role: "system", content: "SYS", sections: {}, timestamp: 0 },
		standing: [{ key: "mode", message: { role: "developer", content: "MASK", timestamp: 0 } }],
		...(marked ? { boundary: COMPACTION_BOUNDARY_TEXT_V1 } : {}),
		...extra,
	};
}

function text(message: AgentMessage): string {
	switch (message.role) {
		case "compactionSummary":
			return `summary:${message.summary}`;
		case "compactionBoundary":
			return "BOUNDARY";
		case "system":
			return `system:${typeof message.content === "string" ? message.content : ""}`;
		case "developer":
			return `developer:${typeof message.content === "string" ? message.content : ""}`;
		case "custom":
			return `custom:${typeof message.content === "string" ? message.content : ""}`;
		case "user":
			return `user:${typeof message.content === "string" ? message.content : ""}`;
		case "assistant":
			return `assistant:${message.content.map((block) => (block.type === "text" ? block.text : block.type)).join("+")}`;
		case "toolResult":
			return `toolResult:${message.toolCallId}`;
		default:
			return message.role;
	}
}

function order(entries: SessionEntry[]): string[] {
	return buildSessionProjection(entries).messages.map(text);
}

const base: SessionEntry[] = [
	{
		type: "message",
		id: "sys",
		parentId: null,
		timestamp: T,
		message: { role: "system", content: "SYS", sections: {}, timestamp: 0 },
	},
	user("u1", "sys", "old"),
	reply("a1", "u1", "old reply"),
	user("u2", "a1", "kept"),
	notice("g", "u2", "gauge 201k"),
	reply("a2", "g", "kept reply"),
];

describe("compaction boundary projection (A3)", () => {
	it("orders [system, standing, summary, kept…, boundary, new…]", () => {
		const entries = [...base, compact("c", "a2", "u2"), user("u3", "c", "new")];
		expect(order(entries)).toEqual([
			"system:SYS",
			"developer:MASK",
			"summary:SUMMARY c",
			"user:kept",
			"custom:gauge 201k",
			"assistant:kept reply",
			"BOUNDARY",
			"user:new",
		]);
	});

	it("the boundary span is a second span of the compaction, with the compaction's timestamp", () => {
		const entries = [...base, compact("c", "a2", "u2"), user("u3", "c", "new")];
		const projection = buildSessionProjection(entries);
		const spans = projection.entries.filter((entry) => entry.sourceEntry.id === "c");
		expect(spans).toHaveLength(2);
		expect(spans[0].part).toBeUndefined();
		expect(spans[1].part).toBe("boundary");
		expect(spans[1].messages).toEqual([
			{ role: "compactionBoundary", text: COMPACTION_BOUNDARY_TEXT_V1, timestamp: Date.parse(T) },
		]);
		// Projection-only: the raw entry list is unchanged.
		expect(buildContextEntries(entries).filter((entry) => entry.id === "c")).toHaveLength(1);
	});

	it("uses the stored literal, not the current constant", () => {
		const entries = [...base, compact("c", "a2", "u2", true, { boundary: "OLDER WORDING" })];
		const boundary = buildSessionProjection(entries).messages.find((m) => m.role === "compactionBoundary");
		expect(boundary).toMatchObject({ text: "OLDER WORDING" });
	});

	it("an unmarked compaction projects exactly as before (no span, byte-identical)", () => {
		const entries = [...base, compact("c", "a2", "u2", false), user("u3", "c", "new")];
		const projection = buildSessionProjection(entries);
		expect(projection.entries.some((entry) => entry.part === "boundary")).toBe(false);
		expect(order(entries)).toEqual([
			"system:SYS",
			"developer:MASK",
			"summary:SUMMARY c",
			"user:kept",
			"custom:gauge 201k",
			"assistant:kept reply",
			"user:new",
		]);
	});

	it("empty kept range: boundary directly after the summary", () => {
		const entries = [...base, compact("c", "a2", "c"), user("u3", "c", "new")];
		expect(order(entries)).toEqual(["system:SYS", "developer:MASK", "summary:SUMMARY c", "BOUNDARY", "user:new"]);
	});

	it("an older compaction inside the kept range contributes nothing (one boundary)", () => {
		const entries = [
			...base,
			compact("c1", "a2", "u2"),
			user("u3", "c1", "after c1"),
			reply("a3", "u3", "r3"),
			compact("c2", "a3", "c1"),
			user("u4", "c2", "after c2"),
		];
		const messages = order(entries);
		expect(messages.filter((m) => m === "BOUNDARY")).toHaveLength(1);
		expect(messages).toEqual([
			"system:SYS",
			"developer:MASK",
			"summary:SUMMARY c2",
			"user:after c1",
			"assistant:r3",
			"BOUNDARY",
			"user:after c2",
		]);
	});

	it("repeated compaction: only the newest boundary, after its own kept range", () => {
		const entries = [
			...base,
			compact("c1", "a2", "u2"),
			user("u3", "c1", "after c1"),
			reply("a3", "u3", "r3"),
			compact("c2", "a3", "u3"),
		];
		expect(order(entries)).toEqual([
			"system:SYS",
			"developer:MASK",
			"summary:SUMMARY c2",
			"user:after c1",
			"assistant:r3",
			"BOUNDARY",
		]);
	});

	it("a context edit omitting the last kept entry keeps the boundary after the kept range", () => {
		const edit: SessionEntry = {
			type: "context_edit",
			id: "e",
			parentId: "u3",
			timestamp: T,
			targetId: "a2",
			replacement: null,
		};
		const entries = [...base, compact("c", "a2", "u2"), user("u3", "c", "new"), edit];
		expect(order(entries)).toEqual([
			"system:SYS",
			"developer:MASK",
			"summary:SUMMARY c",
			"user:kept",
			"custom:gauge 201k",
			"BOUNDARY",
			"user:new",
		]);
	});

	it("keeps call/result adjacency; an orphan call gets its synthetic result before the boundary", () => {
		const adjacency = [
			...base,
			user("u3", "a2", "call"),
			reply("a3", "u3", "calling", ["t1"]),
			result("r1", "a3", "t1"),
			compact("c", "r1", "u3"),
		];
		expect(order(adjacency).slice(-4)).toEqual([
			"user:call",
			"assistant:calling+toolCall",
			"toolResult:t1",
			"BOUNDARY",
		]);

		const orphan = [
			...base,
			user("u3", "a2", "call"),
			reply("a3", "u3", "calling", ["t1"]),
			compact("c", "a3", "u3"),
		];
		const model = { id: "faux", api: "faux", provider: "faux", input: ["text"] } as unknown as Model<"faux">;
		const wire = transformMessages(convertToLlm(buildSessionProjection(orphan).messages), model);
		expect(wire.slice(-3).map((message) => message.role)).toEqual(["assistant", "toolResult", "user"]);
		expect(wire.at(-1)).toMatchObject({ content: [{ type: "text", text: COMPACTION_BOUNDARY_TEXT_V1 }] });
	});

	it("never cuts at the boundary; firstKeptEntryId never resolves to it", () => {
		const settings = { enabled: true, reserveTokens: 0, keepRecentTokens: 1 };
		// Empty kept range followed by new turns: the previous boundary span must not become the cut.
		const entries = [
			...base,
			compact("c", "a2", "c"),
			user("u3", "c", "x".repeat(400)),
			reply("a3", "u3", "y".repeat(400)),
			user("u4", "a3", "z".repeat(400)),
			reply("a4", "u4", "w".repeat(400)),
		];
		const preparation = prepareCompaction(entries, settings);
		expect(preparation).toBeDefined();
		expect(preparation?.firstKeptEntryId).not.toBe("c");
		expect(["u3", "a3", "u4", "a4"]).toContain(preparation?.firstKeptEntryId);
		expect(preparation?.messagesToSummarize.some((message) => message.role === "compactionBoundary")).toBe(false);
		expect(preparation?.previousSummary).toBe("SUMMARY c");

		// Only the boundary after the summary: nothing to compact.
		expect(
			prepareCompaction([...base, compact("c", "a2", "c"), user("u3", "c", "n")], settings)?.firstKeptEntryId,
		).not.toBe("c");
	});
});
