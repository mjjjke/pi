import { type Context, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cwdFixture } from "./cwd-change-fixture.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("applied model cwd continuation", () => {
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

	it("starts once in the destination after startup, with notice, handoff and patch but no invented input", async () => {
		let startupDone = false;
		const f = await fixture({
			persist: true,
			extension: (pi) => {
				pi.on("session_start", async (event) => {
					if (event.reason !== "cwd") return;
					await tick();
					pi.sendMessage({ customType: "handoff", content: "destination snapshot", display: false });
					startupDone = true;
				});
			},
		});
		const contexts: Context[] = [];
		const directories: string[] = [];
		f.seed.setResponses(
			Array.from({ length: 4 }, () => (context) => {
				contexts.push(structuredClone(context));
				directories.push(f.runtime.cwd);
				if (f.runtime.cwd === f.b) expect(startupDone).toBe(true);
				return fauxAssistantMessage("continue work");
			}),
		);
		let request: ReturnType<typeof f.runtime.session.requestCwdChange> | undefined;
		f.runtime.session.subscribe((event) => {
			if (event.type === "agent_start") request = f.runtime.session.requestCwdChange(f.b);
		});
		await f.runtime.session.prompt("move and continue");
		if (request?.status !== "pending") throw new Error("rejected");
		expect(await request.completion).toBe("applied");
		await f.runtime.session.waitForIdle();
		await tick();
		expect(directories).toEqual([f.a, f.b]);
		const messages = f.runtime.session.messages;
		const notice = messages.findIndex((m) => m.role === "custom" && m.customType === "pi.cwd");
		expect(messages.slice(notice).map((m) => (m.role === "custom" ? m.customType : m.role))).toEqual([
			"pi.cwd",
			"handoff",
			"system",
			"assistant",
		]);
		expect(contexts[1]!.messages.slice(0, contexts[0]!.messages.length)).toEqual(contexts[0]!.messages);
		expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
		expect(
			f.runtime.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === "pi.cwd"),
		).toHaveLength(1);
	});

	it("a destination startup prompt owns the same run instead of a second automatic run", async () => {
		const f = await fixture({
			extension: (pi) => {
				pi.on("session_start", (event) => {
					if (event.reason === "cwd") pi.sendUserMessage("typed meanwhile");
				});
			},
		});
		const requests: string[] = [];
		f.seed.setResponses(
			Array.from({ length: 4 }, () => (context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("ok");
			}),
		);
		await f.runtime.session.prompt("bootstrap");
		const request = f.runtime.session.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		expect(await request.completion).toBe("applied");
		await f.runtime.session.waitForDeferredPrompts();
		await tick();
		expect(requests).toHaveLength(2);
		expect(requests[1]).toContain("typed meanwhile");
		expect(requests[1]).toContain("Working-directory change");
	});

	it("input whose preflight overlaps destination startup joins the automatic run", async () => {
		let releaseInput!: () => void;
		let input: Promise<void> | undefined;
		const waiting = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const f = await fixture({
			extension: (pi) => {
				pi.on("input", async (event) => {
					if (event.text === "typed during startup") await waiting;
					return { action: "continue" };
				});
			},
		});
		await f.runtime.session.prompt("bootstrap");
		const contexts: Context[] = [];
		let releaseResponse!: () => void;
		const responseWait = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		f.seed.setResponses([
			async (context) => {
				contexts.push(context);
				await responseWait;
				return fauxAssistantMessage("first");
			},
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("with input");
			},
		]);
		f.runtime.setRebindSession(async (session) => {
			await session.bindExtensions({ mode: "tui" });
			input = session.prompt("typed during startup");
		});
		const request = f.runtime.session.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		expect(await request.completion).toBe("applied");
		const destination = f.runtime.session;
		const starts = vi.fn();
		destination.subscribe((event) => {
			if (event.type === "agent_start") starts();
		});
		releaseInput();
		releaseResponse();
		await input;
		await destination.waitForIdle();
		expect(contexts).toHaveLength(1);
		expect(JSON.stringify(contexts[0])).toContain("typed during startup");
		expect(starts).toHaveBeenCalledTimes(1);
	});

	it.each(["abort", "dispose", "tree", "replace", "quit"] as const)(
		"%s during destination startup suppresses the new run",
		async (action) => {
			const f = await fixture();
			const contexts: Context[] = [];
			f.seed.setResponses(
				Array.from({ length: 4 }, () => (context) => {
					contexts.push(context);
					return fauxAssistantMessage("ok");
				}),
			);
			await f.runtime.session.prompt("bootstrap");
			f.runtime.setRebindSession(async (session) => {
				await session.bindExtensions({ mode: "tui" });
				if (action === "abort") await session.abort();
				else if (action === "dispose") session.dispose();
				else if (action === "tree") await session.navigateTree(session.sessionManager.getBranch()[0]!.id);
				else if (action === "replace") await session.prepareForSessionReplacement();
				else session.closeAdmission();
			});
			const request = f.runtime.session.requestCwdChange(f.b);
			if (request.status !== "pending") throw new Error("rejected");
			expect(await request.completion).toBe("applied");
			await tick();
			expect(contexts).toHaveLength(1);
		},
	);

	it("queued destination steering and follow-up input share the one destination run", async () => {
		const f = await fixture();
		await f.runtime.session.prompt("bootstrap");
		const contexts: Context[] = [];
		const starts = vi.fn();
		f.seed.setResponses(
			Array.from({ length: 4 }, () => (context) => {
				contexts.push(structuredClone(context));
				return fauxAssistantMessage("ok");
			}),
		);
		f.runtime.setRebindSession(async (session) => {
			await session.bindExtensions({ mode: "tui" });
			session.subscribe((event) => {
				if (event.type === "agent_start") starts();
			});
			await session.steer("destination steer");
			await session.followUp("destination follow-up");
		});
		const request = f.runtime.session.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		expect(await request.completion).toBe("applied");
		await f.runtime.session.waitForIdle();
		expect(starts).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(contexts[0])).toContain("destination steer");
		expect(JSON.stringify(contexts.at(-1))).toContain("destination follow-up");
		expect(f.runtime.session.messages.filter((m) => m.role === "user")).toHaveLength(3);
	});

	it("abort during a newer destination readiness barrier does not revive the wakeup", async () => {
		const f = await fixture();
		await f.runtime.session.prompt("bootstrap");
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reload!: Promise<void>;
		f.runtime.setRebindSession(async (session) => {
			await session.bindExtensions({ mode: "tui" });
			reload = session.reload({ beforeSessionStart: () => waiting });
		});
		const starts = vi.fn();
		f.seed.setResponses([
			() => {
				starts();
				return fauxAssistantMessage("unexpected");
			},
		]);
		const request = f.runtime.session.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		expect(await request.completion).toBe("applied");
		await f.runtime.session.abort();
		release();
		await reload;
		await tick();
		expect(starts).not.toHaveBeenCalled();
		expect(f.runtime.session.isIdle).toBe(true);
	});

	it("a handled startup input releases the outcome wakeup", async () => {
		const f = await fixture({
			extension: (pi) => {
				pi.on("input", (event) => (event.text === "handled" ? { action: "handled" } : { action: "continue" }));
				pi.on("session_start", (event) => {
					if (event.reason === "cwd") pi.sendUserMessage("handled");
				});
			},
		});
		await f.runtime.session.prompt("bootstrap");
		const contexts: Context[] = [];
		f.seed.setResponses([
			(context) => {
				contexts.push(context);
				return fauxAssistantMessage("continued");
			},
		]);
		const request = f.runtime.session.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		expect(await request.completion).toBe("applied");
		await f.runtime.session.waitForDeferredPrompts();
		expect(contexts).toHaveLength(1);
		expect(JSON.stringify(contexts[0])).toContain("Working-directory change");
		expect(f.runtime.session.messages.filter((m) => m.role === "user")).toHaveLength(1);
	});

	it("a stop after publication while shutdown is awaiting keeps the applied outcome without a run", async () => {
		let entered!: () => void;
		let release!: () => void;
		const shutdownEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const shutdownWait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const f = await fixture({
			extension: (pi) => {
				pi.on("session_shutdown", async (event) => {
					if (event.reason === "cwd") {
						entered();
						await shutdownWait;
					}
				});
			},
		});
		const old = f.runtime.session;
		await old.prompt("bootstrap");
		const starts = vi.fn();
		f.seed.setResponses([
			() => {
				starts();
				return fauxAssistantMessage("unexpected");
			},
		]);
		const request = old.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		await shutdownEntered;
		await old.abort();
		release();
		expect(await request.completion).toBe("applied");
		await tick();
		expect(f.runtime.cwd).toBe(f.b);
		expect(starts).not.toHaveBeenCalled();
	});

	it.each(["abort", "untrusted", "failed"] as const)("%s before publication never wakes a run", async (outcome) => {
		const f = await fixture();
		await f.runtime.session.prompt("bootstrap");
		const starts = vi.fn();
		f.seed.setResponses([
			() => {
				starts();
				return fauxAssistantMessage("unexpected");
			},
		]);
		if (outcome === "untrusted") f.runtime.setResolveTargetTrust(async () => false);
		if (outcome === "failed")
			vi.spyOn(f.runtime.session.sessionManager, "relocate").mockImplementationOnce(() => {
				throw new Error("offline failure");
			});
		const request = f.runtime.session.requestCwdChange(f.b);
		if (request.status !== "pending") throw new Error("rejected");
		if (outcome === "abort") await f.runtime.session.abort();
		expect(await request.completion).toBe(outcome === "abort" ? "cancelled" : outcome);
		await tick();
		expect(f.runtime.cwd).toBe(f.a);
		expect(starts).not.toHaveBeenCalled();
	});

	it("user cd stays passive", async () => {
		const f = await fixture();
		const starts = vi.fn();
		await f.runtime.session.prompt("bootstrap");
		f.seed.setResponses([
			() => {
				starts();
				return fauxAssistantMessage("unexpected");
			},
		]);
		expect((await f.runtime.changeCwd(f.b, { source: "user" })).changed).toBe(true);
		await tick();
		expect(starts).not.toHaveBeenCalled();
	});
});
