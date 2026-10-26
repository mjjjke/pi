import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { createCwdSessionDirResolver, cwdSessionArgs } from "../src/cli/cwd-change.ts";

describe("CLI cwd policy", () => {
	it("skips launch model and effort on cwd transfer without dropping auth or tool flags", () => {
		const args = parseArgs(["--model", "a/removed", "--thinking", "low", "--api-key", "offline", "--tools", "read"]);
		const next = cwdSessionArgs(args);
		expect(next.model).toBeUndefined();
		expect(next.provider).toBeUndefined();
		expect(next.thinking).toBeUndefined();
		expect(next.apiKey).toBe("offline");
		expect(next.tools).toEqual(["read"]);
		expect(args.model).toBe("a/removed");
	});

	it("resolves launch flag/env once, but relative project settings against each destination", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cwd-policy-"));
		try {
			const a = join(root, "a");
			const b = join(root, "b");
			const agentDir = join(root, "agent");
			for (const cwd of [a, b, agentDir]) mkdirSync(cwd, { recursive: true });
			mkdirSync(join(b, ".pi"));
			writeFileSync(join(b, ".pi", "settings.json"), JSON.stringify({ sessionDir: "local-sessions" }));
			const options = { launchCwd: a, agentDir };
			expect(createCwdSessionDirResolver({ ...options, flag: "flag", environment: "env" })(b)).toBe(join(a, "flag"));
			expect(createCwdSessionDirResolver({ ...options, environment: "env" })(b)).toBe(join(a, "env"));
			expect(createCwdSessionDirResolver(options)(b)).toBe(join(b, "local-sessions"));
			expect(createCwdSessionDirResolver(options)(a)).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
