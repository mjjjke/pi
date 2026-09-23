import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildForkSelfUpdatePrompt } from "../src/utils/fork-self-update.ts";
import { type ForkGitRunner, resolveForkUpdateRelease, runForkGit } from "../src/utils/fork-update-release.ts";

const base = "a".repeat(40);
const commit = "b".repeat(40);
const tagObject = "c".repeat(40);
const release = { tag_name: "v0.88.0", draft: false, prerelease: false, published_at: "2026-09-20T00:00:00Z" };

function harness(options: { annotated?: boolean; remote?: string; contained?: boolean; version?: string } = {}) {
	const runGit = vi.fn<ForkGitRunner>((args) => {
		switch (args[0]) {
			case "symbolic-ref":
				return { status: 0, stdout: "main" };
			case "status":
				return { status: 0, stdout: "" };
			case "remote":
				return { status: 0, stdout: options.remote ?? "https://github.com/earendil-works/pi.git" };
			case "show":
				return { status: 0, stdout: JSON.stringify({ version: options.version ?? "0.87.1" }) };
			case "ls-remote":
				return {
					status: 0,
					stdout: options.annotated
						? `${tagObject}\trefs/tags/v0.88.0\n${commit}\trefs/tags/v0.88.0^{}`
						: `${commit}\trefs/tags/v0.88.0`,
				};
			case "fetch":
				return { status: 0, stdout: "" };
			case "rev-parse":
				if (args.includes("MERGE_HEAD")) return { status: 1, stdout: "" };
				return { status: 0, stdout: args.at(-1)?.endsWith("^{commit}") ? commit : base };
			case "merge-base":
				return { status: options.contained ? 0 : 1, stdout: "" };
			default:
				throw new Error(`Unexpected git command ${args.join(" ")}`);
		}
	});
	return { runGit, resolve: () => resolveForkUpdateRelease("/repo", { env: {}, runGit }) };
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json(release)),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("published fork releases", () => {
	it.each([false, true])(
		"pins a %s annotated tag without replacing local tags or using FETCH_HEAD",
		async (annotated) => {
			const h = harness({ annotated });
			expect(await h.resolve()).toEqual({
				repoRoot: "/repo",
				baseSha: base,
				upstreamRepository: "earendil-works/pi",
				release: {
					version: "0.88.0",
					tag: "v0.88.0",
					commit,
					url: "https://github.com/earendil-works/pi/releases/tag/v0.88.0",
				},
			});
			expect(fetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/earendil-works/pi/releases/latest",
				expect.objectContaining({
					headers: expect.objectContaining({ accept: "application/vnd.github+json" }),
					signal: expect.any(AbortSignal),
				}),
			);
			expect(h.runGit).toHaveBeenCalledWith(["fetch", "--no-tags", "upstream", "refs/tags/v0.88.0"], "/repo");
			expect(h.runGit).toHaveBeenCalledWith(
				["rev-parse", "--verify", `${annotated ? tagObject : commit}^{commit}`],
				"/repo",
			);
			expect(h.runGit.mock.calls.filter(([args]) => args[0] === "ls-remote")).toHaveLength(2);
			expect(h.runGit.mock.calls.flatMap(([args]) => args)).not.toContain("FETCH_HEAD");
			expect(h.runGit.mock.calls.flatMap(([args]) => args)).not.toContain("worktree");
		},
	);

	it.each([
		"git@github.com:earendil-works/pi.git",
		"ssh://git@github.com/earendil-works/pi.git",
		"https://test-secret@github.com/earendil-works/pi.git",
	])("handles GitHub upstream %s without forwarding auth", async (remote) => {
		const result = await harness({ remote }).resolve();
		expect(result?.upstreamRepository).toBe("earendil-works/pi");
		expect(JSON.stringify(result)).not.toContain("test-secret");
		const init = vi.mocked(fetch).mock.calls[0]?.[1];
		expect(init?.headers).not.toHaveProperty("authorization");
	});

	it.each(["0.88.0", "v0.88.0+build.1"])(
		"accepts stable tag %s without treating build metadata as a prerelease",
		async (tag) => {
			vi.mocked(fetch).mockResolvedValue(Response.json({ ...release, tag_name: tag }));
			const h = harness();
			const original = h.runGit.getMockImplementation()!;
			h.runGit.mockImplementation((args, cwd) =>
				args[0] === "ls-remote" ? { status: 0, stdout: `${commit}\trefs/tags/${tag}` } : original(args, cwd),
			);
			expect((await h.resolve())?.release).toMatchObject({ tag, version: "0.88.0", commit });
		},
	);

	it("rejects unsupported upstream without disclosing its URL", async () => {
		await expect(harness({ remote: "https://test-secret@gitlab.com/example/pi.git" }).resolve()).rejects.toThrow(
			"GitHub upstream",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does no I/O in offline mode", async () => {
		const h = harness();
		await expect(resolveForkUpdateRelease("/repo", { env: { PI_OFFLINE: "1" }, runGit: h.runGit })).rejects.toThrow(
			"PI_OFFLINE",
		);
		expect(h.runGit).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		{ draft: true },
		{ prerelease: true },
		{ published_at: null },
		{ published_at: "invalid" },
		{ tag_name: "v0.88.0-beta.1" },
		{ tag_name: "main" },
		{ tag_name: "--upload-pack=bad" },
	])("rejects invalid release metadata %j before fetching Git objects", async (override) => {
		vi.mocked(fetch).mockResolvedValue(Response.json({ ...release, ...override }));
		const h = harness();
		await expect(h.resolve()).rejects.toThrow();
		expect(h.runGit.mock.calls.some(([args]) => args[0] === "fetch")).toBe(false);
	});

	it.each([null, [], {}, "not a release"])("rejects unexpected response shape %j", async (data) => {
		vi.mocked(fetch).mockResolvedValue(Response.json(data));
		await expect(harness().resolve()).rejects.toThrow("published stable release");
	});

	it("rejects malformed JSON without echoing its body", async () => {
		vi.mocked(fetch).mockResolvedValue(new Response("test-sensitive-body"));
		await expect(harness().resolve()).rejects.toThrow("Could not read the published GitHub release");
	});

	it.each([403, 404, 429, 503])("reports HTTP %s with bounded retries", async (status) => {
		vi.mocked(fetch).mockImplementation(async () => new Response("test-sensitive-body", { status }));
		await expect(harness().resolve()).rejects.toThrow(`HTTP ${status}`);
		expect(fetch).toHaveBeenCalledTimes(status === 429 || status === 503 ? 3 : 1);
	});

	it("retries transient transport failures without forwarding their diagnostics", async () => {
		vi.mocked(fetch).mockRejectedValue(new Error("test-sensitive-proxy"));
		await expect(harness().resolve()).rejects.toThrow("Could not read the published GitHub release");
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("uses a ten-second overall timeout and stops on expiration", async () => {
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(AbortSignal.abort(new DOMException("expired", "TimeoutError")));
		await expect(harness().resolve()).rejects.toThrow("Could not read the published GitHub release");
		expect(timeout).toHaveBeenCalledWith(10_000);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each(["branch", "detached", "staged", "unstaged", "untracked", "merge"])(
		"rejects %s checkout state before network",
		async (state) => {
			const h = harness();
			const original = h.runGit.getMockImplementation()!;
			h.runGit.mockImplementation((args, cwd) => {
				if (args[0] === "symbolic-ref" && state === "branch") return { status: 0, stdout: "other" };
				if (args[0] === "symbolic-ref" && state === "detached") return { status: 1, stdout: "" };
				if (args[0] === "status" && ["staged", "unstaged", "untracked"].includes(state))
					return { status: 0, stdout: { staged: "M  a", unstaged: " M a", untracked: "?? a" }[state]! };
				if (args.includes("MERGE_HEAD") && state === "merge") return { status: 0, stdout: commit };
				return original(args, cwd);
			});
			await expect(h.resolve()).rejects.toThrow();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each(["missing", "moved", "mismatch", "fetch-failed", "ancestry-failed", "main-advanced", "remote-changed"])(
		"rejects %s verification",
		async (state) => {
			const h = harness();
			const original = h.runGit.getMockImplementation()!;
			let remoteReads = 0;
			let mainReads = 0;
			let urlReads = 0;
			h.runGit.mockImplementation((args, cwd) => {
				if (args[0] === "remote" && ++urlReads > 1 && state === "remote-changed")
					return { status: 0, stdout: "https://github.com/other/repo.git" };
				if (args[0] === "ls-remote") {
					remoteReads++;
					if (state === "missing") return { status: 0, stdout: "" };
					if (state === "moved" && remoteReads === 2)
						return { status: 0, stdout: `${tagObject}\trefs/tags/v0.88.0` };
				}
				if (state === "mismatch" && args.at(-1)?.endsWith("^{commit}")) return { status: 0, stdout: tagObject };
				if (state === "fetch-failed" && args[0] === "fetch") return { status: 1, stdout: "" };
				if (state === "ancestry-failed" && args[0] === "merge-base") return { status: 128, stdout: "" };
				if (args.includes("refs/heads/main")) {
					mainReads++;
					if (state === "main-advanced" && mainReads > 1) return { status: 0, stdout: tagObject };
				}
				return original(args, cwd);
			});
			await expect(h.resolve()).rejects.toThrow();
		},
	);

	it("does not prepare another candidate for an already integrated release", async () => {
		expect(await harness({ contained: true }).resolve()).toBeUndefined();
	});

	it.each(["0.88.0", "0.89.0"])("refuses a non-ancestor release when main is already %s", async (version) => {
		await expect(harness({ version }).resolve()).rejects.toThrow("refusing an inconsistent update");
	});
});

describe("local Git release and merge fixture", () => {
	it.each([false, true])(
		"verifies a real %s annotated tag and leaves the candidate merge uncommitted",
		async (annotated) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-fork-release-"));
			const upstream = join(directory, "upstream");
			const fork = join(directory, "fork");
			const candidate = join(directory, "candidate");
			const git = (cwd: string, args: string[]) => {
				const result = runForkGit(args, cwd);
				expect(result.status, args.join(" ")).toBe(0);
				return result.stdout;
			};
			const save = (cwd: string, path: string, contents: string) => {
				writeFileSync(join(cwd, path), contents);
				git(cwd, ["add", path]);
				git(cwd, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", path]);
			};
			try {
				mkdirSync(join(upstream, "packages/coding-agent"), { recursive: true });
				git(upstream, ["init", "--initial-branch=main"]);
				save(upstream, "packages/coding-agent/package.json", JSON.stringify({ version: "0.87.1" }));
				git(directory, ["clone", "--no-hardlinks", upstream, fork]);
				git(fork, ["remote", "add", "upstream", upstream]);
				save(fork, "custom.txt", "personalization");
				const initial = git(fork, ["rev-parse", "main"]);
				save(upstream, "upstream.txt", "upstream feature");
				const releaseCommit = git(upstream, ["rev-parse", "HEAD"]);
				git(
					upstream,
					annotated
						? [
								"-c",
								"user.name=Test",
								"-c",
								"user.email=test@example.test",
								"tag",
								"-a",
								"v0.88.0",
								"-m",
								"release",
							]
						: ["tag", "v0.88.0"],
				);
				// A conflicting local tag must not be overwritten by release verification.
				git(fork, ["tag", "v0.88.0", initial]);
				const runGit: ForkGitRunner = (args, cwd) =>
					args[0] === "remote"
						? { status: 0, stdout: "https://github.com/example/pi.git" }
						: runForkGit(args, cwd);
				const verified = await resolveForkUpdateRelease(fork, { env: {}, runGit });
				expect(verified?.release.commit).toBe(releaseCommit);
				expect(verified?.baseSha).toBe(initial);
				expect(git(fork, ["rev-parse", "refs/tags/v0.88.0"])).toBe(initial);
				expect(git(fork, ["status", "--porcelain"])).toBe("");
				expect(git(fork, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1);
				if (!verified) throw new Error("expected update");
				expect(buildForkSelfUpdatePrompt(verified)).toContain(`git merge --no-ff --no-commit ${releaseCommit}`);
				git(fork, ["worktree", "add", "-b", "candidate", candidate, verified.baseSha]);
				git(candidate, [
					"-c",
					"user.name=Test",
					"-c",
					"user.email=test@example.test",
					"merge",
					"--no-ff",
					"--no-commit",
					releaseCommit,
				]);
				expect(git(candidate, ["rev-parse", "HEAD"])).toBe(initial);
				expect(git(candidate, ["rev-parse", "MERGE_HEAD"])).toBe(releaseCommit);
				// Only the fixture explicitly approves a commit; production preparation never does.
				git(candidate, [
					"-c",
					"user.name=Test",
					"-c",
					"user.email=test@example.test",
					"commit",
					"-m",
					"verified release",
				]);
				expect(git(candidate, ["show", "-s", "--format=%P", "HEAD"])).toBe(`${initial} ${releaseCommit}`);
				expect(git(candidate, ["show", "HEAD:custom.txt"])).toBe("personalization");
				expect(git(fork, ["rev-parse", "main"])).toBe(initial);
				expect(git(fork, ["status", "--porcelain"])).toBe("");
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
