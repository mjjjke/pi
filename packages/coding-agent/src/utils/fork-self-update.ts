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

You are running from \`pi update\` in a nested Pi print-mode agent with low reasoning and only the read, bash, edit, and write built-in tools enabled. Do not call \`pi update\` from this task.

Required workflow:
1. Inspect state with \`git status --short\`, \`git branch --show-current\`, \`git remote -v\`, and \`git rev-parse --show-toplevel\`.
2. Abort and report if the working tree has unrelated uncommitted changes. Allowed pre-existing local changes are only changes that clearly belong to this update flow or the user's fork patch stack; ask/report instead of guessing if unsure.
3. Fetch upstream release tags with \`git fetch upstream --tags\`.
4. Select the latest released version tag with \`git tag -l 'v*' --sort=-v:refname | head -1\`, verify it is non-empty, and report it.
5. Rebase the current branch onto that latest released tag with \`git rebase <latest_tag>\`. Do not rebase onto \`upstream/main\`; it may contain unreleased commits.
6. If rebase conflicts occur, resolve only files that belong to this fork patch stack or this update. Do not use \`git reset --hard\`, \`git stash\`, \`git clean\`, \`git add .\`, \`git add -A\`, or \`git commit --no-verify\`. Stage only explicit resolved paths. If a conflict is unrelated or unsafe, stop with the rebase in progress and report exact next steps.
7. After a successful rebase, run \`npm install --ignore-scripts\`.
8. Run \`npm run build\`.
9. Run \`npm run check\`.
10. Verify the global \`pi\` still points to this repo with:
   - \`which pi\`
   - \`readlink -f "$(which pi)"\`
   - \`pi --version\`
11. Report final status, latest release tag used, current HEAD, remaining \`git status --short\`, and whether the fork is updated.

Safety rules:
- Do not use destructive git commands.
- Do not use \`git reset --hard\`, \`git stash\`, \`git clean\`, \`git add .\`, \`git add -A\`, or \`git commit --no-verify\`.
- Do not force push.
- Do not commit unless the user separately requested it.
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
