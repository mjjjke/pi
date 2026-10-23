/**
 * Data-safety regressions from code review A (review-astra-A.md findings 1, 3-8): compaction targets on
 * non-context block slots, read-only loading, concurrent appends during a stray rewrite, failed branched
 * files, permissions and mtimes of rewritten files, and unparseable journal lines.
 */
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildSessionProjection,
	type FileEntry,
	findMostRecentSession,
	migrateSessionEntries,
	type SessionEntry,
	SessionManager,
	writeSessionFileAtomic,
} from "../../src/core/session-manager.ts";

// Pass-through fs with fault hooks.
const hooks = vi.hoisted(() => ({
	/** Runs once at the first append to, or temp fsync for, `target` (whichever comes first). */
	inject: undefined as undefined | { target: string; run: () => void },
	/** Throw EIO from the next fsync. */
	failFsync: false,
}));
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	const fire = () => {
		const pending = hooks.inject;
		hooks.inject = undefined;
		pending?.run();
	};
	return {
		...actual,
		appendFileSync: (target: unknown, ...rest: unknown[]) => {
			if (hooks.inject && target === hooks.inject.target) fire();
			return (actual.appendFileSync as (...args: unknown[]) => void)(target, ...rest);
		},
		fsyncSync: (fd: number) => {
			if (hooks.inject) fire();
			if (hooks.failFsync) {
				hooks.failFsync = false;
				throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
			}
			return actual.fsyncSync(fd);
		},
	};
});

type Raw = Record<string, unknown> & { id: string };

const header = (version = 3, cwd = "/tmp"): FileEntry => ({
	type: "session",
	version,
	id: "sess",
	timestamp: "2026-10-22T00:00:00.000Z",
	cwd,
});
function chain(...entries: Raw[]): FileEntry[] {
	let parentId: string | null = null;
	return entries.map((entry) => {
		const result = { timestamp: "2026-10-22T00:00:01.000Z", ...entry, parentId } as unknown as FileEntry;
		parentId = entry.id;
		return result;
	});
}
const msg = (id: string, role: string, content: string) => ({
	type: "message",
	id,
	message: { role, content, timestamp: 1 },
});
const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const sessionEntries = (entries: FileEntry[]) =>
	entries.filter((entry): entry is SessionEntry => entry.type !== "session");
const projected = (entries: FileEntry[]) =>
	buildSessionProjection(sessionEntries(entries)).messages.map((message) => [
		message.role,
		"content" in message ? message.content : null,
	]);

let dir: string;
let savedUmask: number;
beforeEach(() => {
	dir = realFs.realpathSync(realFs.mkdtempSync(join(tmpdir(), "pi-migration-safety-")));
	savedUmask = process.umask();
});
afterEach(() => {
	hooks.inject = undefined;
	hooks.failFsync = false;
	process.umask(savedUmask);
	realFs.rmSync(dir, { recursive: true, force: true });
});
const write = (name: string, content: string) => {
	const file = join(dir, name);
	realFs.writeFileSync(file, content);
	return file;
};

describe("finding 1: compaction target on a non-context slot of a permuted block", () => {
	it("moves the target to the block's first entry, keeping a superset of the old range", () => {
		const entries = [
			header(),
			...chain(
				msg("h1", "user", "seed1"),
				msg("h2", "user", "seed2"),
				{ type: "custom", id: "state", customType: "state" },
				msg("d", "developer", "policy"),
				msg("s", "system", "prompt"),
				msg("u", "user", "task"),
				{
					type: "compaction",
					id: "c",
					summary: "summary",
					firstKeptEntryId: "state",
					tokensBefore: 1,
					systemMessage: { role: "system", content: "prompt", timestamp: 1 },
				},
			),
		];
		const before = projected(entries);
		const report = migrateSessionEntries(entries);
		const after = projected(entries);
		expect(report.remappedTargets).toBe(1);
		expect((entries.at(-1) as { firstKeptEntryId: string }).firstKeptEntryId).toBe("s");
		for (const message of before) expect(after).toContainEqual(message);
		expect(after).toContainEqual(["developer", "policy"]);
	});
});

