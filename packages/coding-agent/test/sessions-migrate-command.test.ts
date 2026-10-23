import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	ENV_SESSIONS_MIGRATE_PROC_ROOT,
	type LiveProcess,
	listLivePiProcesses,
	runSessionsCommand,
} from "../src/cli/sessions-migrate.ts";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.ts";
import { findMostRecentSession } from "../src/core/session-manager.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			chmodSync(dir, 0o755);
		} catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});
function tempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-sessions-migrate-")));
	tempDirs.push(dir);
	return dir;
}

const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const header = (version: number) => ({
	type: "session",
	version,
	id: `id-${Math.random()}`,
	timestamp: "2026-10-22T00:00:00.000Z",
	cwd: "/tmp",
});
const msg = (id: string, parentId: string | null, role: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-10-22T00:00:01.000Z",
	message: { role, content: role, timestamp: 1 },
});
/** developer-first v3 file (needs a permutation). */
function writeV3(file: string): string {
	mkdirSync(resolve(file, ".."), { recursive: true });
	writeFileSync(
		file,
		[header(3), msg("d", null, "developer"), msg("s", "d", "system"), msg("u", "s", "user")].map(line).join(""),
	);
	return file;
}
/** v3 file with an assistant before the system (skipped with a warning, still bumped). */
function writeSkipped(file: string): string {
	mkdirSync(resolve(file, ".."), { recursive: true });
	const assistant = { ...msg("a", "u0", "assistant"), message: { role: "assistant", content: [], timestamp: 1 } };
	writeFileSync(
		file,
		[header(3), msg("u0", null, "user"), assistant, msg("s", "a", "system"), msg("u", "s", "user")]
			.map(line)
			.join(""),
	);
	return file;
}
function writeV4(file: string): string {
	mkdirSync(resolve(file, ".."), { recursive: true });
	writeFileSync(file, [header(4), msg("s", null, "system"), msg("u", "s", "user")].map(line).join(""));
	return file;
}
const versionOf = (file: string) =>
	(JSON.parse(readFileSync(file, "utf8").split("\n")[0]!) as { version: number }).version;

