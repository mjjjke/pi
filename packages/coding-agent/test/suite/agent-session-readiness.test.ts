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

		it("print mode: the startup run waits for binding to finish", async () => {
			const gate = deferred();
			const skillsDir = createSkillDir();
			const harness: RuntimeHarness = await createRuntimeHarness(solTrace(gate, skillsDir, "startup"), {
				bind: false,
			});
			cleanups.push(() => harness.cleanup());
			const { requests, factory } = recordWire();
			harness.faux.setResponses([factory()]);
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const runtime = harness.runtime;
			// The host keeps the runtime for cleanup; disposing waits for the startup run to settle.
			const host = {
				get session() {
					return runtime.session;
				},
				newSession: vi.fn(async () => ({ cancelled: true })),
				fork: vi.fn(async () => ({ cancelled: true })),
				switchSession: vi.fn(async () => ({ cancelled: true })),
				dispose: vi.fn(async () => {
					await runtime.session.waitForIdle();
				}),
				setRebindSession: vi.fn(),
			};

			const printing = runPrintMode(host as unknown as Parameters<typeof runPrintMode>[0], {
				mode: "text",
				messages: [],
			});
			await tick();
			expect(requests).toHaveLength(0);
			gate.resolve();
			expect(await printing).toBe(0);
			await runtime.session.waitForIdle();

			expect(requests).toHaveLength(1);
			expectReadyRequest(requests[0], "late_startup");
		});

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
