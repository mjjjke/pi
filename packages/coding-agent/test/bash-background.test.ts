import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BashBackgroundEvent, ExtensionToolContext } from "../src/core/extensions/types.ts";
import {
	type BashOperations,
	createBashTool,
	createBashToolDefinition,
	createShellToolDefinition,
} from "../src/core/tools/bash.ts";
import { createPowerShellTool, createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { getShellConfig } from "../src/utils/shell.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Operations that record every exec instead of spawning. */
function spyOperations(): BashOperations & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		exec: async (command) => {
			calls.push(command);
			return { exitCode: 0 };
		},
	};
}

/** Run a spawn description the way a background executor would, and collect its stdout. */
function runSpawn(event: BashBackgroundEvent): Promise<string> {
	const shell = event.spawn.shell;
	if (!shell) throw new Error("no local shell in the event");
	const viaStdin = shell.commandTransport === "stdin";
	const child = spawn(shell.shell, viaStdin ? shell.args : [...shell.args, event.spawn.command], {
		cwd: event.spawn.cwd,
		env: event.spawn.env,
		stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
	});
	if (viaStdin) child.stdin?.end(event.spawn.command);
	let out = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", () => resolve(out));
	});
}

function fakeCtx(cwd: string): ExtensionToolContext {
	return {
		cwd,
		model: { provider: "test-provider", id: "test-model" },
		thinkingLevel: "high",
		sessionManager: { getSessionId: () => "session-123", getSessionFile: () => "/tmp/session-123.jsonl" },
	} as unknown as ExtensionToolContext;
}

