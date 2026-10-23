import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInitialSystemMessage, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Args } from "../../src/cli/args.ts";
import { type FileEntry, SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createSessionManager } from "../../src/main.ts";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-fork-migration-")));
	tempDirs.push(dir);
	return dir;
}

const message = (id: string, parentId: string | null, role: string, content: unknown, extra = {}) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-10-22T00:00:01.000Z",
	message: { role, content, timestamp: 1, ...extra },
});
const assistant = (id: string, parentId: string) =>
	message(id, parentId, "assistant", [{ type: "text", text: "ok" }], {
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
	});

/** v3 shapes of the real stores: collab mask first, or handoff content first. */
const SOURCES: Record<string, unknown[]> = {
	"developer-first": [
		message("d1", null, "developer", "mask"),
		message("S", "d1", "system", "prompt"),
		message("u1", "S", "user", "hi"),
		assistant("a1", "u1"),
	],
	"content-first": [
		{
			type: "custom_message",
			id: "h1",
			parentId: null,
			timestamp: "2026-10-22T00:00:01.000Z",
			customType: "handoff",
			content: "handoff",
			display: true,
		},
		message("S", "h1", "system", "prompt"),
		message("u1", "S", "user", "hi"),
		assistant("a1", "u1"),
	],
};

function writeSource(dir: string, shape: string): string {
	const file = join(dir, "source.jsonl");
	const header = { type: "session", version: 3, id: "src", timestamp: "2026-10-22T00:00:00.000Z", cwd: dir };
	writeFileSync(file, [header, ...SOURCES[shape]!].map((entry) => `${JSON.stringify(entry)}\n`).join(""));
	return file;
}

function readEntries(file: string): FileEntry[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as FileEntry);
}

function expectCanonicalFork(forked: SessionManager, source: string, sourceBefore: string): void {
	expect(readFileSync(source, "utf8")).toBe(sourceBefore);
	const file = forked.getSessionFile()!;
	const entries = readEntries(file);
	expect(entries[0]).toMatchObject({ type: "session", version: 4, parentSession: source });
	const messages = forked.buildSessionContext().messages as Message[];
	expect(messages[0]?.role).toBe("system");
	expect(getInitialSystemMessage(messages)).toBe(messages[0]);
	expect(forked.getLeafId()).toBe("a1");
	expect(readdirSync(join(file, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
}

describe("forkFrom migrates the copied source (§4.2, Astra M7)", () => {
	it.each(Object.keys(SOURCES))("SessionManager.forkFrom of a %s v3 source writes a canonical v4 file", (shape) => {
		const dir = tempDir();
		const source = writeSource(dir, shape);
		const sourceBefore = readFileSync(source, "utf8");
		const forked = SessionManager.forkFrom(source, dir, join(dir, "sessions"));
		expectCanonicalFork(forked, source, sourceBefore);
	});

	it.each(Object.keys(SOURCES))("CLI --fork of a %s v3 source writes a canonical v4 file", async (shape) => {
		const dir = tempDir();
		const source = writeSource(dir, shape);
		const sourceBefore = readFileSync(source, "utf8");
		const sessionDir = join(dir, "sessions");
		mkdirSync(sessionDir);
		const args: Args = { messages: [], fileArgs: [], unknownFlags: new Map(), diagnostics: [], fork: source };
		const forked = await createSessionManager(args, dir, sessionDir, SettingsManager.inMemory());
		expectCanonicalFork(forked, source, sourceBefore);
	});
});
