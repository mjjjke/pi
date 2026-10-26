import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

type Operation = "link" | "rename" | "unlink" | "fsync" | "lstat";
const hooks = vi.hoisted(() => ({
	run: undefined as undefined | ((operation: Operation, path: string, after: boolean) => void),
}));
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	const paths = new Map<number, string>();
	return {
		...actual,
		lstatSync: (path: string) => {
			hooks.run?.("lstat", path, false);
			return actual.lstatSync(path);
		},
		openSync: (path: string, flags: string, mode?: number) => {
			const fd = actual.openSync(path, flags, mode);
			paths.set(fd, path);
			return fd;
		},
		closeSync: (fd: number) => {
			paths.delete(fd);
			return actual.closeSync(fd);
		},
		fsyncSync: (fd: number) => {
			const path = paths.get(fd)!;
			hooks.run?.("fsync", path, false);
			actual.fsyncSync(fd);
			hooks.run?.("fsync", path, true);
		},
		linkSync: (from: string, to: string) => {
			hooks.run?.("link", to, false);
			actual.linkSync(from, to);
			hooks.run?.("link", to, true);
		},
		renameSync: (from: string, to: string) => {
			hooks.run?.("rename", to, false);
			actual.renameSync(from, to);
			hooks.run?.("rename", to, true);
		},
		unlinkSync: (path: string) => {
			hooks.run?.("unlink", path, false);
			actual.unlinkSync(path);
			hooks.run?.("unlink", path, true);
		},
	};
});

let root: string;
let a: string;
let b: string;
let c: string;
let manager: SessionManager;
const dirFor = (cwd: string) => join(root, "store", basename(cwd));
const fileAt = (cwd: string) => join(dirFor(cwd), basename(manager.getSessionFile()!));
const fail = (operation: Operation, path: string) => {
	hooks.run = (op, object, after) => {
		if (op === operation && object === path && !after) throw new Error(`injected ${op} ${object}`);
	};
};
const move = (to: string, notice: string | undefined = "cwd changed") => {
	const plan = manager.planCwdChange(to, dirFor);
	return manager.relocate(plan, manager.buildCwdChangeEntries(plan, { source: "user", notice }));
};
const marker = (old: string, to: string, id = manager.getSessionId()) => {
	fs.writeFileSync(`${old}.moved`, JSON.stringify({ v: 1, id, to }));
};

