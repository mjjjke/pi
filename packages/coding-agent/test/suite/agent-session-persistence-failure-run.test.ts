import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

// chmod does not stop root from writing.
const runsAsRoot = process.getuid?.() === 0;

describe.skipIf(runsAsRoot)("AgentSession: an append fails while the run persists its start message (§3.6)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function readOnlySessionAfterOneExchange(): Promise<{ harness: Harness; file: string }> {
		const dir = mkdtempSync(join(tmpdir(), "pi-persistence-run-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
		const persisted = await createHarness({ sessionManager });
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected a session file path");
		persisted.setResponses([fauxAssistantMessage("uno"), fauxAssistantMessage("dos")]);
		await persisted.session.prompt("uno");
		chmodSync(file, 0o444);
		cleanups.push(() => {
			chmodSync(file, 0o644);
			persisted.cleanup();
		});
		return { harness: persisted, file };
	}

	it("ends the run with turn_end and agent_end, reports the error once and resolves", async () => {
		const { harness, file } = await readOnlySessionAfterOneExchange();
		const before = readFileSync(file, "utf8");
		const events: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				events.push(`assistant:${event.message.stopReason}:${event.message.errorMessage ?? ""}`);
			} else {
				events.push(event.type);
			}
		});

		await expect(harness.session.prompt("dos")).resolves.toBeUndefined();

		const error = harness.sessionManager.getPersistenceError();
		expect(error?.code).toBe("EACCES");
		expect(events.filter((type) => type.startsWith("assistant:"))).toEqual([`assistant:error:${error?.message}`]);
		expect(events.slice(events.indexOf(`assistant:error:${error?.message}`) + 1)).toEqual(
			expect.arrayContaining(["turn_end", "agent_end"]),
		);
		expect(harness.session.isStreaming).toBe(false);
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("a later prompt is refused with the same text, before any run starts", async () => {
		const { harness } = await readOnlySessionAfterOneExchange();
		await harness.session.prompt("dos");
		const events: string[] = [];
		harness.session.subscribe((event) => events.push(event.type));

		await expect(harness.session.prompt("tres")).rejects.toThrow(/^Session file write failed \(EACCES\)/);
		expect(events).not.toContain("agent_start");
	});
});
