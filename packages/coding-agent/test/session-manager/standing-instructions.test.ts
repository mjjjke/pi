import { describe, expect, it } from "vitest";
import {
	buildSessionProjection,
	type CompactionEntry,
	getStandingState,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.ts";
import * as oldReader from "./fixtures/v3-reader-main.ts";

const KEY = "collaboration-mode";
const timestamp = "2026-10-23T00:00:00.000Z";
const snapshot = { role: "system", content: "snapshot", timestamp: 0 };

type Raw = Record<string, unknown> & { id: string };
function chain(...entries: Raw[]): SessionEntry[] {
	let parentId: string | null = null;
	return entries.map((entry) => {
		const linked = { timestamp, parentId, ...entry } as unknown as SessionEntry;
		parentId = entry.id;
		return linked;
	});
}
const system = (id: string): Raw => ({ type: "message", id, message: snapshot });
const keyed = (id: string, content: string, key = KEY): Raw => ({
	type: "message",
	id,
	standingKey: key,
	message: { role: "developer", content, timestamp: 0 },
});
const oneShot = (id: string, content: string): Raw => ({
	type: "message",
	id,
	message: { role: "developer", content, timestamp: 0 },
});
const user = (id: string, content = "task"): Raw => ({
	type: "message",
	id,
	message: { role: "user", content, timestamp: 0 },
});
const state = (id: string, content?: string, apply?: string, key = KEY): Raw => ({
	type: "standing_instruction",
	id,
	key,
	...(content === undefined ? {} : { content }),
	...(apply ? { apply } : {}),
});
const oldCompaction = (id: string, firstKeptEntryId: string): Raw => ({
	type: "compaction",
	id,
	summary: "summary",
	firstKeptEntryId,
	tokensBefore: 100,
	systemMessage: snapshot,
});
const awareCompaction = (id: string, firstKeptEntryId: string, carried: Array<[string, string]>): Raw => ({
	...oldCompaction(id, firstKeptEntryId),
	standing: carried.map(([key, content]) => ({ key, message: { role: "developer", content, timestamp: 0 } })),
});

const only = (entries: SessionEntry[]) => {
	const states = getStandingState(entries);
	expect(states).toHaveLength(1);
	return states[0]!;
};
const roles = (entries: SessionEntry[], leaf: string) =>
	buildSessionProjection(entries, leaf).messages.map((message) => message.role);

describe("getStandingState (§7.2)", () => {
	it("desired is the latest state entry; a cleared entry leaves none; without a state entry the latest keyed developer is desired and delivered (legacy tag)", () => {
		const legacy = only(chain(system("s"), keyed("d", "Plan"), user("u")));
		expect(legacy).toMatchObject({
			key: KEY,
			desired: { content: "Plan", apply: "next-input" },
			delivered: { content: "Plan", entryId: "d" },
			pending: false,
		});

		const set = only(chain(system("s"), keyed("d", "Plan"), state("x", "Default", "next-request")));
		expect(set).toMatchObject({ desired: { content: "Default", apply: "next-request" }, pending: true });

		const cleared = only(chain(system("s"), keyed("d", "Plan"), state("x", "Default"), state("y")));
		expect(cleared.desired).toBeUndefined();
		expect(cleared.pending).toBe(false);
	});

	it("compares content as canonical JSON", () => {
		const entries = chain(
			system("s"),
			{
				type: "message",
				id: "d",
				standingKey: KEY,
				message: { role: "developer", content: [{ text: "Plan", type: "text" }], timestamp: 0 },
			},
			{ type: "standing_instruction", id: "x", key: KEY, content: [{ type: "text", text: "Plan" }] },
		);
		expect(only(entries).pending).toBe(false);
	});

	it("a standing-aware compaction resets delivered to its items", () => {
		const entries = chain(
			system("s"),
			keyed("d1", "Plan"),
			keyed("d2", "Profile", "subagent-planning"),
			user("u"),
			state("x", "Default"),
			awareCompaction("c", "u", [[KEY, "Default"]]),
		);
		const [mode, planning] = getStandingState(entries);
		expect(mode).toMatchObject({ key: KEY, delivered: { content: "Default", entryId: "c" }, pending: false });
		expect(planning).toMatchObject({ key: "subagent-planning", desired: { content: "Profile" }, pending: true });
		expect(planning?.delivered).toBeUndefined();
	});

	describe("legacy (Astra recheck 3 F2): system → Plan mask[keyed] → user → old compaction C", () => {
		it("at an old C that retains the user but not the mask: desired Plan, delivered none, pending; projection unchanged", () => {
			const entries = chain(system("s"), keyed("d", "Plan"), user("u"), oldCompaction("c", "u"));
			const plan = only(entries);
			expect(plan).toMatchObject({ desired: { content: "Plan", apply: "next-input" }, pending: true });
			expect(plan.delivered).toBeUndefined();
			expect(roles(entries, "c")).toEqual(["system", "compactionSummary", "user"]);
			expect(entries.some((entry) => entry.type === "standing_instruction")).toBe(false);
		});

		it("with the mask retained: delivered Plan, not pending", () => {
			const entries = chain(system("s"), keyed("d", "Plan"), user("u"), oldCompaction("c", "d"));
			expect(only(entries)).toMatchObject({ delivered: { content: "Plan", entryId: "d" }, pending: false });
		});

		it("two tagged masks, only the later retained: delivered is the later", () => {
			const entries = chain(
				system("s"),
				keyed("d1", "Default"),
				user("u1"),
				keyed("d2", "Plan"),
				user("u2"),
				oldCompaction("c", "d2"),
			);
			expect(only(entries)).toMatchObject({
				desired: { content: "Plan" },
				delivered: { content: "Plan", entryId: "d2" },
				pending: false,
			});
		});

		it("a later reassertion after C sets delivered again", () => {
			const entries = chain(
				system("s"),
				keyed("d", "Plan"),
				user("u"),
				oldCompaction("c", "u"),
				keyed("d2", "Plan"),
			);
			expect(only(entries)).toMatchObject({ delivered: { content: "Plan", entryId: "d2" }, pending: false });
		});

		it("an old compaction after a standing-aware one (rollback) resets delivered to its kept range", () => {
			const entries = chain(
				system("s"),
				keyed("d", "Plan"),
				user("u1"),
				awareCompaction("c1", "u1", [[KEY, "Plan"]]),
				user("u2"),
				oldCompaction("c2", "u2"),
			);
			expect(only(entries)).toMatchObject({ desired: { content: "Plan" }, pending: true });
		});
	});

	it("key order is first appearance on the branch", () => {
		const entries = chain(
			system("s"),
			state("a", "x", undefined, "b-key"),
			keyed("d", "Plan"),
			state("b", "y", undefined, "a-key"),
			state("c", "z", undefined, "b-key"),
		);
		expect(getStandingState(entries).map((item) => item.key)).toEqual(["b-key", KEY, "a-key"]);
	});
});

describe("standing projection (§7.4)", () => {
	it("the kept range of a standing-aware compaction hides keyed developers of every key, also cleared keys, and keeps unkeyed developers; journal and getBranch() unchanged", () => {
		const entries = chain(
			system("s"),
			keyed("d1", "Plan"),
			keyed("d2", "Profile", "subagent-planning"),
			oneShot("o1", "notice"),
			user("u"),
			state("x", undefined, undefined, "subagent-planning"),
			awareCompaction("c", "d1", [[KEY, "Plan"]]),
		);
		const projection = buildSessionProjection(entries, "c");
		expect(
			projection.messages.map((message) =>
				message.role === "developer" ? `developer:${message.content}` : message.role,
			),
		).toEqual(["system", "developer:Plan", "compactionSummary", "developer:notice", "user"]);
		const manager = SessionManager.inMemory("/tmp", undefined, [
			{ type: "session", version: 4, id: "x", timestamp, cwd: "/tmp" },
			...entries,
		]);
		expect(manager.getBranch().map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
		expect(manager.getEntries()).toHaveLength(entries.length);
	});

	it("a later compaction whose kept range starts earlier still hides them; an old compaction hides nothing", () => {
		const base = [system("s"), keyed("d1", "Plan"), user("u1"), awareCompaction("c1", "u1", [[KEY, "Plan"]])];
		const later = chain(...base, user("u2"), awareCompaction("c2", "d1", [[KEY, "Plan"]]));
		expect(roles(later, "c2")).toEqual(["system", "developer", "compactionSummary", "user", "user"]);
		const old = chain(...base, user("u2"), oldCompaction("c2", "d1"));
		expect(roles(old, "c2")).toEqual(["system", "compactionSummary", "developer", "user", "user"]);
	});

	it("the pinned main-branch v3 reader projects the same messages except the carried values", () => {
		const entries = chain(
			system("s"),
			keyed("d1", "Plan"),
			user("u"),
			state("x", "Plan"),
			awareCompaction("c", "u", [[KEY, "Plan"]]),
			user("u2"),
		);
		const current = buildSessionProjection(entries, "u2").messages;
		// The rollback build itself (fixtures/v3-reader-main.ts): unknown entry type, `standing` field ignored.
		const old = oldReader.buildSessionProjection(entries, "u2").messages;
		expect(current.filter((message) => message.role !== "developer")).toEqual(old);
		expect(current.filter((message) => message.role === "developer")).toHaveLength(1);
		expect(old.some((message) => message.role === "developer")).toBe(false);
	});

	it("the pinned main-branch v3 reader shows a hidden kept keyed developer again (rollback, \u00a74.1)", () => {
		const entries = chain(system("s"), keyed("d1", "Plan"), user("u1"), awareCompaction("c", "d1", [[KEY, "Plan"]]));
		const developers = (messages: { role: string }[]) => messages.filter((message) => message.role === "developer");
		expect(developers(buildSessionProjection(entries, "c").messages)).toHaveLength(1);
		expect(developers(oldReader.buildSessionProjection(entries, "c").messages)).toHaveLength(1);
		expect(oldReader.buildSessionProjection(entries, "c").messages.map((message) => message.role)).toEqual([
			"system",
			"compactionSummary",
			"developer",
			"user",
		]);
	});
});

describe("SessionManager standing writes", () => {
	const fresh = () => {
		const manager = SessionManager.inMemory("/tmp");
		manager.appendMessage(snapshot as never);
		return manager;
	};

	it("appendStandingInstruction deep-copies content and appendMessage records standingKey", () => {
		const manager = fresh();
		const content = [{ type: "text" as const, text: "Plan" }];
		const stateId = manager.appendStandingInstruction(KEY, content, "next-request");
		content[0]!.text = "mutated";
		expect(manager.getEntry(stateId)).toMatchObject({
			type: "standing_instruction",
			key: KEY,
			content: [{ type: "text", text: "Plan" }],
			apply: "next-request",
		});
		const clearId = manager.appendStandingInstruction(KEY, undefined);
		expect(manager.getEntry(clearId)).not.toHaveProperty("content");

		const developerId = manager.appendMessage(
			{ role: "developer", content: "Plan", timestamp: 1 },
			{ standingKey: KEY },
		);
		expect(manager.getEntry(developerId)).toMatchObject({ standingKey: KEY });
		expect(() => manager.appendMessage({ role: "user", content: "x", timestamp: 1 }, { standingKey: KEY })).toThrow();
		expect(() => manager.appendStandingInstruction("", "x")).toThrow();
	});

	it("appendCompaction with carry desired carries the pending value; with carry delivered the delivered one; a cleared key carries nothing; items are frozen with the entry timestamp; the field is [] when nothing is carried", () => {
		const build = () => {
			const manager = fresh();
			manager.appendMessage({ role: "developer", content: "Default", timestamp: 1 }, { standingKey: KEY });
			manager.appendMessage({ role: "developer", content: "Profile", timestamp: 1 }, { standingKey: "other" });
			const userId = manager.appendMessage({ role: "user", content: "task", timestamp: 1 });
			manager.appendStandingInstruction(KEY, "Plan");
			manager.appendStandingInstruction("other", undefined);
			return { manager, userId };
		};
		const carried = (manager: SessionManager, id: string) => {
			const entry = manager.getEntry(id) as CompactionEntry;
			return { entry, items: entry.standing!.map((item) => [item.key, item.message.content]) };
		};

		const desired = build();
		const desiredId = desired.manager.appendCompaction("s", desired.userId, 1, undefined, undefined, undefined, {
			carry: "desired",
		});
		const { entry, items } = carried(desired.manager, desiredId);
		expect(items).toEqual([[KEY, "Plan"]]);
		expect(entry.standing![0]!.message).toEqual({
			role: "developer",
			content: "Plan",
			timestamp: new Date(entry.timestamp).getTime(),
		});
		expect(Object.isFrozen(entry.standing![0]!.message)).toBe(true);
		expect(desired.manager.getStandingState()[0]).toMatchObject({ key: KEY, pending: false });

		const delivered = build();
		const deliveredId = delivered.manager.appendCompaction("s", delivered.userId, 1);
		expect(carried(delivered.manager, deliveredId).items).toEqual([[KEY, "Default"]]);
		expect(delivered.manager.getStandingState()[0]).toMatchObject({ key: KEY, pending: true });

		const empty = fresh();
		const emptyUser = empty.appendMessage({ role: "user", content: "task", timestamp: 1 });
		const emptyId = empty.appendCompaction("s", emptyUser, 1);
		expect((empty.getEntry(emptyId) as CompactionEntry).standing).toEqual([]);
	});
});
