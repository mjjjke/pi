import { rmSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { cwdFixture } from "./cwd-change-fixture.ts";
import { getMessageText } from "./harness.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("deferred cwd requests", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length) await cleanups.pop()?.();
	});
	async function fixture(options: Parameters<typeof cwdFixture>[0] = {}) {
		const f = await cwdFixture(options);
		cleanups.push(f.cleanup);
		f.runtime.setCwdChangeHandler((target, options) => f.runtime.changeCwd(target, options));
		return f;
	}

	it("is absent without an interactive binding", async () => {
		const f = await cwdFixture();
		cleanups.push(f.cleanup);
		expect(f.runtime.session.extensionRunner.createContext().requestCwdChange).toBeUndefined();
	});

	it.each(["session", "extension"] as const)("rejects pre-bootstrap cwd requests through %s", async (caller) => {
		const f = await fixture({ persist: true });
		const old = f.runtime.session;
		const entries = structuredClone(old.sessionManager.getEntries());
		const request =
			caller === "session" ? old.requestCwdChange(f.b) : old.extensionRunner.createContext().requestCwdChange!(f.b);
		expect(request).toEqual({
			status: "rejected",
			reason: "Not changed: the session has not bootstrapped; wait for the first run to start.",
		});
		expect(old.pendingCwdChange).toBeUndefined();
		old.dispose();
		await tick();
		expect(f.runtime.cwd).toBe(f.a);
		expect(old.stagedMessages).toEqual([]);
		expect(old.sessionManager.getEntries()).toEqual(entries);
	});

	it("applies on the next tick after settle, never inside a settle handler; rejects a second request", async () => {
		const f = await fixture();
		let request: ReturnType<typeof f.runtime.session.requestCwdChange> | undefined;
		f.runtime.session.subscribe((event) => {
			if (event.type === "agent_start") {
				request = f.runtime.session.extensionRunner.createContext().requestCwdChange!(f.b);
				expect(request.status).toBe("pending");
				expect(f.runtime.session.extensionRunner.createContext().requestCwdChange!(f.b).status).toBe("rejected");
			}
			if (event.type === "agent_settled") expect(f.runtime.cwd).toBe(f.a);
		});
		await f.runtime.session.prompt("hello");
		expect(f.runtime.cwd).toBe(f.a);
		if (request?.status !== "pending") throw new Error("request rejected");
		expect(await request.completion).toBe("applied");
		expect(f.runtime.cwd).toBe(f.b);
		expect(f.runtime.session.messages.filter((m) => m.role === "custom" && m.customType === "pi.cwd")).toHaveLength(
			1,
		);
	});

	it.each(["abort", "dispose", "tree"] as const)(
		"%s before the immediate cancels once on the origin",
		async (action) => {
			const f = await fixture();
			await f.runtime.session.prompt("hello");
			const old = f.runtime.session;
			const target = old.sessionManager
				.getBranch()
				.find((e) => e.type === "message" && e.message.role === "system")!.id;
			const request = old.extensionRunner.createContext().requestCwdChange!(f.b);
			if (request.status !== "pending") throw new Error("request rejected");
			if (action === "abort") await old.abort();
			else if (action === "dispose") old.dispose();
			else await old.navigateTree(target);
			expect(await request.completion).toBe("cancelled");
			await tick();
			expect(f.runtime.cwd).toBe(f.a);
			const outcomes = old.sessionManager
				.getEntries()
				.filter((e) => e.type === "custom_message" && e.customType === "pi.cwd");
			expect(outcomes).toHaveLength(1);
			if (action === "tree") expect(old.sessionManager.getBranch()).not.toContain(outcomes[0]);
		},
	);

	it.each(["session", "runtime"] as const)(
		"%s disposal rejects a reentrant cwd request from its cancellation receipt listener",
		async (owner) => {
			const f = await fixture();
			const old = f.runtime.session;
			await old.prompt("bootstrapped");
			const first = old.requestCwdChange(f.b);
			if (first.status !== "pending") throw new Error(first.reason);
			let second: ReturnType<typeof old.requestCwdChange> | undefined;
			const receipts: string[] = [];
			old.subscribe((event) => {
				if (
					event.type !== "message_end" ||
					event.message.role !== "custom" ||
					event.message.customType !== "pi.cwd"
				)
					return;
				const details = event.message.details as { requestId: string };
				receipts.push(details.requestId);
				if (details.requestId === first.requestId) second = old.requestCwdChange(f.b);
			});
			if (owner === "session") old.dispose();
			else await f.runtime.dispose();
			expect(await first.completion).toBe("cancelled");
			await tick();
			expect(second?.status).toBe("rejected");
			expect(old.pendingCwdChange).toBeUndefined();
			expect(receipts).toEqual([first.requestId]);
			const outcomes = old.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "pi.cwd");
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]).toMatchObject({ details: { kind: "cancelled", requestId: first.requestId } });
		},
	);

	it.each([
		"unlink /old/session.jsonl: EACCES: permission denied",
		"unlink /old/session.jsonl.moved: EPERM: operation not permitted",
		"fsync /old/sessions: EIO: input/output error",
		"reconcile marker /old/session.jsonl.moved does not name /new/session.jsonl",
	])("names the previous cleanup failure without losing its actionable detail: %s", async (detail) => {
		const f = await fixture();
		const old = f.runtime.session;
		await old.prompt("bootstrapped");
		const entries = structuredClone(old.sessionManager.getEntries());
		vi.spyOn(old.sessionManager, "preflightCwdChange").mockImplementationOnce(() => {
			throw new Error(`cd: ${detail}`);
		});
		expect(old.requestCwdChange(f.b)).toEqual({
			status: "rejected",
			reason: `Not changed: the previous change's cleanup failed: ${detail}.`,
		});
		expect(old.pendingCwdChange).toBeUndefined();
		expect(old.sessionManager.getEntries()).toEqual(entries);
	});

	it("keeps pending across reload and accepts a new request after it applied", async () => {
		const f = await fixture();
		await f.runtime.session.prompt("hello");
		const request = f.runtime.session.extensionRunner.createContext().requestCwdChange!(f.b);
		if (request.status !== "pending") throw new Error("request rejected");
		await f.runtime.session.reload();
		expect(await request.completion).toBe("applied");
		const next = f.runtime.session.extensionRunner.createContext().requestCwdChange!(f.a);
		expect(next.status).toBe("pending");
		await f.runtime.session.abort();
	});

	it("trust No adds exactly one cancelled child and leaves original history and location unchanged", async () => {
		const f = await fixture();
		await f.runtime.session.prompt("hello");
		const prefix = structuredClone(f.runtime.session.messages);
		f.runtime.setResolveTargetTrust(async () => false);
		const request = f.runtime.session.extensionRunner.createContext().requestCwdChange!(f.b);
		if (request.status !== "pending") throw new Error("request rejected");
		expect(await request.completion).toBe("untrusted");
		expect(f.runtime.cwd).toBe(f.a);
		expect(f.runtime.session.messages.slice(0, prefix.length)).toEqual(prefix);
		expect(f.runtime.session.messages).toHaveLength(prefix.length + 1);
		expect(getMessageText(f.runtime.session.messages.at(-1))).toContain(`${f.b} is not trusted`);
	});

	it.each(["abort", "tree", "dispose"] as const)(
		"%s during trust prevents commit and owns the only outcome",
		async (action) => {
			const f = await fixture();
			await f.runtime.session.prompt("hello");
			const old = f.runtime.session;
			let answer!: (value: boolean) => void;
			f.runtime.setResolveTargetTrust(
				() =>
					new Promise<boolean>((resolve) => {
						answer = resolve;
					}),
			);
			const request = old.extensionRunner.createContext().requestCwdChange!(f.b);
			if (request.status !== "pending") throw new Error("request rejected");
			await tick();
			if (action === "abort") await old.abort();
			else if (action === "dispose") old.dispose();
			else await old.navigateTree(old.sessionManager.getBranch()[0]!.id);
			answer(true);
			await tick();
			expect(await request.completion).toBe("cancelled");
			expect(f.runtime.cwd).toBe(f.a);
			expect(
				old.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "pi.cwd"),
			).toHaveLength(1);
		},
	);

	it("quit cancels before asynchronous shutdown handlers can let the trust answer commit", async () => {
		let releaseShutdown!: () => void;
		const shutdownWait = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		const f = await fixture({
			extension: (pi) => {
				pi.on("session_shutdown", async (event) => {
					if (event.reason === "quit") await shutdownWait;
				});
			},
		});
		await f.runtime.session.prompt("hello");
		let answer!: (value: boolean) => void;
		f.runtime.setResolveTargetTrust(
			() =>
				new Promise<boolean>((resolve) => {
					answer = resolve;
				}),
		);
		const request = f.runtime.session.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		await tick();
		const closing = f.runtime.dispose();
		answer(true);
		await tick();
		expect(f.runtime.cwd).toBe(f.a);
		releaseShutdown();
		await closing;
		expect(await request.completion).toBe("cancelled");
	});

	it.each(["pending", "settling-run", "trust"] as const)(
		"interactive quit cancels %s before awaiting terminal input drain",
		async (state) => {
			const order: string[] = [];
			const f = await fixture({
				persist: true,
				extension: (pi) => {
					pi.on("session_shutdown", () => {
						order.push("extension cleanup");
					});
				},
			});
			const old = f.runtime.session;
			await old.prompt("bootstrapped");
			let finishRun!: () => void;
			let run: Promise<void> | undefined;
			if (state === "settling-run") {
				let started!: () => void;
				const entered = new Promise<void>((resolve) => {
					started = resolve;
				});
				const waiting = new Promise<void>((resolve) => {
					finishRun = resolve;
				});
				f.seed.setResponses([
					async () => {
						started();
						await waiting;
						return fauxAssistantMessage("finished during terminal drain");
					},
				]);
				run = old.prompt("finish while quitting");
				await entered;
			}
			let answer!: (trusted: boolean) => void;
			if (state === "trust") {
				f.runtime.setResolveTargetTrust(
					() =>
						new Promise<boolean>((resolve) => {
							answer = resolve;
						}),
				);
			}
			const request = old.requestCwdChange(f.b);
			if (request.status !== "pending") throw new Error(request.reason);
			if (state === "trust") {
				await tick();
				expect(old.pendingCwdChange?.state).toBe("trust");
			}
			let releaseDrain!: () => void;
			const drained = new Promise<void>((resolve) => {
				releaseDrain = resolve;
			});
			const context = {
				runtimeHost: f.runtime,
				isShuttingDown: false,
				themeController: { disableAutoSync() {} },
				ui: {
					terminal: {
						drainInput: () => {
							order.push("drain");
							return drained;
						},
					},
				},
				stop: () => order.push("terminal stop"),
				get sessionManager() {
					return old.sessionManager;
				},
			};
			vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
			const closing = Reflect.get(InteractiveMode.prototype, "shutdown").call(context);
			const duringDrain = old.requestCwdChange(f.a);
			let outcome: string | undefined;
			void request.completion.then((value) => {
				outcome = value;
			});
			try {
				if (state === "settling-run") finishRun();
				if (state === "trust") answer(true);
				await run;
				await vi.waitFor(() => expect(outcome).toBeDefined());
				expect(outcome).toBe("cancelled");
				expect(f.runtime.cwd).toBe(f.a);
				expect(duringDrain.status).toBe("rejected");
				expect(order).toEqual(["drain"]);
			} finally {
				releaseDrain();
				await closing;
			}
			expect(order).toEqual(["drain", "terminal stop", "extension cleanup"]);
			expect(
				old.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "pi.cwd"),
			).toHaveLength(1);
		},
	);

	it("cwd outcome markers never make a boundary continuable", async () => {
		const f = await fixture();
		await f.runtime.session.prompt("hello");
		await f.runtime.session.sendCustomMessage({ customType: "pi.cwd", content: "observation", display: true });
		const session = f.runtime.session as unknown as {
			_buildBoundaryContext(drafts: [], boundary: "agent_before_settle"): { canContinue: boolean };
		};
		expect(session._buildBoundaryContext([], "agent_before_settle").canContinue).toBe(false);
	});

	it("a running user shell command delays the request until its wakeup, preserving its old cwd", async () => {
		const f = await fixture();
		await f.runtime.session.prompt("hello");
		const command = f.runtime.session.executeBash("sleep 0.05; pwd");
		const request = f.runtime.session.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		await tick();
		expect(f.runtime.cwd).toBe(f.a);
		expect((await command).output.trim()).toBe(f.a);
		expect(await request.completion).toBe("applied");
	});

	it("provider errors still settle into an applied change", async () => {
		const f = await fixture({ settings: { retry: { enabled: false } } });
		await f.runtime.session.prompt("bootstrapped");
		f.seed.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline error" })]);
		const run = f.runtime.session.prompt("error");
		const request = f.runtime.session.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		await run;
		expect(await request.completion).toBe("applied");
	});

	it("queued steer and follow-up, then a settle-triggered custom run all use the old cwd", async () => {
		const f = await fixture();
		await f.runtime.session.prompt("bootstrapped");
		let finish!: () => void;
		const waiting = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const observed: string[] = [];
		f.seed.setResponses([
			async () => {
				await waiting;
				observed.push(f.runtime.cwd);
				return fauxAssistantMessage("first");
			},
			...Array.from({ length: 4 }, () => () => {
				observed.push(f.runtime.cwd);
				return fauxAssistantMessage("next");
			}),
		]);
		const old = f.runtime.session;
		let chained = false;
		old.subscribe((event) => {
			if (event.type === "agent_settled" && !chained) {
				chained = true;
				void old.sendCustomMessage(
					{ customType: "task", content: "task completion", display: true },
					{ triggerTurn: true },
				);
			}
		});
		const run = old.prompt("hello");
		const request = old.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		await old.steer("steer");
		await old.followUp("follow up");
		finish();
		await run;
		expect(await request.completion).toBe("applied");
		expect(observed.length).toBeGreaterThanOrEqual(3);
		expect(observed.every((cwd) => cwd === f.a)).toBe(true);
	});

	it.each(["answer-first", "reload-first"] as const)(
		"trust waiting across reload: %s applies once, without another dialog",
		async (order) => {
			const f = await fixture();
			await f.runtime.session.prompt("hello");
			let answer!: (value: boolean) => void;
			const trust = vi.fn(
				() =>
					new Promise<boolean>((resolve) => {
						answer = resolve;
					}),
			);
			f.runtime.setResolveTargetTrust(trust);
			const old = f.runtime.session;
			const request = old.requestCwdChange(f.b);
			if (request.status !== "pending") throw new Error("rejected");
			await tick();
			let releaseReload!: () => void;
			const reloadWait = new Promise<void>((resolve) => {
				releaseReload = resolve;
			});
			const reload = old.reload({ beforeSessionStart: () => reloadWait });
			if (order === "answer-first") {
				answer(true);
				await tick();
				releaseReload();
				await reload;
			} else {
				releaseReload();
				await reload;
				answer(true);
			}
			expect(await request.completion).toBe("applied");
			expect(trust).toHaveBeenCalledTimes(1);
		},
	);

	it("a run arriving during trust is delivered once and the change re-pends with the answer cached", async () => {
		const f = await fixture();
		await f.runtime.session.prompt("hello");
		let answer!: (value: boolean) => void;
		let finish!: () => void;
		const trust = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					answer = resolve;
				}),
		);
		f.runtime.setResolveTargetTrust(trust);
		const old = f.runtime.session;
		const request = old.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		await tick();
		const waiting = new Promise<void>((resolve) => {
			finish = resolve;
		});
		f.seed.setResponses([
			async () => {
				await waiting;
				return fauxAssistantMessage("task done");
			},
		]);
		const run = old.sendCustomMessage(
			{ customType: "task", content: "completion", display: true },
			{ triggerTurn: true },
		);
		answer(true);
		await tick();
		expect(f.runtime.cwd).toBe(f.a);
		expect(old.pendingCwdChange?.state).toBe("pending");
		finish();
		await run;
		expect(await request.completion).toBe("applied");
		expect(trust).toHaveBeenCalledTimes(1);
		expect(f.runtime.session.messages.filter((m) => m.role === "custom" && m.customType === "task")).toHaveLength(1);
	});

	it("a drained requestNewSession receipts the cancelled cwd on the old file, not the new one", async () => {
		let first = true;
		let completion: Promise<string> | undefined;
		let destination = "";
		const f = await fixture({
			persist: true,
			extension: (pi) => {
				pi.on("agent_end", async (_event, ctx) => {
					if (!first) return;
					first = false;
					const change = ctx.requestCwdChange!(destination);
					if (change.status !== "pending") throw new Error("rejected");
					completion = change.completion;
					await ctx.requestNewSession();
				});
			},
		});
		destination = f.b;
		const old = f.runtime.session;
		await old.prompt("replace in loop");
		expect(await completion).toBe("cancelled");
		expect(f.runtime.session).not.toBe(old);
		expect(
			old.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === "pi.cwd"),
		).toHaveLength(1);
		expect(f.runtime.session.messages).toEqual([]);
	});

	it("automatic compaction at settle delays the change until its terminal boundary", async () => {
		let started!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			started = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const f = await fixture({
			settings: { compaction: { enabled: true, keepRecentTokens: 10, reserveTokens: 0 } },
			extension: (pi) => {
				pi.on("session_before_compact", async (event) => {
					started();
					await waiting;
					return {
						compaction: {
							summary: "summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		});
		await f.runtime.session.prompt(`old ${"x".repeat(1000)}`);
		let compaction: Promise<boolean> | undefined;
		const old = f.runtime.session;
		const internals = old as unknown as { _runAutoCompaction(reason: "threshold", retry: false): Promise<boolean> };
		old.subscribe((event) => {
			if (event.type === "agent_settled" && !compaction)
				compaction = internals._runAutoCompaction("threshold", false);
		});
		const run = old.prompt(`recent ${"y".repeat(200)}`);
		const request = f.runtime.session.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		await entered;
		await tick();
		expect(f.runtime.cwd).toBe(f.a);
		expect(f.runtime.session.pendingCwdChange?.state).toBe("pending");
		release();
		await run;
		await compaction;
		expect(await request.completion).toBe("applied");
	});

	it.each([false, true])("plain compact keeps a pending change; --now=%s cancels it", async (now) => {
		const f = await fixture({
			settings: { compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 0 } },
			extension: (pi) => {
				pi.on("session_before_compact", () => new Promise(() => {}));
			},
		});
		await f.runtime.session.prompt(`old ${"x".repeat(1000)}`);
		await f.runtime.session.prompt(`recent ${"y".repeat(200)}`);
		const old = f.runtime.session;
		const request = old.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		if (now) {
			const compact = old.compactNow();
			expect(await request.completion).toBe("cancelled");
			await tick();
			old.abortCompaction();
			await compact;
		} else {
			const events: string[] = [];
			old.subscribe((event) => {
				if (event.type === "session_background_compaction" && event.cause) events.push(event.cause);
			});
			expect(old.startBackgroundCompaction({ source: "user" }).status).toBe("started");
			expect(old.pendingCwdChange).toBeDefined();
			expect(await request.completion).toBe("applied");
			expect(events).toContain("reload");
		}
	});

	it("target removed during trust fails once without relocation", async () => {
		const f = await fixture();
		await f.runtime.session.prompt("hello");
		f.runtime.setResolveTargetTrust(async () => {
			rmSync(f.b, { recursive: true });
			return true;
		});
		const request = f.runtime.session.extensionRunner.createContext().requestCwdChange!(f.b);
		if (request.status !== "pending") throw new Error("request rejected");
		expect(await request.completion).toBe("failed");
		expect(f.runtime.cwd).toBe(f.a);
		expect(getMessageText(f.runtime.session.messages.at(-1))).toContain(
			"Working-directory change failed (not a request).",
		);
	});
});