beforeEach(() => {
	root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "pi-cwd-change-")));
	vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
	[a, b, c] = ["a", "b", "c"].map((name) => join(root, name));
	for (const cwd of [a, b, c]) fs.mkdirSync(cwd);
	manager = SessionManager.create(a, dirFor(a));
	manager.appendMessage({ role: "system", content: "snapshot", timestamp: 1 });
	manager.appendMessage({ role: "user", content: "original question", timestamp: 2 });
	manager.appendCustomEntry("background", { path: "relative/old" });
});
afterEach(() => {
	hooks.run = undefined;
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

/** Check B without ever visiting A: discovery cannot depend on old-directory recovery. */
async function discovery(cwd: string, expected: string | undefined) {
	const id = manager.getSessionId();
	expect(SessionManager.findById(cwd, id, dirFor(cwd))).toBe(expected);
	expect((await SessionManager.list(cwd, dirFor(cwd))).map((info) => info.path)).toEqual(expected ? [expected] : []);
	expect((await SessionManager.listAll(dirFor(cwd))).map((info) => info.path)).toEqual(expected ? [expected] : []);
	const continued = SessionManager.continueRecent(cwd, dirFor(cwd));
	if (expected) {
		expect(continued.getSessionFile()).toBe(expected);
		expect(continued.getSessionId()).toBe(id);
		expect(continued.buildSessionContext().messages[1]).toMatchObject({ content: "original question" });
	} else {
		expect(continued.getSessionId()).not.toBe(id);
	}
}

describe("cwd persistence crash states", () => {
	it.each(["P", "1", "2", "3"] as const)("crash after %s: all discovery works from B alone, then A", async (stage) => {
		const old = manager.getSessionFile()!;
		const next = fileAt(b);
		if (stage === "P") fail("rename", `${old}.moved`);
		if (stage === "1") fail("link", next);
		if (stage === "2") fail("fsync", dirname(next));
		if (stage === "3") fail("unlink", `${old}.moved`);
		if (stage === "P" || stage === "1") {
			expect(() => move(b)).toThrow("injected");
			// A process killed after step 1 leaves its marker, unlike an exception's best-effort cleanup.
			if (stage === "1") marker(old, next);
		} else {
			expect(move(b)).toMatchObject({ committed: true, warning: expect.stringContaining("injected") });
		}
		expect(fs.existsSync(`${old}.artifacts`)).toBe(true);
		if (stage === "2" || stage === "3") {
			await discovery(b, next);
			await discovery(a, undefined);
		} else {
			await discovery(b, undefined);
			await discovery(a, old);
		}
		hooks.run = undefined;
		if (stage === "2" || stage === "3") {
			const reopened = SessionManager.open(next);
			expect(reopened.getLoadWarnings()).toEqual([]);
			expect(fs.existsSync(old)).toBe(false);
			expect(fs.existsSync(`${old}.moved`)).toBe(false);
		}
	});

	it("post-commit old-file unlink failure warns, hides O, and explicit open redirects one hop and cleans up", async () => {
		const old = manager.getSessionFile()!;
		const next = fileAt(b);
		fail("unlink", old);
		expect(move(b)).toMatchObject({ committed: true, warning: expect.stringContaining(old) });
		expect(manager.getCwd()).toBe(b);
		await discovery(b, next);
		await discovery(a, undefined);
		expect(SessionManager.open(next).getLoadWarnings().join()).toContain(old);
		hooks.run = undefined;
		const reopened = SessionManager.open(old);
		expect(reopened.getSessionFile()).toBe(next);
		expect(reopened.getCwd()).toBe(b);
		expect(fs.existsSync(old)).toBe(false);
		expect(fs.existsSync(`${old}.moved`)).toBe(false);
	});

	it("explicit open of an absent predecessor with an orphan marker resumes the live file, not an empty session", () => {
		const old = manager.getSessionFile()!;
		fail("unlink", `${old}.moved`);
		move(b);
		expect(fs.existsSync(old)).toBe(false);
		hooks.run = undefined;
		const reopened = SessionManager.open(old);
		expect(reopened.getSessionId()).toBe(manager.getSessionId());
		expect(reopened.getSessionFile()).toBe(manager.getSessionFile());
		expect(reopened.buildSessionContext().messages).toHaveLength(3);
		expect(fs.existsSync(old)).toBe(false);
	});

	it("explicit open follows only one marker even if a second valid marker is present", () => {
		const old = manager.getSessionFile()!;
		const next = fileAt(b);
		const third = fileAt(c);
		for (const file of [next, third]) {
			fs.mkdirSync(dirname(file), { recursive: true });
			fs.writeFileSync(file, `${JSON.stringify({ ...manager.getHeader(), cwd: file === next ? b : c })}\n`);
		}
		marker(old, next);
		marker(next, third);
		expect(SessionManager.open(old).getSessionFile()).toBe(next);
	});

	it("global listAll hides the old copy without cleaning it", async () => {
		manager = SessionManager.create(a);
		manager.appendMessage({ role: "user", content: "original question", timestamp: 2 });
		const old = manager.getSessionFile()!;
		const plan = manager.planCwdChange(b);
		fail("unlink", old);
		manager.relocate(plan, manager.buildCwdChangeEntries(plan, { source: "model", reason: "work there" }));
		expect((await SessionManager.listAll()).map((info) => info.path)).toEqual([manager.getSessionFile()]);
		expect(fs.existsSync(old)).toBe(true);
	});

	it("directory B fsync failure keeps O and M; simulated loss of N exposes O again", async () => {
		const old = manager.getSessionFile()!;
		const next = fileAt(b);
		fail("fsync", dirname(next));
		expect(move(b)).toMatchObject({ committed: true, warning: expect.stringContaining(dirname(next)) });
		expect(fs.existsSync(old)).toBe(true);
		expect(fs.existsSync(`${old}.moved`)).toBe(true);
		fs.unlinkSync(next);
		hooks.run = undefined;
		await discovery(b, undefined);
		await discovery(a, old);
	});

	it("failure before linkSync leaves memory, old bytes, and history untouched", () => {
		const old = manager.getSessionFile()!;
		const bytes = fs.readFileSync(old);
		const entries = manager.getEntries();
		fail("link", fileAt(b));
		expect(() => move(b)).toThrow("injected");
		expect(manager.getCwd()).toBe(a);
		expect(manager.getSessionFile()).toBe(old);
		expect(manager.getEntries()).toEqual(entries);
		expect(fs.readFileSync(old)).toEqual(bytes);
		expect(fs.existsSync(`${old}.moved`)).toBe(false);
	});

	it.each(["link", "rename"] as const)(
		"failure immediately after %s publication is committed, never rolled back",
		(operation) => {
			if (operation === "rename") manager = SessionManager.open(manager.getSessionFile()!, dirFor(a));
			const old = manager.getSessionFile()!;
			const resolver = operation === "rename" ? () => dirFor(a) : dirFor;
			const plan = manager.planCwdChange(b, resolver);
			hooks.run = (op, path, after) => {
				if (op === operation && path === plan.sessionFile && after) throw new Error(`after ${op} ${path}`);
			};
			const result = manager.relocate(plan, manager.buildCwdChangeEntries(plan, { source: "user" }));
			expect(result).toMatchObject({
				committed: true,
				warning: expect.stringContaining(`after ${operation}`),
			});
			expect(result.warning).not.toContain("ENOENT");
			expect(manager.getCwd()).toBe(b);
			expect(SessionManager.open(manager.getSessionFile()!).getHeader()?.cwd).toBe(b);
			if (operation === "link")
				expect(SessionManager.findById(a, manager.getSessionId(), dirFor(a))).toBeUndefined();
			else expect(manager.getSessionFile()).toBe(old);
		},
	);

	it("temp unlink failure after publication is a committed warning", () => {
		const next = fileAt(b);
		hooks.run = (op, path, after) => {
			if (op === "unlink" && basename(path).startsWith(`.${basename(next)}.`) && !after) {
				throw new Error(`temp unlink ${path}`);
			}
		};
		expect(move(b)).toMatchObject({ committed: true, warning: expect.stringContaining("temp unlink") });
		expect(manager.getCwd()).toBe(b);
	});

	it("concurrent writer during temp fsync aborts in beforePublish without losing the append", () => {
		const old = manager.getSessionFile()!;
		const next = fileAt(b);
		hooks.run = (op, path, after) => {
			if (op === "fsync" && dirname(path) === dirname(next) && path.endsWith(".tmp") && !after) {
				fs.appendFileSync(old, "concurrent bytes\n");
			}
		};
		expect(() => move(b)).toThrow(/changed.*relocat/);
		expect(manager.getCwd()).toBe(a);
		expect(fs.readFileSync(old, "utf8")).toContain("concurrent bytes\n");
		expect(fs.existsSync(next)).toBe(false);
	});
});

describe("fail-closed predecessor reconciliation", () => {
	for (const leftover of ["old-file", "marker"] as const) {
		for (const cleanupSucceeds of [true, false]) {
			it(`${leftover} unlink failed A→B, then B→${leftover === "marker" ? "A" : "C"}: cleanup ${cleanupSucceeds ? "succeeds" : "refuses"}`, async () => {
				const old = manager.getSessionFile()!;
				const blocker = leftover === "marker" ? `${old}.moved` : old;
				fail("unlink", blocker);
				expect(move(b).committed).toBe(true);
				const live = manager.getSessionFile()!;
				const before = fs.readFileSync(live);
				if (cleanupSucceeds) hooks.run = undefined;
				const target = leftover === "marker" ? a : c;
				if (cleanupSucceeds) {
					expect(move(target).committed).toBe(true);
					await discovery(target, manager.getSessionFile());
					await discovery(b, undefined);
					expect(fs.existsSync(`${old}.moved`)).toBe(false);
					if (target !== a) expect(fs.existsSync(old)).toBe(false);
				} else {
					expect(() => move(target)).toThrow(`unlink ${blocker}`);
					expect(manager.getCwd()).toBe(b);
					expect(fs.readFileSync(live)).toEqual(before);
					await discovery(b, live);
					await discovery(a, undefined);
					expect(fs.existsSync(`${live}.moved`)).toBe(false);
				}
			});
		}
	}

	it("reconcile fsync refusal identifies the directory and action", () => {
		const old = manager.getSessionFile()!;
		fail("unlink", old);
		move(b);
		fail("fsync", dirFor(b));
		expect(() => move(c)).toThrow(`fsync ${dirFor(b)}`);
		expect(manager.getCwd()).toBe(b);
		expect(fs.existsSync(old)).toBe(true);
	});

	it("an inaccessible predecessor marker refuses the next cd instead of treating it as absent", () => {
		const old = manager.getSessionFile()!;
		fail("unlink", old);
		move(b);
		const live = manager.getSessionFile()!;
		fail("lstat", `${old}.moved`);
		expect(() => move(c)).toThrow(`${old}.moved`);
		expect(manager.getSessionFile()).toBe(live);
		expect(fs.existsSync(old)).toBe(true);
		expect(fs.existsSync(`${old}.moved`)).toBe(true);
	});

	it("an inaccessible predecessor file refuses cleanup without removing its marker", () => {
		const old = manager.getSessionFile()!;
		fail("unlink", old);
		move(b);
		fail("lstat", old);
		expect(() => move(c)).toThrow(old);
		expect(manager.getCwd()).toBe(b);
		expect(fs.existsSync(`${old}.moved`)).toBe(true);
	});

	it("missing predecessor marker with a same-id old copy refuses rather than creating a second old copy", () => {
		const old = manager.getSessionFile()!;
		fail("unlink", old);
		move(b);
		hooks.run = undefined;
		fs.unlinkSync(`${old}.moved`);
		expect(() => move(c)).toThrow(/reconcile.*marker/);
		expect(manager.getCwd()).toBe(b);
	});

	it("stale destination marker is removed before publication", async () => {
		const next = fileAt(b);
		fs.mkdirSync(dirname(next), { recursive: true });
		marker(next, manager.getSessionFile()!);
		move(b);
		expect(fs.existsSync(`${next}.moved`)).toBe(false);
		await discovery(b, next);
	});

	it.each(["absent", "different-id", "malformed"])(
		"marker naming %s target never hides the old session",
		async (kind) => {
			const old = manager.getSessionFile()!;
			const next = fileAt(b);
			fs.mkdirSync(dirname(next), { recursive: true });
			if (kind === "different-id") {
				fs.writeFileSync(next, `${JSON.stringify({ ...manager.getHeader(), id: "different" })}\n`);
			}
			marker(old, next);
			if (kind === "malformed") fs.writeFileSync(`${old}.moved`, "not json");
			await discovery(a, old);
		},
	);

	it("outgoing marker naming an existing different-id file is inconsistent, never overwritten", () => {
		const old = manager.getSessionFile()!;
		const next = fileAt(b);
		fs.mkdirSync(dirname(next), { recursive: true });
		fs.writeFileSync(next, `${JSON.stringify({ ...manager.getHeader(), id: "different" })}\n`);
		marker(old, next);
		expect(() => move(c)).toThrow(/marker.*inconsisten/);
		expect(manager.getCwd()).toBe(a);
		expect(fs.existsSync(`${old}.moved`)).toBe(true);
	});

	it("refuses an outgoing valid marker and unrelated destination collision", () => {
		const old = manager.getSessionFile()!;
		const next = fileAt(b);
		fs.mkdirSync(dirname(next), { recursive: true });
		fs.copyFileSync(old, next);
		marker(old, next);
		expect(() => move(b)).toThrow(/marker.*inconsisten/);
		fs.unlinkSync(`${old}.moved`);
		expect(() => move(b)).toThrow(`session file already exists at ${next}`);
	});
});

describe("layouts, artifacts and history", () => {
	it("planning is read-only and resolves a relative destination sessionDir against B", () => {
		const resolver = (cwd: string) => (cwd === a ? dirFor(a) : "relative-sessions");
		const plan = manager.planCwdChange(b, resolver);
		expect(plan.sessionDir).toBe(join(b, "relative-sessions"));
		expect(plan.mode).toBe("move");
		expect(fs.existsSync(plan.sessionDir)).toBe(false);
		expect(fs.existsSync(`${manager.getSessionFile()}.artifacts`)).toBe(false);
	});

	it("absolute launch-relative session-dir stays pinned after ambient chdir", () => {
		const launchDir = resolve(a, "launch-sessions");
		manager = SessionManager.create(a, launchDir);
		manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		const old = manager.getSessionFile();
		const cwd = process.cwd();
		try {
			process.chdir(b);
			const plan = manager.planCwdChange(b, () => launchDir);
			expect(plan.mode).toBe("in-place");
			manager.relocate(plan, manager.buildCwdChangeEntries(plan, { source: "user" }));
			expect(manager.getSessionFile()).toBe(old);
		} finally {
			process.chdir(cwd);
		}
	});

	it("same custom directory rewrites in place (N === O), and filters by current header cwd", async () => {
		const old = manager.getSessionFile()!;
		const plan = manager.planCwdChange(b, () => dirFor(a));
		expect(plan.mode).toBe("in-place");
		manager.relocate(plan, manager.buildCwdChangeEntries(plan, { source: "user", notice: "applied" }));
		expect(manager.getSessionFile()).toBe(old);
		expect(await SessionManager.list(a, dirFor(a))).toEqual([]);
		expect((await SessionManager.list(b, dirFor(a)))[0]?.cwd).toBe(b);
		expect(SessionManager.continueRecent(b, dirFor(a)).getSessionId()).toBe(manager.getSessionId());
		expect(fs.existsSync(`${old}.moved`)).toBe(false);
	});

	it("explicit file outside managed tree is pinned, inside tree moves", () => {
		const outside = join(root, "explicit.jsonl");
		fs.copyFileSync(manager.getSessionFile()!, outside);
		const pinned = SessionManager.open(outside);
		const plan = pinned.planCwdChange(b, dirFor);
		expect(plan.mode).toBe("in-place");
		pinned.relocate(plan, pinned.buildCwdChangeEntries(plan, { source: "user" }));
		expect(pinned.getSessionFile()).toBe(outside);
		expect(manager.planCwdChange(b, dirFor).mode).toBe("move");
	});

	it.each([{ visits: ["b", "a"] }, { visits: ["b", "c", "a"] }])(
		"return visits $visits keep direct artifact aliases and no files in B/C",
		({ visits }) => {
			const old = manager.getSessionFile()!;
			const canonical = `${old}.artifacts`;
			fs.mkdirSync(canonical);
			fs.writeFileSync(join(canonical, "plan.md"), "Plan");
			const files = new Map([["a", old]]);
			for (const name of visits) {
				move(join(root, name));
				files.set(name, manager.getSessionFile()!);
			}
			for (const [name, file] of files) {
				expect(fs.realpathSync(`${file}.artifacts`)).toBe(canonical);
				if (name !== "a") {
					expect(fs.readlinkSync(`${file}.artifacts`)).toBe(canonical);
					expect(fs.existsSync(file)).toBe(false);
				}
				expect(fs.readFileSync(join(`${file}.artifacts`, "plan.md"), "utf8")).toBe("Plan");
			}
		},
	);

	it("existing correct alias is reused; conflicting and dangling aliases refuse before commit", () => {
		const old = manager.getSessionFile()!;
		const next = fileAt(b);
		const canonical = `${old}.artifacts`;
		fs.mkdirSync(canonical);
		fs.mkdirSync(dirname(next), { recursive: true });
		fs.symlinkSync(canonical, `${next}.artifacts`);
		move(b);
		expect(fs.realpathSync(`${next}.artifacts`)).toBe(canonical);
		const third = fileAt(c);
		fs.mkdirSync(dirname(third), { recursive: true });
		fs.symlinkSync(join(root, "missing"), `${third}.artifacts`);
		expect(() => move(c)).toThrow(`${third}.artifacts exists and is not this session's artifacts`);
		expect(manager.getCwd()).toBe(b);
	});

	it("unflushed session with Plan artifact moves only in memory; first flush writes at B", () => {
		manager = SessionManager.create(a, dirFor(a));
		manager.appendCustomEntry("plan", { artifactPath: "relative" });
		const old = manager.getSessionFile()!;
		fs.mkdirSync(`${old}.artifacts`);
		fs.writeFileSync(join(`${old}.artifacts`, "plan.md"), "unfinished");
		expect(manager.planCwdChange(b, dirFor).mode).toBe("memory");
		move(b, undefined);
		const next = manager.getSessionFile()!;
		expect(fs.existsSync(old)).toBe(false);
		expect(fs.existsSync(next)).toBe(false);
		expect(fs.realpathSync(`${next}.artifacts`)).toBe(`${old}.artifacts`);
		manager.appendMessage({ role: "user", content: "first prompt", timestamp: 1 });
		expect(SessionManager.open(next).getHeader()?.cwd).toBe(b);
		expect(SessionManager.open(next).getEntries()).toEqual(manager.getEntries());
	});

	it("memory preflight rejects a dangling destination session-file symlink before changing memory", () => {
		manager = SessionManager.create(a, dirFor(a));
		const next = fileAt(b);
		fs.mkdirSync(dirname(next), { recursive: true });
		fs.symlinkSync(join(root, "absent-session"), next);
		expect(() => move(b)).toThrow(`session file already exists at ${next}`);
		expect(manager.getCwd()).toBe(a);
	});

	it("no-session mode writes nothing, keeps no path and retains entries and identity", () => {
		manager = SessionManager.inMemory(a);
		const id = manager.getSessionId();
		const plan = manager.planCwdChange(b, dirFor);
		expect(plan.mode).toBe("memory");
		manager.relocate(plan, manager.buildCwdChangeEntries(plan, { source: "user" }));
		expect(manager.getSessionFile()).toBeUndefined();
		expect(manager.getSessionId()).toBe(id);
		expect(manager.getHeader()?.cwd).toBe(b);
		expect(fs.existsSync(dirFor(b))).toBe(false);
	});

	it("raw malformed interior lines and torn tail are preserved, full history resumes, mode and header fields survive", () => {
		const old = manager.getSessionFile()!;
		const original = fs.readFileSync(old, "utf8");
		const raw = `${original.slice(original.indexOf("\n") + 1)}{broken interior}\n{"torn":`;
		fs.writeFileSync(
			old,
			`${JSON.stringify({ ...manager.getHeader(), extra: "keep", parentSession: "/parent" })}\n${raw}`,
		);
		fs.chmodSync(old, 0o640);
		const before = manager.getEntries();
		move(b);
		const next = manager.getSessionFile()!;
		expect(fs.readFileSync(next, "utf8")).toContain(`${raw}\n`);
		expect(fs.statSync(next).mode & 0o777).toBe(0o640);
		const reopened = SessionManager.open(next);
		expect(reopened.getHeader()).toMatchObject({ cwd: b, extra: "keep", parentSession: "/parent" });
		expect(reopened.getEntries().slice(0, before.length)).toEqual(before);
		expect(reopened.buildSessionContext().messages).toHaveLength(3);
		const [state, notice] = reopened.getEntries().slice(-2);
		expect(state).toMatchObject({
			type: "custom",
			customType: "pi.cwd",
			data: { v: 1, from: a, to: b, previousSessionFile: old, source: "user" },
		});
		expect(notice).toMatchObject({
			type: "custom_message",
			customType: "pi.cwd",
			details: { kind: "applied", transitionId: state.id },
			parentId: state.id,
		});
	});

	it.skipIf(process.platform !== "linux")("ACL refusal happens before in-place publication", () => {
		const old = manager.getSessionFile()!;
		const before = fs.readFileSync(old);
		execFileSync("setfacl", ["-m", "u:65534:r", old]);
		const plan = manager.planCwdChange(b, () => dirFor(a));
		expect(() => manager.relocate(plan, manager.buildCwdChangeEntries(plan, { source: "user" }))).toThrow(/ACL/);
		expect(manager.getCwd()).toBe(a);
		expect(fs.readFileSync(old)).toEqual(before);
	});

	it("rejects a second cwd state so an unchecked latest entry cannot bypass predecessor reconciliation", () => {
		const plan = manager.planCwdChange(b, dirFor);
		const entries = manager.buildCwdChangeEntries(plan, { source: "user" });
		const second = { ...entries[0], id: "second-state", parentId: entries[0].id };
		expect(() => manager.relocate(plan, [...entries, second])).toThrow(/invalid cwd change entries/);
		expect(manager.getCwd()).toBe(a);
	});

	it("rejects an applied notice with a wrong transition receipt before publishing", () => {
		const plan = manager.planCwdChange(b, dirFor);
		const entries = manager.buildCwdChangeEntries(plan, { source: "model", notice: "applied" });
		const notice = entries[1];
		if (notice.type !== "custom_message") throw new Error("expected notice");
		notice.details = { kind: "applied", from: a, to: b, transitionId: "wrong-state" };
		expect(() => manager.relocate(plan, entries)).toThrow(/invalid cwd change notice/);
		expect(manager.getCwd()).toBe(a);
	});

	it("rejects missing/non-directory/same targets, stale plans and stale detached entries", () => {
		expect(() => manager.planCwdChange(a, dirFor)).toThrow(/already/);
		expect(() => manager.planCwdChange(join(root, "absent"), dirFor)).toThrow();
		expect(() => manager.planCwdChange(manager.getSessionFile()!, dirFor)).toThrow(/directory/);
		const plan = manager.planCwdChange(b, dirFor);
		const entries = manager.buildCwdChangeEntries(plan, { source: "user" });
		manager.appendCustomEntry("new", {});
		expect(() => manager.relocate(plan, entries)).toThrow(/stale/);
		move(b);
		expect(() => manager.relocate(plan, manager.buildCwdChangeEntries(plan, { source: "user" }))).toThrow(/stale/);
	});
});
