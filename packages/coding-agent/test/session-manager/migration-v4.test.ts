import { describe, expect, it } from "vitest";
import {
	buildSessionProjection,
	type FileEntry,
	migrateSessionEntries,
	type SessionEntry,
} from "../../src/core/session-manager.ts";

type Raw = Record<string, unknown> & { id: string; parentId: string | null };

const header = (version = 3): FileEntry => ({
	type: "session",
	version,
	id: "sess",
	timestamp: "2026-10-22T00:00:00.000Z",
	cwd: "/tmp",
});

let clock = 0;
function chain(...entries: Array<Omit<Raw, "parentId"> & { parentId?: string | null }>): FileEntry[] {
	let previous: string | null = null;
	return entries.map((entry) => {
		const parentId = entry.parentId === undefined ? previous : (entry.parentId as string | null);
		previous = entry.id as string;
		return { timestamp: new Date(++clock).toISOString(), ...entry, parentId } as unknown as FileEntry;
	});
}

const msg = (id: string, role: string, text: string, extra: Record<string, unknown> = {}) => ({
	type: "message",
	id,
	message: { role, content: text, timestamp: 1, ...extra },
});
const sys = (id: string, text = "prompt") => msg(id, "system", text);
const dev = (id: string, text = "mask") => msg(id, "developer", text);
const user = (id: string, text = "hi") => msg(id, "user", text);
const assistant = (id: string) => ({
	type: "message",
	id,
	message: {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
		timestamp: 2,
	},
});
const custom = (id: string) => ({
	type: "custom_message",
	id,
	customType: "handoff",
	content: "handoff",
	display: true,
});
const state = (id: string) => ({ type: "custom", id, customType: "mode", data: {} });
const model = (id: string) => ({ type: "model_change", id, provider: "p", modelId: "m" });

const shape = (entries: FileEntry[]) =>
	entries.slice(1).map((entry) => {
		const e = entry as unknown as Raw & { message?: { role: string } };
		return `${e.message?.role ?? e.type}:${e.id}<${e.parentId ?? "-"}`;
	});

const sessionEntries = (entries: FileEntry[]) => entries.filter((entry) => entry.type !== "session") as SessionEntry[];
const leafOf = (entries: FileEntry[]) => (entries.at(-1) as unknown as Raw).id;