describe("finding 3: stray rewrite against the revision that was read", () => {
	it("a concurrent append after the read aborts the rewrite; the file keeps it and opening does not write", () => {
		const raw = [header(), ...chain(msg("s", "system", "snapshot"), msg("u", "user", "original"))];
		const original = raw.map((entry) => JSON.stringify(entry)).join("\n"); // torn: no final newline
		const file = write("race.jsonl", original);
		const concurrent = {
			type: "message",
			id: "x",
			parentId: "u",
			timestamp: "t",
			message: { role: "user", content: "concurrent append", timestamp: 3 },
		};
		hooks.inject = { target: file, run: () => realFs.appendFileSync(file, `\n${JSON.stringify(concurrent)}\n`) };
		const manager = SessionManager.open(file);
		const content = realFs.readFileSync(file, "utf8");
		expect(content).toBe(`${original}\n${JSON.stringify(concurrent)}\n`);
		expect(manager.getLoadWarnings()).toEqual([expect.stringContaining("changed while it was being migrated")]);
	});

	it("opening a torn current-version file writes nothing; the first append terminates the line", () => {
		const raw = [header(4), ...chain(msg("s", "system", "snapshot"), msg("u", "user", "original"))];
		const original = raw.map((entry) => JSON.stringify(entry)).join("\n");
		const file = write("torn.jsonl", original);
		const manager = SessionManager.open(file);
		expect(realFs.readFileSync(file, "utf8")).toBe(original);
		manager.appendMessage({ role: "user", content: "next", timestamp: 2 });
		const lines = realFs.readFileSync(file, "utf8").trimEnd().split("\n");
		expect(lines).toHaveLength(4);
		for (const text of lines) JSON.parse(text);
	});

	it("does not add a second newline when another writer already terminated the torn line", () => {
		const raw = [header(4), ...chain(msg("s", "system", "snapshot"), msg("u", "user", "original"))];
		const original = raw.map((entry) => JSON.stringify(entry)).join("\n");
		const file = write("torn2.jsonl", original);
		const manager = SessionManager.open(file);
		realFs.appendFileSync(file, "\n");
		manager.appendMessage({ role: "user", content: "next", timestamp: 2 });
		expect(realFs.readFileSync(file, "utf8")).not.toContain("\n\n");
	});
});

describe("finding 4: failed branched-file creation", () => {
	it("keeps the manager on the previous file; a later append never creates a headerless file; a retry works", () => {
		const manager = SessionManager.create(dir, dir);
		const id = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
		const oldFile = manager.getSessionFile()!;
		const oldEntries = manager.getEntries();
		hooks.failFsync = true;
		expect(() => manager.createBranchedSession(id)).toThrow("EIO");
		expect(manager.getSessionFile()).toBe(oldFile);
		expect(manager.getEntries()).toEqual(oldEntries);
		expect(realFs.readdirSync(dir)).toEqual([oldFile.slice(dir.length + 1)]);

		manager.appendMessage({ role: "user", content: "after failure", timestamp: 2 });
		for (const name of realFs.readdirSync(dir)) {
			const first = JSON.parse(realFs.readFileSync(join(dir, name), "utf8").split("\n")[0]!) as { type: string };
			expect(first.type).toBe("session");
		}
		expect(SessionManager.open(oldFile).getEntries()).toHaveLength(2);

		const branched = manager.createBranchedSession(id)!;
		expect(manager.getSessionFile()).toBe(branched);
		const reopened = SessionManager.open(branched);
		expect(reopened.getHeader()?.type).toBe("session");
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual([id]);
	});
});

