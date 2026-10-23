/**
 * `pi sessions migrate [--dry-run] [--dir <path>]...`: migrate every stored session file to the current
 * format once, while no pi process runs (design §4.3). Files are rewritten atomically; the original is
 * left untouched on any error.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { APP_NAME } from "../config.ts";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	migrateSessionEntries,
	type SessionHeader,
	type SessionMigrationSkipReason,
	writeSessionFileAtomic,
} from "../core/session-manager.ts";

export const SESSIONS_MIGRATE_USAGE = `Usage: ${APP_NAME} sessions migrate [--dry-run] [--dir <path>]...`;

/**
 * Test hook: read process information from this directory instead of `/proc`. Undocumented; lets the real
 * CLI entry be tested with an injected live pi process without depending on the machine's processes.
 */
export const ENV_SESSIONS_MIGRATE_PROC_ROOT = "PI_SESSIONS_MIGRATE_PROC_ROOT";

export type SessionRootSource = "default" | "setting" | "env" | "--dir";

export interface SessionRoot {
	path: string;
	source: SessionRootSource;
}

export interface LiveProcess {
	pid: number;
	name: string;
}

export interface SessionsMigrateOptions {
	agentDir: string;
	/** `sessionDir` setting, when set. */
	settingSessionDir?: string;
	/** `PI_CODING_AGENT_SESSION_DIR`, when set. */
	envSessionDir?: string;
	/** Live pi processes other than this one. Defaults to {@link listLivePiProcesses}. */
	listProcesses?: () => LiveProcess[];
	out?: (line: string) => void;
	err?: (line: string) => void;
}

const PI_PROCESS_NAMES = new Set([APP_NAME, `${APP_NAME}-rpc`]);

function isRuntimeBinary(path: string): boolean {
	const name = basename(path).toLowerCase();
	return /^(node|bun)(\d[\w.-]*)?(\.exe)?$/.test(name);
}

/**
 * List live pi processes other than this one. Linux: `/proc/<pid>/comm` is `pi` or `pi-rpc` (set through
 * `process.title`) and `/proc/<pid>/exe` is a node or bun binary (an unreadable `exe` counts, to stay on the
 * safe side). Elsewhere: `ps -A -o pid=,comm=` with the same names. Not exhaustive: an SDK host still named
 * `node` or a renamed binary is not detected.
 */
export function listLivePiProcesses(
	procRoot: string | undefined = process.env[ENV_SESSIONS_MIGRATE_PROC_ROOT],
): LiveProcess[] {
	const root = procRoot ?? (process.platform === "linux" ? "/proc" : undefined);
	const result: LiveProcess[] = [];
	if (root && existsSync(root)) {
		for (const name of readdirSync(root)) {
			if (!/^\d+$/.test(name)) continue;
			const pid = Number(name);
			if (pid === process.pid) continue;
			let comm: string;
			try {
				comm = readFileSync(join(root, name, "comm"), "utf8").trim();
			} catch {
				continue;
			}
			if (!PI_PROCESS_NAMES.has(comm)) continue;
			let exe: string | undefined;
			try {
				exe = readlinkSync(join(root, name, "exe"));
			} catch {
				exe = undefined;
			}
			if (exe !== undefined && !isRuntimeBinary(exe)) continue;
			result.push({ pid, name: comm });
		}
		return result.sort((a, b) => a.pid - b.pid);
	}
	const ps = spawnSync("ps", ["-A", "-o", "pid=,comm="], { encoding: "utf8" });
	for (const line of (ps.stdout ?? "").split("\n")) {
		const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		const comm = basename(match[2]!);
		if (pid !== process.pid && PI_PROCESS_NAMES.has(comm)) result.push({ pid, name: comm });
	}
	return result.sort((a, b) => a.pid - b.pid);
}

interface ParsedArgs {
	dryRun: boolean;
	dirs: string[];
}

function parseMigrateArgs(args: string[]): ParsedArgs | string {
	const parsed: ParsedArgs = { dryRun: false, dirs: [] };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--dry-run") parsed.dryRun = true;
		else if (arg === "--dir") {
			const value = args[++i];
			if (!value) return "--dir requires a path";
			parsed.dirs.push(value);
		} else if (arg.startsWith("--dir=")) {
			const value = arg.slice("--dir=".length);
			if (!value) return "--dir requires a path";
			parsed.dirs.push(value);
		} else return `Unknown argument: ${arg}`;
	}
	return parsed;
}

function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Every `*.jsonl` below root (following directory symlinks once), as real paths. */
function walkSessionFiles(root: string, files: Set<string>, visitedDirs: Set<string>): void {
	let realDir: string;
	try {
		realDir = realpathSync(root);
	} catch {
		return;
	}
	if (visitedDirs.has(realDir)) return;
	visitedDirs.add(realDir);
	for (const name of readdirSync(realDir)) {
		const path = join(realDir, name);
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(path);
		} catch {
			continue;
		}
		if (stats.isDirectory()) walkSessionFiles(path, files, visitedDirs);
		else if (stats.isFile() && name.endsWith(".jsonl")) files.add(realpathOrResolve(path));
	}
}

function readEntries(file: string): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as FileEntry);
		} catch {
			// Malformed lines are skipped, as the loader does.
		}
	}
	return entries;
}