describe("bash run_in_background", () => {
	let testDir: string;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		testDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-bash-background-")));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("declares run_in_background, notify_on and description in the static schema of bash and powershell", () => {
		for (const definition of [createBashToolDefinition(testDir), createPowerShellToolDefinition(testDir)]) {
			const properties = definition.parameters.properties;
			expect(properties.run_in_background.type).toBe("boolean");
			expect(properties.notify_on.type).toBe("string");
			expect(properties.description.type).toBe("string");
			expect(definition.parameters.required).toEqual(["command"]);
		}
		// Static: the declaration does not depend on whether a background handler exists.
		const withHandler = createBashToolDefinition(testDir, { onBackground: () => {} });
		const without = createBashToolDefinition(testDir);
		expect(withHandler.parameters).toBe(without.parameters);
		expect(withHandler.description).toBe(without.description);
	});

	it("does not emit the event for foreground calls, which run exactly as before", async () => {
		const events: BashBackgroundEvent[] = [];
		const bash = createBashTool(testDir, { onBackground: (event) => void events.push(event) });
		const result = await bash.execute("fg", { command: "echo hello", run_in_background: false, description: "say" });
		expect(textOf(result)).toBe("hello\n");
		expect(events).toEqual([]);
	});

	it("returns the claimed result and spawns nothing", async () => {
		const ops = spyOperations();
		const events: BashBackgroundEvent[] = [];
		const bash = createBashTool(testDir, {
			operations: ops,
			onBackground: (event) => {
				events.push(event);
				expect(event.claimed).toBe(false);
				event.claim({ content: [{ type: "text", text: "started shell-1" }], details: { fullOutputPath: "/x" } });
				expect(event.claimed).toBe(true);
			},
		});
		const result = await bash.execute("bg-1", {
			command: "npm run dev",
			run_in_background: true,
			notify_on: "ready",
			description: "dev server",
		});
		expect(textOf(result)).toBe("started shell-1");
		expect(result.details).toEqual({ fullOutputPath: "/x" });
		expect(ops.calls).toEqual([]);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "bash_background",
			toolCallId: "bg-1",
			toolName: "bash",
			command: "npm run dev",
			notifyOn: "ready",
			description: "dev server",
		});
	});

	it("rejects a second claim and a claim after the handler settled", async () => {
		let late: BashBackgroundEvent | undefined;
		const bash = createBashTool(testDir, {
			onBackground: (event) => {
				late = event;
				event.claim({ content: [{ type: "text", text: "first" }] });
				expect(() => event.claim({ content: [{ type: "text", text: "second" }] })).toThrow(/already claimed/);
			},
		});
		const result = await bash.execute("bg-2", { command: "true", run_in_background: true });
		expect(textOf(result)).toBe("first");
		expect(() => late!.claim({ content: [{ type: "text", text: "late" }] })).toThrow(/already/);
	});

	it("fails without spawning when nobody claims the call", async () => {
		const marker = join(testDir, "spawned");
		for (const options of [{}, { onBackground: () => {} }]) {
			const bash = createBashTool(testDir, options);
			await expect(
				bash.execute("unclaimed", { command: `touch ${marker}`, run_in_background: true }),
			).rejects.toThrow(/Background execution is not available/);
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(existsSync(marker)).toBe(false);
	});

	it("fails the call with the handler's error and spawns nothing", async () => {
		const ops = spyOperations();
		const bash = createBashTool(testDir, {
			operations: ops,
			onBackground: () => {
				throw new Error("Invalid notify_on regular expression: nope");
			},
		});
		await expect(bash.execute("bad", { command: "true", run_in_background: true, notify_on: "(" })).rejects.toThrow(
			"Invalid notify_on regular expression: nope",
		);
		expect(ops.calls).toEqual([]);
	});

	it("rejects notify_on without run_in_background before spawning", async () => {
		const ops = spyOperations();
		const events: BashBackgroundEvent[] = [];
		const bash = createBashTool(testDir, { operations: ops, onBackground: (event) => void events.push(event) });
		await expect(bash.execute("fg-notify", { command: "true", notify_on: "ready" })).rejects.toThrow(
			/notify_on requires run_in_background: true/,
		);
		expect(ops.calls).toEqual([]);
		expect(events).toEqual([]);
	});

	it("ignores timeout for background calls", async () => {
		let event: BashBackgroundEvent | undefined;
		const bash = createBashTool(testDir, {
			onBackground: (e) => {
				event = e;
				e.claim({ content: [{ type: "text", text: "ok" }] });
			},
		});
		// Even an invalid timeout: it does not apply to a background call.
		const result = await bash.execute("bg-timeout", { command: "sleep 1", run_in_background: true, timeout: -1 });
		expect(textOf(result)).toBe("ok");
		expect(event).toBeDefined();
		expect("timeout" in event!).toBe(false);
	});

	it("describes the same spawn as a foreground call: prefix, spawn hook, session env and shell", async () => {
		const sub = join(testDir, "sub");
		mkdirSync(sub);
		const spawnHook = (context: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => ({
			command: `${context.command}\necho hooked`,
			cwd: sub,
			env: { ...context.env, HOOK_VAR: "from-hook" },
		});
		const command =
			'echo "prefix=$PREFIX_VAR hook=$HOOK_VAR session=$PI_SESSION_ID model=$PI_MODEL level=$PI_REASONING_LEVEL"; pwd';
		const options = { commandPrefix: "export PREFIX_VAR=from-prefix", spawnHook, shellPath: "/bin/bash" };

		const foreground = createBashToolDefinition(testDir, options);
		const fgResult = await foreground.execute("fg", { command }, undefined, undefined, fakeCtx(testDir));

		let event: BashBackgroundEvent | undefined;
		const background = createBashToolDefinition(testDir, {
			...options,
			onBackground: (e) => {
				event = e;
				e.claim({ content: [{ type: "text", text: "claimed" }] });
			},
		});
		await background.execute("bg", { command, run_in_background: true }, undefined, undefined, fakeCtx(testDir));
		expect(event).toBeDefined();
		expect(event!.command).toBe(command);
		expect(event!.spawn.command).toBe(`export PREFIX_VAR=from-prefix\n${command}\necho hooked`);
		expect(event!.spawn.cwd).toBe(sub);
		expect(event!.spawn.env.HOOK_VAR).toBe("from-hook");
		expect(event!.spawn.env.PI_SESSION_ID).toBe("session-123");
		expect(event!.spawn.shell).toEqual(getShellConfig("/bin/bash"));

		const bgOutput = await runSpawn(event!);
		expect(bgOutput).toBe(textOf(fgResult));
		expect(bgOutput).toBe(
			`prefix=from-prefix hook=from-hook session=session-123 model=test-model level=high\n${sub}\nhooked\n`,
		);
	});

	it("omits the shell when custom operations run commands", async () => {
		let event: BashBackgroundEvent | undefined;
		const bash = createBashTool(testDir, {
			operations: spyOperations(),
			onBackground: (e) => {
				event = e;
				e.claim({ content: [{ type: "text", text: "ok" }] });
			},
		});
		await bash.execute("bg-remote", { command: "true", run_in_background: true });
		expect(event!.spawn.shell).toBeUndefined();
	});

	it("rejects run_in_background for powershell without spawning", async () => {
		const ops = spyOperations();
		const powershell = createPowerShellTool(testDir, { operations: ops });
		await expect(powershell.execute("ps", { command: "Get-Date", run_in_background: true })).rejects.toThrow(
			/Background execution is not available/,
		);
		expect(ops.calls).toEqual([]);
	});

	it("passes the call's abort signal and refuses a claimed result once the call is aborted", async () => {
		const controller = new AbortController();
		let seen: AbortSignal | undefined;
		const bash = createBashTool(testDir, {
			onBackground: async (event) => {
				seen = event.signal;
				// An earlier (async) handler runs while the call is cancelled...
				await new Promise((resolve) => setTimeout(resolve, 10));
				controller.abort();
				// ...and a claim made anyway is not returned as a normal result.
				event.claim({ content: [{ type: "text", text: "started anyway" }] });
			},
		});
		await expect(
			bash.execute("bg-abort", { command: "true", run_in_background: true }, controller.signal),
		).rejects.toThrow("Command aborted");
		expect(seen).toBe(controller.signal);
	});

	it("gives the event a signal that never aborts when the call has none", async () => {
		let seen: AbortSignal | undefined;
		const bash = createBashTool(testDir, {
			onBackground: (event) => {
				seen = event.signal;
				event.claim({ content: [{ type: "text", text: "ok" }] });
			},
		});
		await bash.execute("bg-no-signal", { command: "true", run_in_background: true });
		expect(seen).toBeInstanceOf(AbortSignal);
		expect(seen!.aborted).toBe(false);
	});

	it("closes the dispatch when a handler throws: a saved claim fails afterwards", async () => {
		let saved: BashBackgroundEvent | undefined;
		const bash = createBashTool(testDir, {
			onBackground: (event) => {
				saved = event;
				throw new Error("handler failed");
			},
		});
		await expect(bash.execute("bg-throw", { command: "true", run_in_background: true })).rejects.toThrow(
			"handler failed",
		);
		expect(() => saved!.claim({ content: [{ type: "text", text: "late" }] })).toThrow(/already settled/);
	});

	it("only emits for the bash tool config, whatever options a shell tool gets", async () => {
		const ops = spyOperations();
		const events: BashBackgroundEvent[] = [];
		const other = createShellToolDefinition(
			testDir,
			{
				name: "zsh",
				label: "zsh",
				shellName: "zsh",
				prompt: "%",
				promptSnippet: "zsh",
				tempFilePrefix: "pi-zsh",
			},
			{ operations: ops, exposeSessionEnvironment: false, onBackground: (event) => void events.push(event) },
		);
		await expect(
			other.execute("zsh-bg", { command: "true", run_in_background: true }, undefined, undefined, {} as never),
		).rejects.toThrow(/Background execution is not available/);
		expect(events).toEqual([]);
		expect(ops.calls).toEqual([]);
	});

	it("fails like a foreground call when the working directory does not exist, before dispatch", async () => {
		const missing = join(testDir, "missing");
		const events: BashBackgroundEvent[] = [];
		const bash = createBashToolDefinition(testDir, {
			exposeSessionEnvironment: false,
			onBackground: (event) => void events.push(event),
		});
		const ctx = { cwd: missing } as never;
		await expect(
			bash.execute("bg-missing-cwd", { command: "true", run_in_background: true }, undefined, undefined, ctx),
		).rejects.toThrow(`Working directory does not exist: ${missing}\nCannot execute bash commands.`);
		await expect(bash.execute("fg-missing-cwd", { command: "true" }, undefined, undefined, ctx)).rejects.toThrow(
			`Working directory does not exist: ${missing}\nCannot execute bash commands.`,
		);
		expect(events).toEqual([]);
	});

	it("tags background calls in the call row and hides the ignored timeout", () => {
		const definition = createBashToolDefinition(testDir);
		const render = (args: Record<string, unknown>) => {
			const component = definition.renderCall!(
				args as never,
				{} as never,
				{
					state: { startedAt: undefined, endedAt: undefined, interval: undefined },
					executionStarted: false,
					lastComponent: undefined,
				} as never,
			) as Text;
			return stripAnsi(component.render(200).join("\n")).trim();
		};
		expect(render({ command: "npm run dev", run_in_background: true, timeout: 120, description: "dev server" })).toBe(
			"$ npm run dev [background] dev server",
		);
		expect(render({ command: "ls", timeout: 5 })).toBe("$ ls (timeout 5s)");
		expect(render({ command: "ls", description: "list" })).toBe("$ ls list");
	});
});
