import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	buildForkSelfUpdatePrompt,
	detectForkSelfUpdatePlan,
	runForkSelfUpdateAgent,
} from "../src/utils/fork-self-update.ts";
import type { ForkGitRunner, VerifiedForkUpdate } from "../src/utils/fork-update-release.ts";

const update: VerifiedForkUpdate = {
	repoRoot: "/repo",
	baseSha: "a".repeat(40),
	upstreamRepository: "earendil-works/pi",
	release: {
		version: "0.88.0",
		tag: "v0.88.0",
		commit: "b".repeat(40),
		url: "https://github.com/earendil-works/pi/releases/tag/v0.88.0",
	},
};

const cleanMain: ForkGitRunner = (args) => {
	switch (args[0]) {
		case "symbolic-ref":
			return { status: 0, stdout: "main" };
		case "status":
			return { status: 0, stdout: "" };
		case "rev-parse":
			return args.includes("MERGE_HEAD") ? { status: 1, stdout: "" } : { status: 0, stdout: update.baseSha };
		default:
			throw new Error(`Unexpected git command: ${args.join(" ")}`);
	}
};

function runGitFrom(responses: Map<string, { status: number | null; stdout: string }>): ForkGitRunner {
	return (args, cwd) => responses.get(`${cwd}\0${args.join("\0")}`) ?? { status: 1, stdout: "" };
}

function fakeChildProcess(exitCode: number): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	queueMicrotask(() => child.emit("close", exitCode, null));
	return child;
}

describe("fork self-update", () => {
	it("detects a linked fork without selecting a release or building an unverified prompt", () => {
		const responses = new Map([
			["/repo/packages/coding-agent\0rev-parse\0--show-toplevel", { status: 0, stdout: "/repo" }],
			["/repo\0remote\0get-url\0upstream", { status: 0, stdout: "git@github.com:earendil-works/pi.git" }],
		]);
		expect(
			detectForkSelfUpdatePlan({
				packageDir: "/repo/packages/coding-agent",
				runGit: runGitFrom(responses),
				env: {},
			}),
		).toEqual({ repoRoot: "/repo" });
	});

	it("pins the published release and starts the candidate from our main, not upstream", () => {
		const prompt = buildForkSelfUpdatePrompt(update);
		expect(prompt).toContain(JSON.stringify(update, null, 2));
		expect(prompt).toContain(`from the pinned local main commit ${update.baseSha}`);
		expect(prompt).toContain(`git merge --no-ff --no-commit ${update.release.commit}`);
		expect(prompt).toContain(`git diff ${update.release.commit} --stat`);
		expect(prompt).toContain("Do not choose another release");
		expect(prompt).toContain("Never start from the release tag or replay the fork patch series");
		expect(prompt).toContain("Read FORK.md");
		expect(prompt).toContain("Preserve functionality; ask before removing or replacing intentional behavior");
		expect(prompt).toContain("candidate validated; activation pending");
		expect(prompt).toContain("candidate incomplete");
		expect(prompt).toContain("candidate sources, not stale dist files");
		expect(prompt).toContain("staged and unstaged changes");
		expect(prompt).toContain("Do not commit unless the user separately requested it");
		expect(prompt).toContain("Do not rebase the original branch");
		expect(prompt).toContain("Build, promotion, publication, and relinking require the user's explicit request");
		expect(prompt).not.toContain("git fetch upstream --tags");
	});

	it("does not detect a fork outside a git worktree or without upstream", () => {
		expect(
			detectForkSelfUpdatePlan({
				packageDir: "/repo/packages/coding-agent",
				runGit: () => ({ status: 1, stdout: "" }),
				env: {},
			}),
		).toBeUndefined();
		const responses = new Map([
			["/repo/packages/coding-agent\0rev-parse\0--show-toplevel", { status: 0, stdout: "/repo" }],
		]);
		expect(
			detectForkSelfUpdatePlan({
				packageDir: "/repo/packages/coding-agent",
				runGit: runGitFrom(responses),
				env: {},
			}),
		).toBeUndefined();
	});

	it("respects recursion guard and opt-out environment flags", () => {
		const runGit = vi.fn(() => ({ status: 0, stdout: "/repo" }));
		for (const env of [{ PI_FORK_UPDATE_AGENT: "1" }, { PI_DISABLE_FORK_UPDATE_AGENT: "1" }]) {
			expect(detectForkSelfUpdatePlan({ packageDir: "/repo/packages/coding-agent", runGit, env })).toBeUndefined();
		}
		expect(runGit).not.toHaveBeenCalled();
	});

	it("builds the nested print-mode command with inherited stdio and guard env", async () => {
		const spawn = vi.fn(() => fakeChildProcess(7));
		const prompt = buildForkSelfUpdatePrompt(update);
		const exitCode = await runForkSelfUpdateAgent({
			...update,
			prompt,
			runGit: cleanMain,
			execPath: "/node",
			entrypoint: "/repo/packages/coding-agent/dist/cli.js",
			env: { EXISTING: "1", GIT_EDITOR: "code --wait" },
			spawn,
		});
		expect(exitCode).toBe(7);
		expect(spawn).toHaveBeenCalledExactlyOnceWith(
			"/node",
			[
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
				prompt,
			],
			{
				cwd: "/repo",
				stdio: "inherit",
				env: expect.objectContaining({
					GIT_EDITOR: "true",
					PI_FORK_UPDATE_AGENT: "1",
					PI_SKIP_VERSION_CHECK: "1",
					EXISTING: "1",
				}),
			},
		);
	});

	it.each(["advanced", "dirty", "branch"])("does not spawn if main became %s after verification", async (change) => {
		const spawn = vi.fn(() => fakeChildProcess(0));
		const runGit: ForkGitRunner = (args, cwd) => {
			if (change === "advanced" && args.includes("refs/heads/main")) return { status: 0, stdout: "c".repeat(40) };
			if (change === "dirty" && args[0] === "status") return { status: 0, stdout: " M changed.ts" };
			if (change === "branch" && args[0] === "symbolic-ref") return { status: 0, stdout: "candidate" };
			return cleanMain(args, cwd);
		};
		await expect(
			runForkSelfUpdateAgent({ ...update, prompt: buildForkSelfUpdatePrompt(update), runGit, spawn }),
		).rejects.toThrow();
		expect(spawn).not.toHaveBeenCalled();
	});

	it("propagates process errors and termination signals", async () => {
		for (const event of ["error", "close"] as const) {
			await expect(
				runForkSelfUpdateAgent({
					...update,
					prompt: buildForkSelfUpdatePrompt(update),
					runGit: cleanMain,
					spawn: () => {
						const child = new EventEmitter() as ChildProcess;
						queueMicrotask(() =>
							event === "error"
								? child.emit("error", new Error("spawn failed"))
								: child.emit("close", null, "SIGTERM"),
						);
						return child;
					},
				}),
			).rejects.toThrow(event === "error" ? "spawn failed" : "SIGTERM");
		}
	});
});