function validHeader(entries: FileEntry[]): SessionHeader | undefined {
	const first = entries[0];
	return first?.type === "session" && typeof (first as { id?: unknown }).id === "string" ? first : undefined;
}

/** Run `pi sessions <args>`; returns the exit code (0 ok, 1 usage error or failed files, 2 refused). */
export async function runSessionsCommand(args: string[], options: SessionsMigrateOptions): Promise<number> {
	const out = options.out ?? ((line: string) => console.log(line));
	const err = options.err ?? ((line: string) => console.error(line));
	if (args[0] !== "migrate") {
		err(args[0] ? `Unknown sessions command: ${args[0]}` : "Missing sessions command");
		err(SESSIONS_MIGRATE_USAGE);
		return 1;
	}
	const parsed = parseMigrateArgs(args.slice(1));
	if (typeof parsed === "string") {
		err(parsed);
		err(SESSIONS_MIGRATE_USAGE);
		return 1;
	}

	const agentDir = realpathOrResolve(options.agentDir);
	const roots: SessionRoot[] = [{ path: join(options.agentDir, "sessions"), source: "default" }];
	if (options.settingSessionDir) roots.push({ path: options.settingSessionDir, source: "setting" });
	if (options.envSessionDir) roots.push({ path: options.envSessionDir, source: "env" });
	for (const dir of parsed.dirs) roots.push({ path: resolve(dir), source: "--dir" });
	// Where a running pi may write: the agent dir and configured roots (never plain --dir roots).
	const protectedRoots = [
		agentDir,
		...roots
			.filter((root) => root.source === "setting" || root.source === "env")
			.map((root) => realpathOrResolve(root.path)),
	];

	const files = new Set<string>();
	const visitedDirs = new Set<string>();
	for (const root of roots) {
		if (existsSync(root.path)) walkSessionFiles(root.path, files, visitedDirs);
	}

	const targets: Array<{ file: string; entries: FileEntry[] }> = [];
	const invalid: string[] = [];
	const failed: Array<{ file: string; error: string }> = [];
	let current = 0;
	for (const file of [...files].sort()) {
		let entries: FileEntry[];
		try {
			entries = readEntries(file);
		} catch (error) {
			failed.push({ file, error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		const header = validHeader(entries);
		if (!header) invalid.push(file);
		else if ((header.version ?? 1) >= CURRENT_SESSION_VERSION) current++;
		else targets.push({ file, entries });
	}
	const protectedCount = targets.filter((target) => protectedRoots.some((root) => isInside(target.file, root))).length;

	out(`Session roots:`);
	for (const root of roots) {
		out(`  ${root.source.padEnd(7)} ${root.path}${existsSync(root.path) ? "" : " (absent)"}`);
	}

	const live = (options.listProcesses ?? (() => listLivePiProcesses()))();
	if (live.length > 0) {
		const pids = live.map((proc) => `${proc.pid} (${proc.name})`).join(", ");
		if (protectedCount > 0 && !parsed.dryRun) {
			err(`Refusing to migrate: running ${APP_NAME} processes: ${pids}.`);
			err(
				`${protectedCount} file(s) to migrate are in stores a running ${APP_NAME} may write. Quit every ${APP_NAME} and run again.`,
			);
			out(`Protected targets: ${protectedCount}`);
			return 2;
		}
		err(`Warning: running ${APP_NAME} processes: ${pids}.`);
	}
	out(`Protected targets: ${protectedCount}`);

	let migrated = 0;
	let permuted = 0;
	let remapped = 0;
	let backfilled = 0;
	let headerOnly = 0;
	const skipped: Array<{ file: string; reason: SessionMigrationSkipReason; systemEntryId: string }> = [];
	for (const target of targets) {
		try {
			const report = migrateSessionEntries(target.entries);
			if (!parsed.dryRun) writeSessionFileAtomic(target.file, target.entries, { mode: "replace" });
			migrated++;
			permuted += report.permutedBlocks;
			remapped += report.remappedTargets;
			backfilled += report.backfilledCheckpoints;
			if (report.permutedBlocks === 0 && report.remappedTargets === 0 && report.backfilledCheckpoints === 0) {
				headerOnly++;
			}
			for (const skip of report.skipped) skipped.push({ file: target.file, ...skip });
		} catch (error) {
			failed.push({ file: target.file, error: error instanceof Error ? error.message : String(error) });
		}
	}

	out(`Scanned: ${files.size}`);
	out(`Current: ${current}`);
	out(
		`${parsed.dryRun ? "Would migrate" : "Migrated"}: ${migrated} (prefixes permuted: ${permuted}, firstKeptEntryId remapped: ${remapped}, checkpoints backfilled: ${backfilled}, header-only bumps: ${headerOnly})`,
	);
	out(`Skipped with warning: ${skipped.length}`);
	for (const skip of skipped) out(`  ${skip.reason}: ${skip.file} (system ${skip.systemEntryId})`);
	out(`Invalid: ${invalid.length}`);
	for (const file of invalid) out(`  ${file}`);
	out(`Failed: ${failed.length}`);
	for (const failure of failed) out(`  ${failure.file}: ${failure.error}`);
	return failed.length > 0 ? 1 : 0;
}
