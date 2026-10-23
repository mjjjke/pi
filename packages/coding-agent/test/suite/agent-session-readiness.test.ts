import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Context,
	type FauxResponseFactory,
	fauxAssistantMessage,
	getCurrentSystemMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";
import { createRpcHarness, type RpcHarness } from "./rpc-harness.ts";
import { createRuntimeHarness, type RuntimeHarness } from "./runtime-harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	onRawStdoutBroken: vi.fn(() => () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolve = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

function lateTool(name: string) {
	return {
		name,
		label: name,
		description: `Registered late: ${name}`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: name }], details: {} }),
	};
}

interface RequestLog {
	tools: string[];
	texts: string[];
}

function recordRequests(harness: Harness, count: number): RequestLog[] {
	const log: RequestLog[] = [];
	harness.setResponses(
		Array.from(
			{ length: count },
			(): FauxResponseFactory => (context) => {
				log.push({
					tools: (getCurrentSystemMessage(context.messages)?.toolsAdded ?? []).map((tool) => tool.name),
					texts: context.messages.filter((m) => m.role === "user").map((m) => getMessageText(m)),
				});
				return fauxAssistantMessage("ok");
			},
		),
	);
	return log;
}

describe("AgentSession readiness barrier", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(factories: Array<(pi: ExtensionAPI) => void>): Promise<Harness> {
		const harness = await createHarness({ extensionFactories: factories });
		harnesses.push(harness);
		return harness;
	}

	it("a run started by an early session_start handler waits for the rest of binding (Sol F1)", async () => {
		const gate = deferred();
		let lateRegistered = false;
		const harness = await setup([
			(pi) => {
				pi.on("session_start", () => {
					pi.sendUserMessage("early start");
				});
			},
			(pi) => {
				pi.on("session_start", async () => {
					await gate.promise;
					pi.registerTool(lateTool("late"));
					lateRegistered = true;
				});
			},
		]);
		const log = recordRequests(harness, 1);

		const binding = harness.session.bindExtensions({});
		await tick();
		expect(log).toHaveLength(0);
		gate.resolve();
		await binding;
		expect(lateRegistered).toBe(true);
		await harness.session.waitForIdle();
		await tick();
		await harness.session.waitForIdle();

		expect(log).toHaveLength(1);
		expect(log[0]!.tools).toContain("late");
		expect(log[0]!.texts).toEqual(["early start"]);
	});

	it("a startup-triggered prompt runs input hooks registered later in binding (Astra M10)", async () => {
		const gate = deferred();
		const harness = await setup([
			(pi) => {
				pi.on("session_start", () => {
					pi.sendUserMessage("raw");
				});
			},
			(pi) => {
				pi.on("session_start", async () => {
					await gate.promise;
					pi.on("input", (event) => ({ action: "transform" as const, text: `${event.text} (transformed)` }));
				});
			},
		]);
		const log = recordRequests(harness, 1);

		const binding = harness.session.bindExtensions({});
		await tick();
		gate.resolve();
		await binding;
		await tick();
		await harness.session.waitForIdle();

		expect(log.map((entry) => entry.texts)).toEqual([["raw (transformed)"]]);
	});

	/** Resolve with "timeout" when `promise` has not settled within `ms` (deadlock probe). */
	function within<T>(promise: Promise<T>, ms = 1000): Promise<T | "timeout"> {
		return Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
	}

	it("a deferred startup command that awaits ctx.reload() does not deadlock binding (review B finding 1)", async () => {
		const steps: string[] = [];
		const harness = await setup([
			(pi) => {
				pi.on("session_start", (event) => {
					steps.push(`start:${event.reason}`);
					if (event.reason === "startup") pi.sendUserMessage("/reload-test", { expandPromptTemplates: true });
				});
				pi.registerCommand("reload-test", {
					description: "reloads",
					handler: async (_args, ctx) => {
						steps.push("command");
						await ctx.reload();
						steps.push("command returned");
					},
				});
			},
		]);
		const session = harness.session;
		const bound = await within(
			session
				.bindExtensions({
					commandContextActions: {
						waitForIdle: () => session.waitForIdle(),
						newSession: async () => ({ cancelled: true }),
						fork: async () => ({ cancelled: true }),
						navigateTree: async () => ({ cancelled: true }),
						switchSession: async () => ({ cancelled: true }),
						reload: () => session.reload(),
					},
				})
				.then(() => "bound"),
		);
		expect(bound).toBe("bound");
		await vi.waitFor(() => expect(steps).toContain("command returned"));
		expect(steps).toEqual(["start:startup", "command", "start:reload", "command returned"]);
	});

	it("a deferred startup prompt whose input hook awaits the binder does not deadlock binding", async () => {
		const bound = deferred();
		const harness = await setup([
			(pi) => {
				pi.on("session_start", () => {
					pi.sendUserMessage("hello");
				});
				pi.on("input", async () => {
					await bound.promise;
					return { action: "continue" as const };
				});
			},
		]);
		const log = recordRequests(harness, 1);
		const result = await within(harness.session.bindExtensions({}).then(() => "bound"));
		expect(result).toBe("bound");
		bound.resolve();
		await vi.waitFor(() => expect(log).toHaveLength(1));
		await harness.session.waitForIdle();
		expect(log[0]!.texts).toEqual(["hello"]);
	});

	it("a start deferred by bind that then waits on a reload barrier no longer holds the bind (recheck R1)", async () => {
		const steps: string[] = [];
		let binding: Promise<void> = Promise.resolve();
		let reloadFinished = false;
		const harness = await setup([
			(pi) => {
				pi.on("session_start", async (event) => {
					steps.push(`start:${event.reason}`);
					if (event.reason === "startup") {
						pi.sendUserMessage("/r", { expandPromptTemplates: true });
						pi.sendUserMessage("second");
					} else {
						// A reload handler that waits for the original SDK bind to return.
						await binding;
						steps.push("initial bind returned");
					}
				});
				pi.registerCommand("r", {
					description: "reload",
					handler: async (_args, ctx) => {
						await ctx.reload();
						reloadFinished = true;
					},
				});
			},
		]);
		const session = harness.session;
		binding = session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async () => ({ cancelled: true }),
				fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }),
				switchSession: async () => ({ cancelled: true }),
				reload: () => session.reload(),
			},
		});
		expect(await within(binding.then(() => "bound"))).toBe("bound");
		await vi.waitFor(() => expect(reloadFinished).toBe(true));
		// The second start ran after the reload (the plain harness's faux provider does not survive a
		// reload, so the run itself ends in a provider error; only its start matters here).
		await vi.waitFor(() => expect(session.messages.some((m) => m.role === "assistant")).toBe(true));
		await session.waitForIdle();
		expect(steps).toEqual(["start:startup", "start:reload", "initial bind returned"]);
		expect(session.messages.filter((m) => m.role === "user").map((m) => getMessageText(m))).toEqual(["second"]);
	});

	it.each([
		["closeAdmission", (harness: Harness) => harness.session.closeAdmission()],
		["dispose", (harness: Harness) => harness.session.dispose()],
	])("after %s with no barrier, no command or input hook runs (recheck R4)", async (_label, close) => {
		let commands = 0;
		let inputs = 0;
		const harness = await setup([
			(pi) => {
				pi.registerCommand("x", {
					description: "x",
					handler: async () => {
						commands++;
					},
				});
				pi.on("input", () => {
					inputs++;
					return { action: "handled" as const };
				});
			},
		]);
		await harness.session.bindExtensions({});
		close(harness);
		const outcome = (promise: Promise<void>) =>
			promise.then(
				() => "resolved",
				(error: Error) => error.message,
			);
		expect(await outcome(harness.session.prompt("/x"))).toBe("prompt cancelled: session shutting down");
		expect(await outcome(harness.session.prompt("hello"))).toBe("prompt cancelled: session shutting down");
		expect(commands).toBe(0);
		expect(inputs).toBe(0);
	});

	it("dispose cancels a deferred startup prompt still in its async input hook; waitForDeferredPrompts settles (recheck R3)", async () => {
		const gate = deferred();
		const harness = await setup([
			(pi) => {
				pi.on("session_start", () => {
					pi.sendUserMessage("hello");
				});
				pi.on("input", async () => {
					await gate.promise;
					return { action: "continue" as const };
				});
			},
		]);
		const log = recordRequests(harness, 1);
		await harness.session.bindExtensions({});
		const drained = harness.session.waitForDeferredPrompts().then(() => "drained");
		await tick();
		expect(await within(drained, 50)).toBe("timeout");
		harness.session.dispose();
		gate.resolve();
		expect(await within(drained)).toBe("drained");
		expect(log).toHaveLength(0);
	});

	it.each([
		["closeAdmission", (harness: Harness) => harness.session.closeAdmission()],
		["dispose", (harness: Harness) => harness.session.dispose()],
	])(
		"%s while a prompt waits for readiness: no command or input hook runs (review B finding 2)",
		async (_label, close) => {
			const gate = deferred();
			let commands = 0;
			let inputs = 0;
			const harness = await setup([
				(pi) => {
					pi.on("session_start", () => gate.promise);
					pi.registerCommand("test", {
						description: "test",
						handler: async () => {
							commands++;
						},
					});
					pi.on("input", () => {
						inputs++;
						return { action: "continue" as const };
					});
				},
			]);
			const binding = harness.session.bindExtensions({});
			const command = harness.session.prompt("/test").then(
				() => "resolved",
				(error: Error) => error.message,
			);
			const text = harness.session.prompt("plain").then(
				() => "resolved",
				(error: Error) => error.message,
			);
			await tick();
			close(harness);
			gate.resolve();
			await binding.catch(() => {});
			expect(await command).toBe("prompt cancelled: session shutting down");
			expect(await text).toBe("prompt cancelled: session shutting down");
			expect(commands).toBe(0);
			expect(inputs).toBe(0);
		},
	);

	it("reload rejects while the first run is blocked in preflight", async () => {
		const gate = deferred();
		const harness = await setup([
			(pi) => {
				pi.on("before_agent_start", async () => {
					await gate.promise;
				});
			},
		]);
		await harness.session.bindExtensions({});
		recordRequests(harness, 1);

		const run = harness.session.prompt("hello");
		await tick();
		await expect(harness.session.reload()).rejects.toThrow(
			"Cannot reload while a run is active, compaction is running, or extensions are binding",
		);
		gate.resolve();
		await run;
	});

	it("a second reload or bind during a reload rejects, and a prompt waits for it", async () => {
		const gate = deferred();
		const starts: string[] = [];
		let reloadDone = false;
		const runStarts: boolean[] = [];
		const harness = await setup([
			(pi) => {
				pi.on("session_start", (event) => {
					starts.push(event.reason);
					if (event.reason === "reload") reloadDone = true;
				});
				pi.on("before_agent_start", () => {
					runStarts.push(reloadDone);
				});
			},
		]);
		await harness.session.bindExtensions({});

		const reload = harness.session.reload({ beforeSessionStart: () => gate.promise });
		await tick();
		await expect(harness.session.reload()).rejects.toThrow("Cannot reload");
		await expect(harness.session.bindExtensions({})).rejects.toThrow("Cannot bind extensions while");
		const run = harness.session.prompt("after reload");
		await tick();
		expect(runStarts).toEqual([]);
		gate.resolve();
		await reload;
		await run;
		expect(runStarts).toEqual([true]);
		expect(starts).toEqual(["startup", "reload"]);
	});

	it("a failed reload still releases waiting prompts", async () => {
		const gate = deferred();
		let runStarts = 0;
		const harness = await setup([
			(pi) => {
				pi.on("before_agent_start", () => {
					runStarts++;
				});
			},
		]);
		await harness.session.bindExtensions({});

		const reload = harness.session.reload({
			beforeSessionStart: async () => {
				await gate.promise;
				throw new Error("reload failed");
			},
		});
		const reloadResult = reload.catch((error: Error) => error.message);
		await tick();
		const run = harness.session.prompt("still runs");
		await tick();
		expect(runStarts).toBe(0);
		gate.resolve();
		expect(await reloadResult).toBe("reload failed");
		await run;
		expect(runStarts).toBe(1);
	});

	it.each([
		["bindExtensions({})", {}],
		["mode only", { mode: "json" as const }],
	])(
		"after %s a reload emits session_start(reload) and resources_discover once (recheck N2)",
		async (_label, bindings) => {
			const events: string[] = [];
			const harness = await setup([
				(pi) => {
					pi.on("session_start", (event) => {
						events.push(`session_start:${event.reason}`);
					});
					pi.on("resources_discover", (event) => {
						events.push(`resources_discover:${event.reason}`);
						return {};
					});
				},
			]);
			await harness.session.bindExtensions(bindings);
			await harness.session.reload();

			expect(events).toEqual([
				"session_start:startup",
				"resources_discover:startup",
				"session_start:reload",
				"resources_discover:reload",
			]);
		},
	);

	it("after bindExtensions({}) an extension re-stages the instruction the reload dropped (recheck N2)", async () => {
		const commits: string[] = [];
		const runtime = await createRuntimeHarness((pi) => {
			pi.on("session_start", (event) => {
				pi.queueDeveloperMessage(`policy:${event.reason}`, { onCommit: () => commits.push(event.reason) });
			});
		});
		try {
			const requests: string[][] = [];
			runtime.faux.setResponses([
				(context) => {
					requests.push(context.messages.map((message) => `${message.role}:${getMessageText(message)}`));
					return fauxAssistantMessage("ok");
				},
			]);
			await runtime.runtime.session.reload();
			await runtime.runtime.session.prompt("go");
			expect(requests[0]?.filter((line) => line.startsWith("developer:"))).toEqual(["developer:policy:reload"]);
			expect(commits).toEqual(["reload"]);
		} finally {
			await runtime.cleanup();
		}
	});

	it("a never-bound SDK session keeps its staged extension instruction across reload, without onCommit", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await setup([
			(pi) => {
				api = pi;
			},
		]);
		const onCommit = vi.fn();
		const staged = api!.queueDeveloperMessage("kept", { onCommit });
		expect(staged.status).toBe("staged");
		await harness.session.reload();
		await harness.session.prompt("go").catch(() => {});
		const developers = harness.sessionManager
			.buildSessionProjection()
			.messages.filter((message) => message.role === "developer")
			.map((message) => getMessageText(message));
		expect(developers).toEqual(["kept"]);
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("a never-bound SDK session reloads without session_start and has no barrier", async () => {
		const events: string[] = [];
		const harness = await setup([
			(pi) => {
				pi.on("session_start", (event) => {
					events.push(event.reason);
				});
			},
		]);
		await harness.session.reload();
		expect(events).toEqual([]);
		// No barrier: a prompt right after the reload starts at once.
		let started = false;
		harness.session.subscribe((event) => {
			if (event.type === "agent_start") started = true;
		});
		await harness.session.prompt("plain");
		expect(started).toBe(true);
	});

	describe("with real resources and modes", () => {
		const cleanups: Array<() => Promise<void> | void> = [];

		afterEach(async () => {
			vi.restoreAllMocks();
			while (cleanups.length > 0) await cleanups.pop()?.();
		});

		function createSkillDir(): string {
			const root = mkdtempSync(join(tmpdir(), "pi-readiness-skills-"));
			mkdirSync(join(root, "demo"), { recursive: true });
			writeFileSync(join(root, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nSKILL BODY\n");
			cleanups.push(() => rmSync(root, { recursive: true, force: true }));
			return root;
		}

		/**
		 * Sol's trace: an early session_start starts a run (a `/skill:` prompt), a later one blocks and then
		 * registers a tool, and resources_discover adds the skill. `reason` selects the startup or reload pass.
		 */
		function solTrace(gate: Deferred, skillsDir: string, reason: "startup" | "reload") {
			return (pi: ExtensionAPI) => {
				pi.on("session_start", (event) => {
					if (event.reason === reason) pi.sendUserMessage("/skill:demo please", { expandPromptTemplates: true });
				});
				pi.on("session_start", async (event) => {
					if (event.reason !== reason) return;
					await gate.promise;
					pi.registerTool(lateTool(`late_${reason}`));
				});
				pi.on("resources_discover", (event) => (event.reason === reason ? { skillPaths: [skillsDir] } : {}));
			};
		}

		interface WireRequest {
			tools: string[];
			systemText: string;
			userTexts: string[];
		}

		function recordWire(): { requests: WireRequest[]; factory: () => FauxResponseFactory } {
			const requests: WireRequest[] = [];
			const factory = (): FauxResponseFactory => (context: Context) => {
				const systems = context.messages.filter((message) => message.role === "system");
				requests.push({
					tools: (getCurrentSystemMessage(context.messages)?.toolsAdded ?? []).map((tool) => tool.name),
					systemText: JSON.stringify(systems),
					userTexts: context.messages.filter((m) => m.role === "user").map((m) => getMessageText(m)),
				});
				return fauxAssistantMessage("ok");
			};
			return { requests, factory };
		}

		function expectReadyRequest(request: WireRequest | undefined, tool: string) {
			expect(request?.tools).toContain(tool);
			expect(request?.systemText).toContain("Demo skill");
			// The skill discovered after the sender expanded the startup-triggered prompt.
			expect(request?.userTexts.at(-1)).toContain("SKILL BODY");
		}

		it("SDK: the startup run waits for the late tool and the skill discovered later in binding", async () => {
			const gate = deferred();
			const skillsDir = createSkillDir();
			const harness: RuntimeHarness = await createRuntimeHarness(solTrace(gate, skillsDir, "startup"), {
				bind: false,
			});
			cleanups.push(() => harness.cleanup());
			const { requests, factory } = recordWire();
			harness.faux.setResponses([factory()]);

			const binding = harness.runtime.session.bindExtensions({});
			await tick();
			expect(requests).toHaveLength(0);
			gate.resolve();
			await binding;
			await vi.waitFor(() => expect(requests).toHaveLength(1));
			await harness.runtime.session.waitForIdle();

			expectReadyRequest(requests[0], "late_startup");
			const snapshot = harness.runtime.session.sessionManager.buildSessionProjection().messages[0];
			expect(snapshot?.role === "system" && snapshot.toolsAdded?.map((tool) => tool.name)).toContain("late_startup");
		});

		it("SDK reload: a run started by session_start(reload) waits for the reload's tool and skill", async () => {
			const gate = deferred();
			const skillsDir = createSkillDir();
			const harness: RuntimeHarness = await createRuntimeHarness(solTrace(gate, skillsDir, "reload"));
			cleanups.push(() => harness.cleanup());
			const { requests, factory } = recordWire();
			harness.faux.setResponses([fauxAssistantMessage("first"), factory()]);
			await harness.runtime.session.prompt("first");

			const reload = harness.runtime.session.reload();
			await tick();
			expect(requests).toHaveLength(0);
			gate.resolve();
			await reload;
			await vi.waitFor(() => expect(requests).toHaveLength(1));
			await harness.runtime.session.waitForIdle();

			expectReadyRequest(requests[0], "late_reload");
		});

		it("print mode (real runtime): the startup run waits for binding, completes and is printed before disposal", async () => {
			const gate = deferred();
			const skillsDir = createSkillDir();
			const harness: RuntimeHarness = await createRuntimeHarness(solTrace(gate, skillsDir, "startup"), {
				bind: false,
			});
			cleanups.push(() => harness.cleanup());
			const { requests, factory } = recordWire();
			harness.faux.setResponses([factory()]);
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			rpcIo.outputLines.length = 0;
			const session = harness.runtime.session;

			const printing = runPrintMode(harness.runtime, { mode: "text", messages: [] });
			await tick();
			expect(requests).toHaveLength(0);
			gate.resolve();
			expect(await printing).toBe(0);

			// The real runtime disposed the session: the run had already completed, it was not cancelled.
			expect(requests).toHaveLength(1);
			expectReadyRequest(requests[0], "late_startup");
			expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
			expect(rpcIo.outputLines).toEqual(["ok\n"]);
		});

		it("print mode (real runtime): a startup run completes before the CLI message runs", async () => {
			const harness: RuntimeHarness = await createRuntimeHarness(
				(pi) => {
					pi.on("session_start", () => pi.sendUserMessage("from startup"));
				},
				{ bind: false },
			);
			cleanups.push(() => harness.cleanup());
			const { requests, factory } = recordWire();
			harness.faux.setResponses([factory(), factory()]);
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			rpcIo.outputLines.length = 0;

			expect(await runPrintMode(harness.runtime, { mode: "text", messages: ["from cli"] })).toBe(0);
			expect(requests.map((request) => request.userTexts)).toEqual([["from startup"], ["from startup", "from cli"]]);
			expect(rpcIo.outputLines).toEqual(["ok\n"]);
		});

		it.each(["input", "auth"] as const)(
			"print mode (real runtime): a startup prompt with async %s preflight completes before disposal (recheck R3)",
			async (kind) => {
				const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
				const harness: RuntimeHarness = await createRuntimeHarness(
					(pi) => {
						pi.on("session_start", () => pi.sendUserMessage("hello"));
						if (kind === "input") {
							pi.on("input", async () => {
								await sleep(50);
								return { action: "continue" as const };
							});
						}
					},
					{ bind: false },
				);
				cleanups.push(() => harness.cleanup());
				if (kind === "auth") {
					const modelRuntime = (
						harness.runtime.session as unknown as {
							_modelRuntime: { hasConfiguredAuth: () => boolean; checkAuth: () => Promise<string> };
						}
					)._modelRuntime;
					modelRuntime.hasConfiguredAuth = () => false;
					modelRuntime.checkAuth = async () => {
						await sleep(50);
						return "test-key";
					};
				}
				const { requests, factory } = recordWire();
				harness.faux.setResponses([factory()]);
				vi.spyOn(process.stderr, "write").mockImplementation(() => true);
				rpcIo.outputLines.length = 0;
				const session = harness.runtime.session;

				expect(await runPrintMode(harness.runtime, { mode: "text", messages: [] })).toBe(0);
				expect(requests.map((request) => request.userTexts)).toEqual([["hello"]]);
				expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
				expect(rpcIo.outputLines).toEqual(["ok\n"]);
			},
		);

		async function rpcSetup(
			extensionFactory: (pi: ExtensionAPI) => void,
			initialResponses?: FauxResponseFactory[],
		): Promise<RpcHarness> {
			const harness = await createRpcHarness(rpcIo, { extensionFactory, initialResponses });
			cleanups.push(() => harness.cleanup());
			return harness;
		}

		it("RPC: the startup run waits for binding to finish", async () => {
			const gate = deferred();
			const skillsDir = createSkillDir();
			const { requests, factory } = recordWire();
			const created = rpcSetup(solTrace(gate, skillsDir, "startup"), [factory()]);
			await tick();
			expect(requests).toHaveLength(0);
			gate.resolve();
			const harness = await created;
			await vi.waitFor(() => expect(requests).toHaveLength(1));
			await harness.runtime.session.waitForIdle();

			expectReadyRequest(requests[0], "late_startup");
		});

		it("RPC reload from a command: the reload's startup run waits for the reload to finish", async () => {
			const gate = deferred();
			const skillsDir = createSkillDir();
			const { requests, factory } = recordWire();
			const harness = await rpcSetup((pi) => {
				solTrace(gate, skillsDir, "reload")(pi);
				pi.registerCommand("reload-now", {
					description: "reload",
					handler: async (_args, ctx) => {
						await ctx.reload();
					},
				});
			});
			harness.faux.setResponses([factory()]);

			harness.send({ id: "r1", type: "prompt", message: "/reload-now" });
			await tick();
			expect(requests).toHaveLength(0);
			gate.resolve();
			await harness.waitForResponse("r1");
			await vi.waitFor(() => expect(requests).toHaveLength(1));
			await harness.runtime.session.waitForIdle();

			expectReadyRequest(requests[0], "late_reload");
		});

		it("RPC command context: reload rejects while the first run is blocked in preflight", async () => {
			const gate = deferred();
			const harness = await rpcSetup((pi) => {
				pi.on("before_agent_start", async () => {
					await gate.promise;
				});
				pi.registerCommand("reload-now", {
					description: "reload",
					handler: async (_args, ctx) => {
						await ctx.reload();
					},
				});
			});
			harness.faux.setResponses([fauxAssistantMessage("ok")]);

			harness.send({ id: "p1", type: "prompt", message: "hello" });
			await tick();
			harness.send({ id: "r1", type: "prompt", message: "/reload-now" });
			await harness.waitForResponse("r1");
			await vi.waitFor(() =>
				expect(
					harness
						.records()
						.some(
							(record) =>
								record.type === "extension_error" &&
								String(record.error).includes(
									"Cannot reload while a run is active, compaction is running, or extensions are binding",
								),
						),
				).toBe(true),
			);
			gate.resolve();
			await harness.waitForResponse("p1");
			await harness.runtime.session.waitForIdle();
			expect(harness.faux.state.callCount).toBe(1);
		});
	});

	it("reload rejects while compacting", async () => {
		const gate = deferred();
		let compacting = false;
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						compacting = true;
						await gate.promise;
						return { cancel: true };
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		recordRequests(harness, 2);
		await harness.session.prompt("hello");
		await harness.session.prompt("again");

		const compaction = harness.session.compact().catch(() => {});
		await vi.waitFor(() => expect(compacting).toBe(true));
		expect(harness.session.isCompacting).toBe(true);
		await expect(harness.session.reload()).rejects.toThrow(
			"Cannot reload while a run is active, compaction is running, or extensions are binding",
		);
		gate.resolve();
		await compaction;
		await expect(harness.session.reload()).resolves.toBeUndefined();
	});
});