describe("finding 5: rewrites keep the original permissions", () => {
	it("writeSessionFileAtomic replace keeps 0600 under a permissive umask", () => {
		process.umask(0o002);
		const file = join(dir, "private.jsonl");
		realFs.writeFileSync(file, line(header()), { mode: 0o600 });
		writeSessionFileAtomic(file, [header(4)], { mode: "replace" });
		expect(realFs.statSync(file).mode & 0o777).toBe(0o600);
	});

	it("a stray-file migration keeps 0640", () => {
		process.umask(0o002);
		const file = join(dir, "stray.jsonl");
		realFs.writeFileSync(
			file,
			[header(), ...chain(msg("s", "system", "p"), msg("u", "user", "u"))].map(line).join(""),
		);
		realFs.chmodSync(file, 0o640);
		SessionManager.open(file);
		expect(JSON.parse(realFs.readFileSync(file, "utf8").split("\n")[0]!).version).toBe(4);
		expect(realFs.statSync(file).mode & 0o777).toBe(0o640);
	});
});

describe("finding 6: unparseable lines are never dropped by a stray rewrite", () => {
	it.each([
		[
			"an interior malformed record",
			(valid: string[]) => `${valid[0]}\n{broken record: recover me}\n${valid.slice(1).join("\n")}\n`,
		],
		["a torn fragment at the end", (valid: string[]) => `${valid.join("\n")}\n{"type":"message","id":"half`],
	])("with %s the file stays byte-identical and the open warns", (_name, build) => {
		const valid = [
			header(),
			...chain(msg("d", "developer", "mask"), msg("s", "system", "p"), msg("u", "user", "u")),
		].map((entry) => JSON.stringify(entry));
		const content = build(valid);
		const file = write("malformed.jsonl", content);
		const manager = SessionManager.open(file);
		expect(realFs.readFileSync(file, "utf8")).toBe(content);
		expect(manager.getLoadWarnings()).toEqual([expect.stringContaining("unparseable line")]);
		// The in-memory view is still migrated.
		expect(manager.buildSessionContext().messages.map((message) => message.role)).toEqual([
			"system",
			"developer",
			"user",
		]);
	});
});

describe("finding 7: forkFrom never writes to its source", () => {
	it("a source without a final newline stays byte-identical, also when read-only", () => {
		const content = [header(4, dir), ...chain(msg("s", "system", "p"), msg("u", "user", "hello"))]
			.map((entry) => JSON.stringify(entry))
			.join("\n");
		const source = write("source.jsonl", content);
		realFs.chmodSync(source, 0o444);
		const forked = SessionManager.forkFrom(source, dir, join(dir, "fork"));
		expect(realFs.readFileSync(source, "utf8")).toBe(content);
		expect(forked.getEntries().map((entry) => entry.id)).toEqual(["s", "u"]);
	});
});

describe("finding 8: a stray rewrite keeps the file's mtime", () => {
	it("so recent-session selection does not change", () => {
		const store = join(dir, "store");
		realFs.mkdirSync(store);
		for (const [name, seconds] of [
			["a-resumed", 300],
			["z-later-created", 200],
		] as const) {
			const file = join(store, `${name}.jsonl`);
			realFs.writeFileSync(
				file,
				[header(), ...chain(msg("s", "system", "p"), msg("u", "user", name))].map(line).join(""),
			);
			realFs.utimesSync(file, seconds, seconds);
		}
		expect(findMostRecentSession(store)).toBe(join(store, "a-resumed.jsonl"));
		SessionManager.open(join(store, "z-later-created.jsonl"));
		const migrated = join(store, "z-later-created.jsonl");
		expect(JSON.parse(realFs.readFileSync(migrated, "utf8").split("\n")[0]!).version).toBe(4);
		expect(realFs.statSync(migrated).mtimeMs).toBe(200_000);
		expect(findMostRecentSession(store)).toBe(join(store, "a-resumed.jsonl"));
	});
});
