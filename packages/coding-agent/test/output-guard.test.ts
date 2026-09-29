import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixturePath = fileURLToPath(new URL("./fixtures/output-guard-epipe.ts", import.meta.url));

interface ChildResult {
	code: number | null;
	stderr: string;
}

/** Run the fixture; once it has written "ready", close the parent's end of its stdout pipe. */
function runFixture(mode: string): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [fixturePath, mode], { stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.stdout.once("data", () => {
			child.stdout.destroy();
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`fixture did not exit; stderr:\n${stderr}`));
		}, 10_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stderr });
		});
	});
}

describe("output-guard: raw stdout sink gone", () => {
	it("without a broken-stdout handler, EPIPE still exits 1", async () => {
		const result = await runFixture("none");
		expect(result.code).toBe(1);
	});

	it("with a handler, EPIPE marks stdout broken, notifies once, and later writes/flush are no-ops", async () => {
		const result = await runFixture("handler");
		expect(result.stderr).toContain("broken 1\n");
		expect(result.stderr).not.toContain("broken 2");
		expect(result.stderr).toContain("flushed\n");
		expect(result.stderr).toContain("alive\n");
		expect(result.stderr).not.toContain("EPIPE");
		expect(result.code).toBe(0);
	});

	it("with a handler, other write errors still exit 1", async () => {
		const result = await runFixture("handler-eio");
		expect(result.stderr).not.toContain("broken");
		expect(result.code).toBe(1);
	});
});
