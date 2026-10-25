import { afterEach, describe, expect, it } from "vitest";
import type { SessionCompactEvent } from "../../src/core/extensions/types.ts";
import type { CustomMessage } from "../../src/core/messages.ts";
import type { CompactionEntry, ContextEditEntry } from "../../src/core/session-manager.ts";
import { createBootstrappedSessionManager, createHarness, type Harness } from "./harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

type NoticeInternals = {
	_customStore: Map<CustomMessage, { handle: CustomMessage; lane: string }>;
	_emitSessionCompact(event: SessionCompactEvent): Promise<void>;
	_emitSessionContextChange(entry: ContextEditEntry): Promise<void>;
};

describe("AgentSession: notice lane belongs to a dispatch's async source", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	for (const eventType of ["session_compact", "session_context_change"] as const) {
		it(`${eventType}: independent ingress, public and error listeners do not inherit the notice scope`, async () => {
			const preparing = deferred();
			const finishPreparing = deferred();
			const inHandler = deferred();
			const finishHandler = deferred();
			const late = deferred();
			const lateFinished = deferred();
			let harness!: Harness;
			const send = (content: string) =>
				harness.session.sendCustomMessage({ customType: "task", content, display: false }, { triggerTurn: false });
			harness = await createHarness({
				sessionManager: createBootstrappedSessionManager(),
				settings: { compaction: { enabled: false } },
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", async () => {
							preparing.resolve();
							await finishPreparing.promise;
						});
						const handler = async () => {
							await send("handler-sync");
							pi.appendEntry("host-callback", {});
							void late.promise.then(async () => {
								await send("late");
								lateFinished.resolve();
							});
							inHandler.resolve();
							await finishHandler.promise;
							await new Promise<void>((resolve) => setTimeout(resolve, 0));
							await send("handler-awaited-timer");
							throw new Error("handler failure");
						};
						const afterError = async () => {
							await send("handler-after-error");
						};
						if (eventType === "session_compact") {
							pi.on("session_compact", handler);
							pi.on("session_compact", afterError);
						} else {
							pi.on("session_context_change", handler);
							pi.on("session_context_change", afterError);
						}
					},
				],
			});
			cleanups.push(harness.cleanup);
			await harness.session.bindExtensions({
				onError: () => {
					void send("binding-error");
				},
			});
			harness.session.extensionRunner.onError(() => {
				void send("runner-error");
			});
			harness.session.subscribe((event) => {
				if (
					event.type === "entry_appended" &&
					event.entry.type === "custom" &&
					event.entry.customType === "host-callback"
				) {
					void send("public-listener");
				}
			});
			const run = harness.session.prompt("never sent");
			await preparing.promise;
			const internals = harness.session as unknown as NoticeInternals;
			const manager = harness.sessionManager;
			const target = manager.appendMessage({ role: "user", content: "old", timestamp: 0 });
			let dispatch: Promise<void>;
			if (eventType === "session_compact") {
				const id = manager.appendCompaction("summary", target, 100);
				dispatch = internals._emitSessionCompact({
					type: "session_compact",
					compactionEntry: manager.getEntry(id) as CompactionEntry,
					fromExtension: false,
					reason: "manual",
					willRetry: false,
				});
			} else {
				const id = manager.appendContextEdit(target, null);
				dispatch = internals._emitSessionContextChange(manager.getEntry(id) as ContextEditEntry);
			}
			await inHandler.promise;
			await send("independent");
			finishHandler.resolve();
			await dispatch;
			late.resolve();
			await lateFinished.promise;
			const lanes = Object.fromEntries(
				[...internals._customStore.values()].map((item) => [item.handle.content, item.lane === "notice"]),
			);
			expect(lanes).toEqual({
				"handler-sync": true,
				"public-listener": false,
				independent: false,
				"handler-awaited-timer": true,
				"binding-error": false,
				"runner-error": false,
				"handler-after-error": true,
				late: false,
			});
			const stopped = harness.session.abort();
			finishPreparing.resolve();
			await run;
			await stopped;
			expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		});
	}
});
