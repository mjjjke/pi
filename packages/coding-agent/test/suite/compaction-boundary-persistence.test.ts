import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { COMPACTION_BOUNDARY_TEXT_V2 } from "../../src/core/messages.ts";
import { type CompactionEntry, SessionManager, type SessionManager as SM } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

/** A6: the stored boundary literal survives reload, resume, fork and /tree, projected exactly once. */

function boundaryCount(manager: SM): number {
	return manager.buildSessionProjection().messages.filter((message) => message.role === "compactionBoundary").length;
}

describe("compaction boundary persistence (A6)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function compactedSession(): Promise<{ harness: Harness; dir: string; beforeCompaction: string }> {
		const dir = mkdtempSync(join(tmpdir(), "boundary-a6-"));
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		const harness = await createHarness({
			sessionManager,
			settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 10 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "SUMMARY",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		cleanups.push(() => {
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		});
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage("OLD-ANSWER"),
			fauxAssistantMessage("KEPT-ANSWER"),
			fauxAssistantMessage("NEW-ANSWER"),
		]);
		await harness.session.prompt(`OLD ${"o".repeat(400)}`);
		await harness.session.prompt(`KEPT ${"k".repeat(100)}`);
		const beforeCompaction = sessionManager.getLeafId() as string;
		await harness.session.compact();
		await harness.session.prompt("NEW-PROMPT");
		return { harness, dir, beforeCompaction };
	}

	it("the journal holds the literal once, inside the compaction line", async () => {
		const { harness } = await compactedSession();
		const file = harness.sessionManager.getSessionFile() as string;
		const lines = readFileSync(file, "utf8").trim().split("\n");
		const withText = lines.filter((line) => line.includes("Compaction boundary (not a request)"));
		expect(withText).toHaveLength(1);
		expect(JSON.parse(withText[0])).toMatchObject({ type: "compaction", boundary: COMPACTION_BOUNDARY_TEXT_V2 });
	});

	it("reload, resume and fork project it exactly once", async () => {
		const { harness, dir } = await compactedSession();
		const before = JSON.stringify(harness.sessionManager.buildSessionProjection().messages);
		expect(boundaryCount(harness.sessionManager)).toBe(1);

		await harness.session.reload();
		expect(boundaryCount(harness.sessionManager)).toBe(1);
		expect(JSON.stringify(harness.sessionManager.buildSessionProjection().messages)).toBe(before);

		const file = harness.sessionManager.getSessionFile() as string;
		const resumed = SessionManager.open(file, join(dir, "sessions"));
		expect(boundaryCount(resumed)).toBe(1);
		expect(JSON.stringify(resumed.buildSessionProjection().messages)).toBe(before);

		const forked = SessionManager.forkFrom(file, dir, join(dir, "forks"));
		expect(boundaryCount(forked)).toBe(1);
		const forkCompaction = forked.getBranch().find((entry) => entry.type === "compaction") as CompactionEntry;
		expect(forkCompaction.boundary).toBe(COMPACTION_BOUNDARY_TEXT_V2);

		const branched = SessionManager.open(file, join(dir, "sessions"));
		const newPath = branched.createBranchedSession(branched.getLeafId() as string);
		expect(newPath).toBeDefined();
		expect(boundaryCount(SessionManager.open(newPath as string, join(dir, "sessions")))).toBe(1);
	});

	it("/tree: before the compaction there is none; back after it, exactly one", async () => {
		const { harness, beforeCompaction } = await compactedSession();
		const leaf = harness.sessionManager.getLeafId() as string;
		await harness.session.navigateTree(beforeCompaction);
		expect(boundaryCount(harness.sessionManager)).toBe(0);
		await harness.session.navigateTree(leaf);
		expect(boundaryCount(harness.sessionManager)).toBe(1);
	});

	it.skipIf(process.getuid?.() === 0)(
		"a failed compaction write leaves no compaction, so no compaction without its boundary",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "boundary-a6-fail-"));
			cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
			const manager = SessionManager.create(dir, join(dir, "sessions"));
			manager.appendMessage({ role: "system", content: "", sections: {}, timestamp: 0 });
			const kept = manager.appendMessage({ role: "user", content: "kept", timestamp: 1 });
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
			const file = manager.getSessionFile() as string;
			chmodSync(file, 0o444);
			try {
				expect(() => manager.appendCompaction("S", kept, 1)).toThrow();
			} finally {
				chmodSync(file, 0o644);
			}
			expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
			const lines = readFileSync(file, "utf8").trim().split("\n");
			expect(lines.some((line) => line.includes('"type":"compaction"'))).toBe(false);
		},
	);
});
