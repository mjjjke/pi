import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
	buildForkSelfUpdatePrompt,
	detectForkSelfUpdatePlan,
	runForkSelfUpdateAgent,
} from "../src/utils/fork-self-update.ts";

function runGitFrom(responses: Map<string, { status: number | null; stdout: string }>) {
	return (args: string[], cwd: string): { status: number | null; stdout: string } => {
		return responses.get(`${cwd}\0${args.join("\0")}`) ?? { status: 1, stdout: "" };
	};
}

function fakeChildProcess(exitCode: number): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	queueMicrotask(() => child.emit("close", exitCode, null));
	return child;
}

describe("fork self-update", () => {
	it("detects a linked fork with an upstream remote", () => {
		const responses = new Map<string, { status: number | null; stdout: string }>([
			["/repo/packages/coding-agent\0rev-parse\0--show-toplevel", { status: 0, stdout: "/repo" }],
			["/repo\0remote\0get-url\0upstream", { status: 0, stdout: "git@github.com:earendil-works/pi-mono.git" }],
		]);

		const plan = detectForkSelfUpdatePlan({
			packageDir: "/repo/packages/coding-agent",
			runGit: runGitFrom(responses),
			env: {},
		});

		expect(plan?.repoRoot).toBe("/repo");
		expect(plan?.prompt).toContain("Update this local pi fork from upstream.");
		expect(plan?.prompt).toContain("Repository root: /repo");
		expect(plan?.prompt).toContain("git fetch upstream --tags");
		expect(plan?.prompt).toContain("Do not rebase onto `upstream/main`");
	});

	it("does not detect a fork outside a git worktree", () => {
		const plan = detectForkSelfUpdatePlan({
			packageDir: "/repo/packages/coding-agent",
			runGit: () => ({ status: 1, stdout: "" }),
			env: {},
		});

		expect(plan).toBeUndefined();
	});

	it("does not detect a fork without upstream", () => {
		const responses = new Map<string, { status: number | null; stdout: string }>([
			["/repo/packages/coding-agent\0rev-parse\0--show-toplevel", { status: 0, stdout: "/repo" }],
			["/repo\0remote\0get-url\0upstream", { status: 1, stdout: "" }],
		]);

		const plan = detectForkSelfUpdatePlan({
			packageDir: "/repo/packages/coding-agent",
			runGit: runGitFrom(responses),
			env: {},
		});

		expect(plan).toBeUndefined();
	});

	it("respects recursion guard and opt-out environment flags", () => {
		const runGit = () => ({ status: 0, stdout: "/repo" });

		expect(
			detectForkSelfUpdatePlan({
				packageDir: "/repo/packages/coding-agent",
				runGit,
				env: { PI_FORK_UPDATE_AGENT: "1" },
			}),
		).toBeUndefined();
		expect(
			detectForkSelfUpdatePlan({
				packageDir: "/repo/packages/coding-agent",
				runGit,
				env: { PI_DISABLE_FORK_UPDATE_AGENT: "1" },
			}),
		).toBeUndefined();
	});

	it("builds the nested print-mode command with inherited stdio and guard env", async () => {
		const calls: Array<{
			command: string;
			args: string[];
			options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" };
		}> = [];

		const exitCode = await runForkSelfUpdateAgent({
			repoRoot: "/repo",
			prompt: buildForkSelfUpdatePrompt("/repo"),
			execPath: "/node",
			entrypoint: "/repo/packages/coding-agent/dist/cli.js",
			env: { EXISTING: "1" },
			spawn: (command, args, options) => {
				calls.push({ command, args, options });
				return fakeChildProcess(7);
			},
		});

		expect(exitCode).toBe(7);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.command).toBe("/node");
		expect(calls[0]?.args[0]).toBe("/repo/packages/coding-agent/dist/cli.js");
		expect(calls[0]?.args).toEqual([
			"/repo/packages/coding-agent/dist/cli.js",
			"--print",
			"--model",
			"openai-codex/gpt-5.5",
			"--thinking",
			"low",
			"--no-extensions",
			"--no-skills",
			"--tools",
			"read,bash,edit,write",
			expect.stringContaining("Do not call `pi update`"),
		]);
		expect(calls[0]?.options.cwd).toBe("/repo");
		expect(calls[0]?.options.stdio).toBe("inherit");
		expect(calls[0]?.options.env.PI_FORK_UPDATE_AGENT).toBe("1");
		expect(calls[0]?.options.env.PI_SKIP_VERSION_CHECK).toBe("1");
		expect(calls[0]?.options.env.EXISTING).toBe("1");
	});
});