describe("migrateSessionEntries v3 -> v4", () => {
	it("moves the system to the first slot of a developer-first prefix (worked example of the design)", () => {
		const entries = [
			header(),
			...chain(
				model("m1"),
				{ type: "thinking_level_change", id: "t1", thinkingLevel: "high" },
				state("s1"),
				state("s2"),
				custom("h1"),
				state("s3"),
				state("s4"),
				dev("d1"),
				sys("S"),
				user("u1"),
				assistant("a1"),
			),
		];
		const report = migrateSessionEntries(entries);
		expect((entries[0] as { version: number }).version).toBe(4);
		expect(shape(entries)).toEqual([
			"model_change:m1<-",
			"thinking_level_change:t1<m1",
			"custom:s1<t1",
			"custom:s2<s1",
			"system:S<s2",
			"custom:s3<S",
			"custom:s4<s3",
			"developer:d1<s4",
			"custom_message:h1<d1",
			"user:u1<h1",
			"assistant:a1<u1",
		]);
		expect(report.permutedBlocks).toBe(1);
		expect(leafOf(entries)).toBe("a1");
		const projection = buildSessionProjection(sessionEntries(entries), "a1");
		expect(projection.messages.map((message) => message.role)).toEqual([
			"system",
			"developer",
			"custom",
			"user",
			"assistant",
		]);
	});

	it.each([
		["developer-first", [dev("d1"), dev("d2"), sys("S")], ["system:S<-", "developer:d1<S", "developer:d2<d1"]],
		["content-first", [custom("h1"), sys("S")], ["system:S<-", "custom_message:h1<S"]],
		[
			"mixed",
			[user("u0"), dev("d1"), custom("h1"), sys("S")],
			["system:S<-", "developer:d1<S", "user:u0<d1", "custom_message:h1<u0"],
		],
	])("canonicalizes a %s prefix and keeps ids and the leaf", (_name, prefix, expected) => {
		const entries = [header(), ...chain(...prefix, user("u1"), assistant("a1"))];
		migrateSessionEntries(entries);
		const last = (expected.at(-1) as string).split(":")[1]!.split("<")[0];
		expect(shape(entries)).toEqual([...expected, `user:u1<${last}`, `assistant:a1<u1`]);
	});

	it("reparents every child of S to the new block end", () => {
		const entries = [
			header(),
			...chain(dev("d1"), sys("S"), user("u1"), assistant("a1"), { ...user("u2"), parentId: "S" }, assistant("a2")),
		];
		migrateSessionEntries(entries);
		const parent = (id: string) =>
			(entries.find((entry) => (entry as unknown as Raw).id === id) as unknown as Raw).parentId;
		expect(parent("u1")).toBe("d1");
		expect(parent("u2")).toBe("d1");
		expect(leafOf(entries)).toBe("a2");
	});

	it("remaps firstKeptEntryId into a permuted block and backfills checkpoints", () => {
		const entries = [
			header(),
			...chain(dev("d1"), sys("S"), user("u1"), assistant("a1"), {
				type: "compaction",
				id: "c1",
				summary: "sum",
				firstKeptEntryId: "d1",
				tokensBefore: 1,
			}),
			...chain({ ...user("u2"), parentId: "c1" }, assistant("a2")),
		];
		const report = migrateSessionEntries(entries);
		const compaction = entries.find((entry) => (entry as unknown as Raw).id === "c1") as unknown as {
			firstKeptEntryId: string;
			systemMessage?: { role: string; content: string };
		};
		expect(compaction.firstKeptEntryId).toBe("S");
		expect(compaction.systemMessage).toMatchObject({ role: "system", content: "prompt" });
		expect(report.remappedTargets).toBe(1);
		expect(report.backfilledCheckpoints).toBe(1);
		const projection = buildSessionProjection(sessionEntries(entries), "a2");
		expect(projection.messages[0]?.role).toBe("system");
	});

	it.each([
		["branch inside the prefix", [dev("d1"), sys("S"), user("u1"), { ...user("x"), parentId: "d1" }, assistant("a")]],
		["assistant before system", [user("u0"), assistant("a0"), sys("S"), user("u1")]],
		["terminal S", [dev("d1"), sys("S")]],
	])("skips and reports a %s, still bumping the version", (_name, prefix) => {
		const entries = [header(), ...chain(...(prefix as Array<Omit<Raw, "parentId">>))];
		const before = JSON.stringify(entries.slice(1));
		const leaf = leafOf(entries);
		const report = migrateSessionEntries(entries);
		expect(JSON.stringify(entries.slice(1))).toBe(before);
		expect(leafOf(entries)).toBe(leaf);
		expect((entries[0] as { version: number }).version).toBe(4);
		expect(report.skipped).toHaveLength(1);
		expect(report.permutedBlocks).toBe(0);
	});

	it("is idempotent: canonical prefixes and v4 files are untouched", () => {
		const entries = [header(), ...chain(sys("S"), dev("d1"), user("u1"), assistant("a1"))];
		const before = JSON.stringify(entries.slice(1));
		const report = migrateSessionEntries(entries);
		expect(JSON.stringify(entries.slice(1))).toBe(before);
		expect(report.permutedBlocks).toBe(0);
		const second = [header(4), ...chain(dev("d1"), sys("S2"), user("u2"))];
		const secondBefore = JSON.stringify(second);
		migrateSessionEntries(second);
		expect(JSON.stringify(second)).toBe(secondBefore);
	});

	it("leaves a prefix without context entries alone", () => {
		const entries = [header(), ...chain(model("m1"), state("s1"), sys("S"), user("u1"))];
		const before = JSON.stringify(entries.slice(1));
		const report = migrateSessionEntries(entries);
		expect(JSON.stringify(entries.slice(1))).toBe(before);
		expect(report.skipped).toEqual([]);
	});
});