async function run(
	args: string[],
	options: { agentDir: string; live?: LiveProcess[]; setting?: string; env?: string },
) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runSessionsCommand(args, {
		agentDir: options.agentDir,
		settingSessionDir: options.setting,
		envSessionDir: options.env,
		listProcesses: () => options.live ?? [],
		out: (text) => out.push(text),
		err: (text) => err.push(text),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

const LIVE_PI: LiveProcess[] = [{ pid: 4242, name: "pi" }];

describe("pi sessions migrate (§4.3)", () => {
	it("dry-run writes nothing and reports the same counts as the real run; a second run reports migrated 0", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const a = writeV3(join(agentDir, "sessions", "--p--", "a.jsonl"));
		const b = writeSkipped(join(agentDir, "sessions", "--p--", "b.jsonl"));
		writeV4(join(agentDir, "sessions", "--p--", "c.jsonl"));
		const before = readFileSync(a, "utf8");

		const dry = await run(["migrate", "--dry-run"], { agentDir });
		expect(dry.code).toBe(0);
		expect(readFileSync(a, "utf8")).toBe(before);
		expect(dry.out).toContain("Scanned: 3");
		expect(dry.out).toContain("Current: 1");
		expect(dry.out).toContain(
			"Would migrate: 2 (prefixes permuted: 1, firstKeptEntryId remapped: 0, checkpoints backfilled: 0, header-only bumps: 1)",
		);
		expect(dry.out).toContain(`not-startup-prefix: ${b}`);

		const real = await run(["migrate"], { agentDir });
		expect(real.code).toBe(0);
		expect(real.out).toContain(
			"Migrated: 2 (prefixes permuted: 1, firstKeptEntryId remapped: 0, checkpoints backfilled: 0, header-only bumps: 1)",
		);
		expect(real.out).toContain("Skipped with warning: 1");
		expect(versionOf(a)).toBe(4);
		expect(versionOf(b)).toBe(4);
		const order = readFileSync(a, "utf8")
			.trim()
			.split("\n")
			.slice(1)
			.map((text) => (JSON.parse(text) as { id: string }).id);
		expect(order).toEqual(["s", "d", "u"]);

		const second = await run(["migrate"], { agentDir });
		expect(second.out).toContain("Migrated: 0");
		expect(second.out).toContain("Current: 3");
	});

	it("reports invalid files untouched and failed files with exit 1", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const invalid = join(agentDir, "sessions", "x.jsonl");
		mkdirSync(join(agentDir, "sessions"), { recursive: true });
		writeFileSync(invalid, line({ type: "message", id: "m" }));
		const locked = writeV3(join(agentDir, "sessions", "locked", "a.jsonl"));
		const before = readFileSync(locked, "utf8");
		chmodSync(join(agentDir, "sessions", "locked"), 0o555);
		try {
			const result = await run(["migrate"], { agentDir });
			expect(result.code).toBe(1);
			expect(result.out).toContain(`Invalid: 1\n  ${invalid}`);
			expect(result.out).toContain(`Failed: 1\n  ${locked}:`);
			expect(readFileSync(locked, "utf8")).toBe(before);
			expect(readFileSync(invalid, "utf8")).toBe(line({ type: "message", id: "m" }));
		} finally {
			chmodSync(join(agentDir, "sessions", "locked"), 0o755);
		}
	});

	it("counts symlinked duplicates once", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const file = writeV3(join(root, "store", "a.jsonl"));
		mkdirSync(join(agentDir, "sessions"), { recursive: true });
		symlinkSync(file, join(agentDir, "sessions", "link.jsonl"));
		symlinkSync(join(root, "store"), join(root, "store-link"));
		const result = await run(["migrate", "--dir", join(root, "store"), "--dir", join(root, "store-link")], {
			agentDir,
		});
		expect(result.out).toContain("Scanned: 1");
		expect(result.out).toContain("Migrated: 1");
		expect(versionOf(file)).toBe(4);
		expect(statSync(join(agentDir, "sessions", "link.jsonl")).isFile()).toBe(true);
	});

	it.each([
		["inside the agent dir", (root: string) => ({ file: join(root, "agent", "sessions", "a.jsonl") })],
		[
			"inside a sessionDir setting root",
			(root: string) => ({ file: join(root, "custom", "a.jsonl"), setting: join(root, "custom") }),
		],
		[
			"inside a PI_CODING_AGENT_SESSION_DIR root",
			(root: string) => ({ file: join(root, "env", "a.jsonl"), env: join(root, "env") }),
		],
	])("with a live pi and a v3 file %s it exits 2 without writing", async (_name, layout) => {
		const root = tempDir();
		const { file, setting, env } = layout(root) as { file: string; setting?: string; env?: string };
		writeV3(file);
		const before = readFileSync(file, "utf8");
		const result = await run(["migrate"], { agentDir: join(root, "agent"), live: LIVE_PI, setting, env });
		expect(result.code).toBe(2);
		expect(result.err).toContain("4242 (pi)");
		expect(result.out).toContain("Protected targets: 1");
		expect(readFileSync(file, "utf8")).toBe(before);

		const dry = await run(["migrate", "--dry-run"], { agentDir: join(root, "agent"), live: LIVE_PI, setting, env });
		expect(dry.code).toBe(0);
		expect(dry.err).toContain("Warning: running");
		expect(dry.out).toContain("Protected targets: 1");
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it.each([
		["absent", (_agentDir: string) => {}],
		["empty", (agentDir: string) => mkdirSync(join(agentDir, "sessions"), { recursive: true })],
		["holding only v4 files", (agentDir: string) => writeV4(join(agentDir, "sessions", "v4.jsonl"))],
	])(
		"with only --dir targets outside (default root %s) and a live pi it warns and proceeds",
		async (_name, prepare) => {
			const root = tempDir();
			const agentDir = join(root, "agent");
			prepare(agentDir);
			const file = writeV3(join(root, "copies", "a.jsonl"));
			const result = await run(["migrate", "--dir", join(root, "copies")], { agentDir, live: LIVE_PI });
			expect(result.code).toBe(0);
			expect(result.err).toContain("Warning: running pi processes: 4242 (pi)");
			expect(result.out).toContain("Protected targets: 0");
			expect(versionOf(file)).toBe(4);
		},
	);

	it("rejects unknown arguments with usage", async () => {
		const root = tempDir();
		expect((await run(["migrate", "--force"], { agentDir: root })).code).toBe(1);
		expect((await run([], { agentDir: root })).code).toBe(1);
	});
});

describe("pi sessions migrate data safety (review A)", () => {
	it("finding 2: a default store symlinked outside the agent dir stays protected", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		const file = writeV3(join(root, "external-store", "--p--", "a.jsonl"));
		symlinkSync(join(root, "external-store"), join(agentDir, "sessions"));
		const before = readFileSync(file, "utf8");
		const result = await run(["migrate"], { agentDir, live: LIVE_PI });
		expect(result.code).toBe(2);
		expect(result.out).toContain("Protected targets: 1");
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("finding 2: nested directory and file symlinks inside a protected store stay protected, also when listed by --dir", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const nested = writeV3(join(root, "elsewhere", "dir", "a.jsonl"));
		const single = writeV3(join(root, "elsewhere", "file", "b.jsonl"));
		mkdirSync(join(agentDir, "sessions"), { recursive: true });
		symlinkSync(join(root, "elsewhere", "dir"), join(agentDir, "sessions", "--p--"));
		symlinkSync(single, join(agentDir, "sessions", "b.jsonl"));
		const result = await run(["migrate", "--dir", join(root, "elsewhere")], { agentDir, live: LIVE_PI });
		expect(result.code).toBe(2);
		expect(result.out).toContain("Protected targets: 2");
		expect(versionOf(nested)).toBe(3);
		expect(versionOf(single)).toBe(3);
	});

	it("finding 5: a migrated file keeps its permissions under a permissive umask", async () => {
		const root = tempDir();
		const file = writeV3(join(root, "copies", "a.jsonl"));
		chmodSync(file, 0o600);
		const saved = process.umask(0o002);
		try {
			expect((await run(["migrate", "--dir", join(root, "copies")], { agentDir: join(root, "agent") })).code).toBe(
				0,
			);
		} finally {
			process.umask(saved);
		}
		expect(versionOf(file)).toBe(4);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	it.each([
		[
			"an interior malformed record",
			(lines: string[]) => `${lines[0]}\n{broken record: recover me}\n${lines.slice(1).join("\n")}\n`,
		],
		["a torn fragment at the end", (lines: string[]) => `${lines.join("\n")}\n{"type":"message","id":"half`],
	])("finding 6: a file with %s is refused, reported and left byte-identical", async (_name, build) => {
		const root = tempDir();
		mkdirSync(join(root, "copies"));
		const file = join(root, "copies", "a.jsonl");
		const lines = [header(3), msg("d", null, "developer"), msg("s", "d", "system")].map((entry) =>
			JSON.stringify(entry),
		);
		const content = build(lines);
		writeFileSync(file, content);
		const dry = await run(["migrate", "--dry-run", "--dir", join(root, "copies")], { agentDir: join(root, "agent") });
		expect(dry.out).toContain(`Refused (unparseable lines, left untouched): 1\n  ${file}: line`);
		const result = await run(["migrate", "--dir", join(root, "copies")], { agentDir: join(root, "agent") });
		expect(result.code).toBe(1);
		expect(result.out).toContain("Migrated: 0");
		expect(result.out).toContain(`Refused (unparseable lines, left untouched): 1\n  ${file}: line`);
		expect(readFileSync(file, "utf8")).toBe(content);
	});

	it("finding 8: migration keeps mtimes, so the session pi -c resumes does not change", async () => {
		const root = tempDir();
		const store = join(root, "copies");
		for (const [name, seconds] of [
			["a-resumed", 300],
			["z-later-created", 200],
		] as const) {
			utimesSync(writeV3(join(store, `${name}.jsonl`)), seconds, seconds);
		}
		const before = findMostRecentSession(store);
		expect(before).toBe(join(store, "a-resumed.jsonl"));
		expect((await run(["migrate", "--dir", store], { agentDir: join(root, "agent") })).code).toBe(0);
		expect(versionOf(join(store, "z-later-created.jsonl"))).toBe(4);
		expect(statSync(join(store, "z-later-created.jsonl")).mtimeMs).toBe(200_000);
		expect(findMostRecentSession(store)).toBe(before);
	});
	it("recheck N2: mtimes that differ within 1 ms keep their order, so pi -c resumes the same session", async () => {
		const root = tempDir();
		const store = join(root, "copies");
		for (const [name, seconds] of [
			["a-older", 200.0001],
			["z-newer", 200.0004],
		] as const) {
			utimesSync(writeV3(join(store, `${name}.jsonl`)), seconds, seconds);
		}
		const before = findMostRecentSession(store);
		expect(before).toBe(join(store, "z-newer.jsonl"));
		expect((await run(["migrate", "--dir", store], { agentDir: join(root, "agent") })).code).toBe(0);
		expect(versionOf(join(store, "a-older.jsonl"))).toBe(4);
		expect(findMostRecentSession(store)).toBe(before);
	});

	it.skipIf(process.platform !== "linux" || spawnSync("setfacl", ["--version"]).status !== 0)(
		"recheck N1: a store with a default ACL is reported failed and left untouched",
		async () => {
			const root = tempDir();
			const store = join(root, "copies");
			const file = writeV3(join(store, "a.jsonl"));
			chmodSync(file, 0o640);
			const acl = spawnSync("setfacl", ["-d", "-m", "u:65534:r", store]);
			if (acl.status !== 0) return; // filesystem without ACL support
			const content = readFileSync(file, "utf8");
			const result = await run(["migrate", "--dir", store], { agentDir: join(root, "agent") });
			expect(result.code).toBe(1);
			expect(result.out).toContain(`Failed: 1\n  ${file}: refusing to rewrite`);
			expect(readFileSync(file, "utf8")).toBe(content);
		},
	);

	it.skipIf(process.platform !== "linux")(
		"recheck R2: without getfacl the file is reported failed and left untouched",
		async () => {
			const root = tempDir();
			const store = join(root, "copies");
			const file = writeV3(join(store, "a.jsonl"));
			const content = readFileSync(file, "utf8");
			const emptyBin = tempDir();
			const path = process.env.PATH;
			process.env.PATH = emptyBin;
			let result: Awaited<ReturnType<typeof run>>;
			try {
				result = await run(["migrate", "--dir", store], { agentDir: join(root, "agent") });
			} finally {
				process.env.PATH = path;
			}
			expect(result.code).toBe(1);
			expect(result.out).toContain(`Failed: 1\n  ${file}: cannot check ACLs`);
			expect(result.out).toContain("getfacl");
			expect(readFileSync(file, "utf8")).toBe(content);
		},
	);
});

describe("live pi process probe", () => {
	it("recognizes comm pi/pi-rpc with a node or bun exe and ignores itself and other programs", () => {
		const proc = tempDir();
		const add = (pid: number, comm: string, exe: string) => {
			mkdirSync(join(proc, String(pid)));
			writeFileSync(join(proc, String(pid), "comm"), `${comm}\n`);
			symlinkSync(exe, join(proc, String(pid), "exe"));
		};
		add(process.pid, "pi", process.execPath);
		add(1001, "pi", "/home/u/.local/share/mise/installs/node/24.1.0/bin/node");
		add(1002, "pi-rpc", "/usr/local/bin/bun");
		add(1003, "pi", "/usr/bin/python3");
		add(1004, "zsh", "/usr/bin/zsh");
		mkdirSync(join(proc, "self"));
		expect(listLivePiProcesses(proc)).toEqual([
			{ pid: 1001, name: "pi" },
			{ pid: 1002, name: "pi-rpc" },
		]);
	});
});

describe("pi sessions migrate through the real CLI entry (recheck N8)", () => {
	async function runCli(args: string[], env: Record<string, string>) {
		const childEnv: Record<string, string | undefined> = { ...process.env, PI_OFFLINE: "1", ...env };
		if (!(ENV_SESSION_DIR in env)) delete childEnv[ENV_SESSION_DIR];
		return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
			const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
				cwd: env.CWD ?? tmpdir(),
				env: childEnv,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("error", reject);
			child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
		});
	}
	function fakeProc(root: string, live: boolean): string {
		const proc = join(root, "proc");
		mkdirSync(proc);
		if (live) {
			mkdirSync(join(proc, "777"));
			writeFileSync(join(proc, "777", "comm"), "pi\n");
			symlinkSync(process.execPath, join(proc, "777", "exe"));
		}
		return proc;
	}

	it("the report lists the default, setting, env and --dir roots with their source", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: join(root, "setting-root") }));
		const result = await runCli(["sessions", "migrate", "--dry-run", "--dir", join(root, "extra")], {
			[ENV_AGENT_DIR]: agentDir,
			[ENV_SESSION_DIR]: join(root, "env-root"),
			[ENV_SESSIONS_MIGRATE_PROC_ROOT]: fakeProc(root, false),
			CWD: root,
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toContain(`default ${join(agentDir, "sessions")} (absent)`);
		expect(result.stdout).toContain(`setting ${join(root, "setting-root")} (absent)`);
		expect(result.stdout).toContain(`env     ${join(root, "env-root")} (absent)`);
		expect(result.stdout).toContain(`--dir   ${join(root, "extra")} (absent)`);
	}, 60_000);

	it("S5 shape: empty default root + external --dir + injected live pi proceeds", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		mkdirSync(join(agentDir, "sessions"), { recursive: true });
		const file = writeV3(join(root, "copies", "a.jsonl"));
		const result = await runCli(["sessions", "migrate", "--dir", join(root, "copies")], {
			[ENV_AGENT_DIR]: agentDir,
			[ENV_SESSIONS_MIGRATE_PROC_ROOT]: fakeProc(root, true),
			CWD: root,
		});
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("777 (pi)");
		expect(result.stdout).toContain("Protected targets: 0");
		expect(result.stdout).toContain("Migrated: 1");
		expect(versionOf(file)).toBe(4);
	}, 60_000);

	it("refuses with exit 2 when a live pi exists and a v3 file is in the default root", async () => {
		const root = tempDir();
		const agentDir = join(root, "agent");
		const file = writeV3(join(agentDir, "sessions", "a.jsonl"));
		const result = await runCli(["sessions", "migrate"], {
			[ENV_AGENT_DIR]: agentDir,
			[ENV_SESSIONS_MIGRATE_PROC_ROOT]: fakeProc(root, true),
			CWD: root,
		});
		expect(result.code).toBe(2);
		expect(versionOf(file)).toBe(3);
	}, 60_000);
});
