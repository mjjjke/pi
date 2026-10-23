import { type FauxResponseFactory, fauxAssistantMessage, getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

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
});
