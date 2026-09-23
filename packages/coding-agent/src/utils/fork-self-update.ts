import type { ChildProcess } from "node:child_process";
import { relative } from "node:path";
import { spawnProcess, spawnProcessSync } from "./child-process.ts";

export interface ForkSelfUpdatePlan {
	repoRoot: string;
	prompt: string;
}

export interface ForkSelfUpdateDetectionOptions {
	packageDir: string;
	env?: NodeJS.ProcessEnv;
	runGit?: (args: string[], cwd: string) => { status: number | null; stdout: string };
}

export interface RunForkSelfUpdateOptions {
	repoRoot: string;
	prompt: string;
	execPath?: string;
	entrypoint?: string;
	model?: string;
	env?: NodeJS.ProcessEnv;
	spawn?: (
		command: string,
		args: string[],
		options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
	) => ChildProcess;
}

export const DEFAULT_FORK_SELF_UPDATE_MODEL = "openai-codex/gpt-5.5";
export const FORK_SELF_UPDATE_TOOLS = "read,bash,edit,write";

export function buildForkSelfUpdatePrompt(repoRoot: string): string {
	return `Update this local pi fork from upstream.

Repository root: ${repoRoot}

You are running from \`pi update\` in a nested Pi print-mode agent with low reasoning and only the read, bash, edit, and write built-in tools enabled. Do not call \`pi update\` from this task. Prepare a candidate in an isolated worktree; do not replace the running installation or modify its branch.

Required workflow:
1. Inspect \`git status --short\`, \`git branch --show-current\`, \`git worktree list\`, and the upstream remote. Stop and report unrelated uncommitted changes; never discard or guess ownership.
2. Fetch upstream release tags with \`git fetch upstream --tags\`. Select the latest stable release, verify its tag and commit against the upstream remote, and report both. Do not use \`upstream/main\` as the base.
3. Inventory the fork's changes against its previous upstream base. Determine which behaviors upstream already supplies and which local extensions still consume. Preserve functionality; ask before removing or replacing intentional behavior.
4. Create a new branch and worktree from the verified release tag, using unused names. Keep the original worktree, branch, global pi link, and installed extensions unchanged.
5. Add only the remaining fork functionality to the upstream implementation. Adapt to its current APIs and lifecycle rather than blindly replaying old patches or choosing whole conflict blocks. If safe adaptation is unclear, stop and report the exact blocker.
6. In the candidate, hydrate dependencies with \`npm ci --ignore-scripts\`, regenerate model data through the official generators if needed, and run \`npm run check\`. Run focused offline regressions for every affected behavior and validate extension consumers against candidate sources, not stale dist files. Never call real providers for tests.
7. Inspect \`git status --short\` and \`git diff HEAD --stat\` in both worktrees. Classify candidate changes as \`fork-functionality\`, \`upstream-adaptation\`, \`generated\`, or \`unexpected\`. Stop on unexpected changes. Do not discard generated files or validation fixups.
8. Report the release tag/commit, candidate branch/path, checks actually run, remaining failures, classification of remaining changed files, and installation status. Use \`candidate validated; activation pending\` only if checks passed, otherwise \`candidate incomplete\`. Preparation is not installation: never report the installed fork as updated merely because this agent exited successfully.

Safety rules:
- Do not use \`git reset --hard\`, \`git stash\`, \`git clean\`, \`git add .\`, \`git add -A\`, or \`git commit --no-verify\`.
- Do not commit unless the user separately requested it. Stage only explicit paths if needed.
- Do not rebase the original branch, autosquash, rewrite history, or force push.
- Build, promotion, and relinking require the user's explicit request. Until then leave the running installation intact.
`;
}

function defaultRunGit(args: string[], cwd: string): { status: number | null; stdout: string } {
	const result = spawnProcessSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return { status: result.status, stdout: result.stdout.trim() };
}

function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/"));
}

export function detectForkSelfUpdatePlan(options: ForkSelfUpdateDetectionOptions): ForkSelfUpdatePlan | undefined {
	const env = options.env ?? process.env;
	if (env.PI_FORK_UPDATE_AGENT === "1" || env.PI_DISABLE_FORK_UPDATE_AGENT) {
		return undefined;
	}

	const runGit = options.runGit ?? defaultRunGit;
	const packageDir = options.packageDir;
	const topLevel = runGit(["rev-parse", "--show-toplevel"], packageDir);
	if (topLevel.status !== 0 || !topLevel.stdout) {
		return undefined;
	}

	const repoRoot = topLevel.stdout;
	if (!isInside(repoRoot, packageDir)) {
		return undefined;
	}

	const upstream = runGit(["remote", "get-url", "upstream"], repoRoot);
	if (upstream.status !== 0 || !upstream.stdout) {
		return undefined;
	}

	return {
		repoRoot,
		prompt: buildForkSelfUpdatePrompt(repoRoot),
	};
}

function defaultSpawn(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; stdio: "inherit" },
): ChildProcess {
	return spawnProcess(command, args, options);
}

export async function runForkSelfUpdateAgent(options: RunForkSelfUpdateOptions): Promise<number> {
	const entrypoint = options.entrypoint ?? process.argv[1];
	if (!entrypoint) {
		throw new Error("Cannot run fork update agent because the pi entrypoint is unknown.");
	}

	const execPath = options.execPath ?? process.execPath;
	const model = options.model ?? DEFAULT_FORK_SELF_UPDATE_MODEL;
	const env = {
		...process.env,
		...options.env,
		GIT_EDITOR: "true",
		PI_FORK_UPDATE_AGENT: "1",
		PI_SKIP_VERSION_CHECK: "1",
	};
	const spawn = options.spawn ?? defaultSpawn;
	const child = spawn(
		execPath,
		[
			entrypoint,
			"--print",
			"--model",
			model,
			"--thinking",
			"low",
			"--no-extensions",
			"--no-skills",
			"--tools",
			FORK_SELF_UPDATE_TOOLS,
			options.prompt,
		],
		{
			cwd: options.repoRoot,
			env,
			stdio: "inherit",
		},
	);

	return await new Promise<number>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (signal) {
				reject(new Error(`Fork update agent terminated by signal ${signal}`));
				return;
			}
			resolve(code ?? 1);
		});
	});
}
