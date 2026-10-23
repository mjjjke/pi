import { type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function describeMessage(message: { role: string }): string {
	return message.role === "system" || message.role === "assistant"
		? message.role
		: `${message.role}:${getMessageText(message)}`;
}

function journal(harness: Harness): string[] {
	return harness.sessionManager.buildSessionProjection().messages.map(describeMessage);
}

function recordRequests(harness: Harness, count = 1): string[][] {
	const requests: string[][] = [];
	harness.setResponses(
		Array.from(
			{ length: count },
			(): FauxResponseFactory => (context) => {
				requests.push(context.messages.map(describeMessage));
				return fauxAssistantMessage("done");
			},
		),
	);
	return requests;
}

/** Make appendMessage throw for developer messages with the given text while `failing()` is true. */
function failDeveloperAppend(harness: Harness, text: string, failing: () => boolean) {
	const original = harness.sessionManager.appendMessage.bind(harness.sessionManager);
	return vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message, options) => {
		if (failing() && message.role === "developer" && getMessageText(message) === text) {
			throw new Error(`append failed: ${text}`);
		}
		return original(message, options);
	});
}

describe("AgentSession bootstrap commit failures", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		factories: Array<(pi: ExtensionAPI) => void> = [],
		sessionManager?: SessionManager,
	): Promise<Harness> {
		const harness = await createHarness({ extensionFactories: factories, sessionManager });
		harnesses.push(harness);
		return harness;
	}

	it("B fails after developer A commits: A's onCommit runs once, no request, the rest stays staged; retries are exact (Astra M3)", async () => {
		const harness = await setup();
		const onA = vi.fn();
		const onB = vi.fn();
		let attempts = 0;
		harness.session.queueDeveloperMessage("A", { onCommit: onA });
		harness.session.queueDeveloperMessage("B", { onCommit: onB });
		const x = harness.session.queueDeveloperMessage("X");
		await harness.session.sendCustomMessage({ customType: "c", content: "content", display: false });
		await harness.session.sendCustomMessage(
			{ customType: "nt", content: "next", display: false },
			{ deliverAs: "nextTurn" },
		);
		failDeveloperAppend(harness, "B", () => attempts < 3);
		const snapshotEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "system") snapshotEvents.push("system");
		});
		const requests = recordRequests(harness);

		attempts++;
		await expect(harness.session.prompt("start")).rejects.toThrow("append failed: B");
		expect(requests).toHaveLength(0);
		expect(onA).toHaveBeenCalledTimes(1);
		expect(onB).not.toHaveBeenCalled();
		expect(snapshotEvents).toEqual(["system"]);
		expect(journal(harness)).toEqual(["system", "developer:A"]);
		expect(x.status).toBe("staged");
		if (x.status === "staged") expect(harness.session.cancelQueuedDeveloperMessage(x.pendingId)).toBe(true);

		attempts++;
		await expect(harness.session.prompt("start")).rejects.toThrow("append failed: B");
		expect(requests).toHaveLength(0);
		expect(onA).toHaveBeenCalledTimes(1);
		expect(snapshotEvents).toEqual(["system"]);
		expect(journal(harness)).toEqual(["system", "developer:A"]);

		attempts++;
		// An idle append while leftovers are staged stays behind them (FIFO).
		harness.session.appendDeveloperMessage("late");
		await harness.session.prompt("start");
		expect(requests).toEqual([
			["system", "developer:A", "developer:B", "developer:late", "user:content", "user:start", "user:next"],
		]);
		expect(onA).toHaveBeenCalledTimes(1);
		expect(onB).toHaveBeenCalledTimes(1);
		expect(snapshotEvents).toEqual(["system"]);
	});

	it("a preflight throw keeps staged items and nextTurn; preflight buffers move to staging", async () => {
		const harness = await setup([
			(pi) => {
				pi.on("before_agent_start", () => {
					pi.sendMessage({ customType: "pf", content: "preflight", display: false }, { triggerTurn: false });
				});
			},
		]);
		harness.session.queueDeveloperMessage("dev");
		await harness.session.sendCustomMessage(
			{ customType: "nt", content: "next", display: false },
			{ deliverAs: "nextTurn" },
		);
		const requests = recordRequests(harness);

		// Extension handler errors are reported, so force a failure through image normalization instead.
		const internals = harness.session as unknown as { _normalizePromptImages: () => Promise<unknown> };
		const spy = vi.spyOn(internals, "_normalizePromptImages").mockRejectedValueOnce(new Error("preflight failed"));
		await expect(harness.session.prompt("start")).rejects.toThrow("preflight failed");
		spy.mockRestore();
		expect(journal(harness)).toEqual([]);
		expect(harness.session.stagedMessages.map(describeMessage)).toEqual(["custom:preflight"]);

		await harness.session.prompt("again");
		expect(requests[0]).toEqual([
			"system",
			"developer:dev",
			"user:preflight",
			"user:preflight",
			"user:again",
			"user:next",
		]);
	});

	it("preflight custom messages emit message events once after B; idle-staged content emits none at B (Astra m13)", async () => {
		const harness = await setup([
			(pi) => {
				pi.on("before_agent_start", () => {
					pi.sendMessage({ customType: "pf", content: "preflight", display: false }, { triggerTurn: false });
				});
			},
		]);
		const counts = new Map<string, number>();
		let inPrompt = false;
		harness.session.subscribe((event) => {
			if ((event.type === "message_start" || event.type === "message_end") && inPrompt) {
				const key = `${event.type}:${describeMessage(event.message)}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		});
		await harness.session.sendCustomMessage({ customType: "idle", content: "idle", display: false });
		recordRequests(harness);
		inPrompt = true;
		await harness.session.prompt("go");

		expect(counts.get("message_start:custom:preflight")).toBe(1);
		expect(counts.get("message_end:custom:preflight")).toBe(1);
		expect(counts.get("message_start:custom:idle")).toBeUndefined();
	});

	it("an unannounced preflight item persisted before a failing append emits its events once; no listener runs between appends (recheck N7)", async () => {
		const existing = SessionManager.inMemory();
		const harness = await setup(
			[
				(pi) => {
					pi.on("before_agent_start", () => {
						pi.queueDeveloperMessage("fails");
					});
				},
			],
			existing,
		);
		let appending = false;
		const original = harness.sessionManager.appendMessage.bind(harness.sessionManager);
		let failing = true;
		vi.spyOn(harness.sessionManager, "appendMessage").mockImplementation((message, options) => {
			appending = true;
			try {
				if (failing && message.role === "developer") throw new Error("disk full");
				return original(message, options);
			} finally {
				appending = false;
			}
		});
		const insideLoop: string[] = [];
		const ends: string[] = [];
		harness.session.subscribe((event) => {
			if (appending) insideLoop.push(event.type);
			if (event.type === "message_end") ends.push(describeMessage(event.message));
		});
		recordRequests(harness);

		await expect(harness.session.prompt("go")).rejects.toThrow("disk full");
		expect(ends).toEqual(["system"]);
		failing = false;
		await harness.session.prompt("go");
		expect(ends.filter((end) => end === "system")).toHaveLength(1);
		expect(insideLoop).toEqual([]);
	});

	it("a throwing session listener does not stop B's remaining events and callbacks", async () => {
		const harness = await setup();
		const onCommit = vi.fn();
		harness.session.queueDeveloperMessage("dev", { onCommit });
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "system") throw new Error("listener failed");
		});
		const seen: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "system") seen.push("system");
		});
		recordRequests(harness);
		await harness.session.prompt("go");
		expect(seen).toEqual(["system"]);
		expect(onCommit).toHaveBeenCalledTimes(1);
	});

	it("tree navigation away from a pre-system point discards staged items without onCommit", async () => {
		const seeded = SessionManager.inMemory();
		const markerId = seeded.appendCustomEntry("marker", {});
		const systemId = seeded.appendMessage({ role: "system", content: "", sections: {}, timestamp: 0 });
		const harness = await setup([], seeded);
		await harness.session.navigateTree(markerId);
		const onCommit = vi.fn();
		const staged = harness.session.queueDeveloperMessage("dev", { onCommit });
		expect(staged.status).toBe("staged");
		await harness.session.sendCustomMessage({ customType: "c", content: "content", display: false });
		expect(harness.session.stagedMessages).toHaveLength(1);

		await harness.session.navigateTree(systemId);

		expect(harness.session.stagedMessages).toEqual([]);
		if (staged.status === "staged")
			expect(harness.session.cancelQueuedDeveloperMessage(staged.pendingId)).toBe(false);
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("reload drops extension-owned staged instructions but keeps SDK-owned ones and content", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await setup([
			(pi) => {
				api = pi;
			},
		]);
		await harness.session.bindExtensions({});
		const extensionCommit = vi.fn();
		api!.queueDeveloperMessage("from extension", { onCommit: extensionCommit });
		harness.session.queueDeveloperMessage("from sdk");
		await harness.session.sendCustomMessage({ customType: "c", content: "content", display: false });
		await harness.session.reload();
		expect(harness.session.stagedMessages.map(describeMessage)).toEqual(["custom:content"]);
		// The reload reset the API providers: check the journal written by B, not the request.
		await harness.session.prompt("go").catch(() => {});
		expect(journal(harness).slice(0, 3)).toEqual(["system", "developer:from sdk", "custom:content"]);
		expect(extensionCommit).not.toHaveBeenCalled();
	});
});
