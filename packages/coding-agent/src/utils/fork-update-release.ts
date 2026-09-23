import gitHost from "hosted-git-info";
import { compare, prerelease, valid } from "semver";
import { spawnProcessSync } from "./child-process.ts";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

export type ForkGitRunner = (args: string[], cwd: string) => { status: number | null; stdout: string };

export interface VerifiedForkUpdate {
	repoRoot: string;
	baseSha: string;
	upstreamRepository: string;
	release: {
		version: string;
		tag: string;
		commit: string;
		url: string;
	};
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const runForkGit: ForkGitRunner = (args, cwd) => {
	const result = spawnProcessSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 30_000,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	return { status: result.status, stdout: result.stdout?.trim() ?? "" };
};

function gitOutput(runGit: ForkGitRunner, repoRoot: string, args: string[], operation: string): string {
	const result = runGit(args, repoRoot);
	if (result.status !== 0) throw new Error(`Could not ${operation} for fork update.`);
	return result.stdout.trim();
}

/** Also used immediately before spawning, since verification performs asynchronous network I/O. */
export function assertForkUpdateBase(
	repoRoot: string,
	expectedSha?: string,
	runGit: ForkGitRunner = runForkGit,
): string {
	const branch = gitOutput(runGit, repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], "read branch");
	if (branch !== "main") throw new Error("Fork updates require the installed checkout on main.");
	const status = gitOutput(runGit, repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"], "read status");
	if (status) throw new Error("Fork updates require a clean main, including staged and untracked files.");
	const merge = runGit(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], repoRoot);
	if (merge.status !== 1) throw new Error("Finish the pending Git operation before preparing a fork update.");
	const sha = gitOutput(runGit, repoRoot, ["rev-parse", "refs/heads/main"], "read main");
	if (!OBJECT_ID.test(sha)) throw new Error("Invalid main commit for fork update.");
	if (expectedSha && sha !== expectedSha) throw new Error("main advanced during fork update preparation; retry.");
	return sha;
}

function readRemoteTag(runGit: ForkGitRunner, repoRoot: string, tag: string): { object: string; commit: string } {
	const ref = `refs/tags/${tag}`;
	const output = gitOutput(
		runGit,
		repoRoot,
		["ls-remote", "--tags", "upstream", ref, `${ref}^{}`],
		"verify upstream tag",
	);
	const refs = new Map<string, string>();
	for (const line of output.split("\n")) {
		const [object, name] = line.split(/\s+/);
		if (name !== ref && name !== `${ref}^{}`) continue;
		if (!OBJECT_ID.test(object) || refs.has(name)) throw new Error("Invalid upstream tag response.");
		refs.set(name, object);
	}
	const object = refs.get(ref);
	if (!object) throw new Error("The published release tag is missing from upstream.");
	return { object, commit: refs.get(`${ref}^{}`) ?? object };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve GitHub's published latest stable release, never infer publication from a Git tag. */
export async function resolveForkUpdateRelease(
	repoRoot: string,
	options: { env?: NodeJS.ProcessEnv; runGit?: ForkGitRunner } = {},
): Promise<VerifiedForkUpdate | undefined> {
	const env = options.env ?? process.env;
	if (env.PI_OFFLINE) throw new Error("Cannot verify a published upstream release while PI_OFFLINE is set.");
	const runGit = options.runGit ?? runForkGit;
	const baseSha = assertForkUpdateBase(repoRoot, undefined, runGit);
	const upstreamUrl = gitOutput(runGit, repoRoot, ["remote", "get-url", "upstream"], "read upstream");
	const host = gitHost.fromUrl(upstreamUrl);
	if (!host || host.type !== "github" || host.domain !== "github.com" || !host.user || !host.project) {
		throw new Error("Fork release verification requires a GitHub upstream repository.");
	}
	const upstreamRepository = `${host.user}/${host.project}`;
	const repositoryPath = `${encodeURIComponent(host.user)}/${encodeURIComponent(host.project)}`;
	let currentPackage: unknown;
	try {
		currentPackage = JSON.parse(
			gitOutput(runGit, repoRoot, ["show", `${baseSha}:packages/coding-agent/package.json`], "read fork version"),
		);
	} catch {
		throw new Error("Could not read the current fork package version.");
	}
	const currentVersion =
		isRecord(currentPackage) && typeof currentPackage.version === "string" ? valid(currentPackage.version) : null;
	if (!currentVersion) throw new Error("Invalid current fork package version.");

	let data: unknown;
	try {
		const response = await fetchWithRetry(
			`https://api.github.com/repos/${repositoryPath}/releases/latest`,
			{
				headers: { "User-Agent": getPiUserAgent(currentVersion), accept: "application/vnd.github+json" },
				signal: AbortSignal.timeout(10_000),
			},
			{ maxRetries: 2, timeoutMs: 10_000 },
		);
		if (!response.ok) throw new Error(`GitHub release verification failed (HTTP ${response.status}).`);
		data = await response.json();
	} catch (error) {
		// Do not relay transport diagnostics that may contain proxy credentials or response bodies.
		if (error instanceof Error && /^GitHub release verification failed \(HTTP \d+\)\.$/.test(error.message))
			throw error;
		throw new Error("Could not read the published GitHub release; check connectivity and retry.");
	}
	if (
		!isRecord(data) ||
		data.draft !== false ||
		data.prerelease !== false ||
		typeof data.published_at !== "string" ||
		!Number.isFinite(Date.parse(data.published_at)) ||
		typeof data.tag_name !== "string"
	)
		throw new Error("GitHub did not return a published stable release.");
	const tag = data.tag_name;
	const version = valid(tag);
	if (!version || prerelease(version) !== null || !/^v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) {
		throw new Error("The published release tag must be a stable semantic version.");
	}
	if (gitOutput(runGit, repoRoot, ["remote", "get-url", "upstream"], "recheck upstream") !== upstreamUrl) {
		throw new Error("The upstream remote changed during release verification; retry.");
	}
	const advertised = readRemoteTag(runGit, repoRoot, tag);
	gitOutput(runGit, repoRoot, ["fetch", "--no-tags", "upstream", `refs/tags/${tag}`], "fetch the published tag");
	const commit = gitOutput(
		runGit,
		repoRoot,
		["rev-parse", "--verify", `${advertised.object}^{commit}`],
		"resolve release commit",
	);
	const rechecked = readRemoteTag(runGit, repoRoot, tag);
	if (
		commit !== advertised.commit ||
		rechecked.object !== advertised.object ||
		rechecked.commit !== advertised.commit
	) {
		throw new Error("The upstream release tag changed or its commit did not match; retry after verification.");
	}
	if (gitOutput(runGit, repoRoot, ["remote", "get-url", "upstream"], "recheck upstream") !== upstreamUrl) {
		throw new Error("The upstream remote changed during release verification; retry.");
	}
	assertForkUpdateBase(repoRoot, baseSha, runGit);
	const contained = runGit(["merge-base", "--is-ancestor", commit, baseSha], repoRoot);
	if (contained.status === 0) return undefined;
	if (contained.status !== 1) throw new Error("Could not check release ancestry for fork update.");
	if (compare(version, currentVersion) <= 0) {
		throw new Error(
			"The latest release is not newer, but its commit is not integrated; refusing an inconsistent update.",
		);
	}
	return {
		repoRoot,
		baseSha,
		upstreamRepository,
		release: {
			version,
			tag,
			commit,
			url: `https://github.com/${repositoryPath}/releases/tag/${encodeURIComponent(tag)}`,
		},
	};
}
