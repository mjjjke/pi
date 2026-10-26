import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cwdFixture } from "./cwd-change-fixture.ts";
import { getMessageText } from "./harness.ts";

describe("same-conversation cwd runtime transfer", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length) await cleanups.pop()?.();
	});
	async function fixture(options: Parameters<typeof cwdFixture>[0] = {}) {
		const f = await cwdFixture(options);
		cleanups.push(f.cleanup);
		return f;
	}

	it("keeps the manager, identity and historical messages; one notice then one system patch", async () => {
		const f = await fixture({ persist: true });
		await f.runtime.session.prompt("before");
		const old = f.runtime.session;
		const prefix = structuredClone(old.messages);
		const result = await f.runtime.changeCwd(f.b, { source: "user" });
		expect(result.changed).toBe(true);
		expect(f.runtime.session.sessionManager).toBe(old.sessionManager);
		expect(f.runtime.session.sessionId).toBe(old.sessionId);
		expect(f.runtime.session).not.toBe(old);
		expect(f.runtime.session.messages.slice(0, prefix.length)).toEqual(prefix);
		await f.runtime.session.prompt("after");
		expect(f.runtime.session.messages.filter((m) => m.role === "custom" && m.customType === "pi.cwd")).toHaveLength(
			1,
		);
		expect(f.runtime.session.messages.filter((m) => m.role === "system")).toHaveLength(2);
		expect(readFileSync(f.runtime.session.sessionFile!, "utf8")).toContain(`"cwd":"${f.b}"`);
	});

	it("carries staged bash, handoff, passive, owner-less instructions and nextTurn before bootstrap", async () => {
		const f = await fixture();
		const old = f.runtime.session;
		old.recordBashResult("pwd", { output: f.a, exitCode: 0, cancelled: false, truncated: false });
		await old.sendCustomMessage({ customType: "handoff", content: "startup handoff", display: true });
		await old.sendCustomMessage({ customType: "passive", content: "passive content", display: true });
		const committed = vi.fn();
		old.queueDeveloperMessage("SDK instruction", { onCommit: committed });
		await old.sendCustomMessage(
			{ customType: "next", content: "next turn", display: true },
			{ deliverAs: "nextTurn" },
		);
		await f.runtime.changeCwd(f.b, { source: "user" });
		expect(f.runtime.session.messages).toEqual([]);
		expect(f.runtime.session.stagedMessages.map((m) => (m.role === "custom" ? m.customType : "bash"))).toEqual([
			"bash",
			"handoff",
			"passive",
			"pi.cwd",
		]);
		await f.runtime.session.prompt("first");
		expect(f.runtime.session.messages.map((m) => m.role)).toEqual([
			"system",
			"developer",
			"bashExecution",
			"custom",
			"custom",
			"custom",
			"user",
			"custom",
			"assistant",
		]);
		expect(committed).toHaveBeenCalledTimes(1);
		expect(f.runtime.session.messages.map(getMessageText).join("\n")).toContain("startup handoff");
	});

	it("keeps the live model and effort rather than launch options", async () => {
		const f = await fixture();
		await f.runtime.session.setModel(f.seed.getModel("b")!);
		f.runtime.session.setThinkingLevel("high");
		await f.runtime.changeCwd(f.b, { source: "user" });
		expect(f.runtime.session.model?.id).toBe("b");
		expect(f.runtime.session.thinkingLevel).toBe("high");
	});

	it("holds both projection settings even when equal, through destination edits and reload", async () => {
		const f = await fixture();
		await f.runtime.changeCwd(f.b, { source: "user" });
		mkdirSync(join(f.b, ".pi"));
		writeFileSync(
			join(f.b, ".pi", "settings.json"),
			JSON.stringify({ images: { blockImages: true }, codemode: { mode: "only" } }),
		);
		await f.runtime.session.reload();
		expect(f.runtime.session.settingsManager.getBlockImages()).toBe(false);
		expect(f.runtime.session.settingsManager.getSettings().codemode?.mode).toBe("on");
	});

	it("refuses codemode only even when codemode is inactive", async () => {
		const f = await fixture({ settings: { codemode: { mode: "only" } } });
		const old = f.runtime.session;
		expect(await f.runtime.changeCwd(f.b, { source: "user" })).toEqual({
			changed: false,
			error: 'cd: not supported while codemode.mode is "only" (it would change tool declarations already sent).',
		});
		expect(f.runtime.session).toBe(old);
	});

	it("asks trust before relocation or factories; No writes nothing and Yes asks only once", async () => {
		const f = await fixture({ persist: true });
		await f.runtime.session.prompt("before");
		const old = f.runtime.session;
		const leaf = old.sessionManager.getLeafId();
		const file = old.sessionFile;
		const trust = vi.fn(async () => {
			expect(f.factories).toEqual([f.a]);
			expect(old.sessionFile).toBe(file);
			return false;
		});
		f.runtime.setResolveTargetTrust(trust);
		expect(await f.runtime.changeCwd(f.b, { source: "user" })).toEqual({ changed: false, error: "untrusted" });
		expect(old.sessionManager.getLeafId()).toBe(leaf);
		trust.mockImplementation(async () => true);
		expect((await f.runtime.changeCwd(f.b, { source: "user" })).changed).toBe(true);
		expect(trust).toHaveBeenCalledTimes(2);
		expect(f.factories).toEqual([f.a, f.b]);
	});

	it("commit failure leaves the old runtime usable; ambient handler runs before factories", async () => {
		const f = await fixture();
		const old = f.runtime.session;
		const relocate = vi.spyOn(old.sessionManager, "relocate").mockImplementationOnce(() => {
			throw new Error("publication refused");
		});
		expect(await f.runtime.changeCwd(f.b, { source: "user" })).toEqual({
			changed: false,
			error: "publication refused",
		});
		expect(f.runtime.session).toBe(old);
		await old.prompt("still usable");
		relocate.mockRestore();
		const order: string[] = [];
		f.runtime.setAmbientCwdHandler((cwd) => {
			expect(f.factories).toEqual([f.a]);
			order.push(cwd);
		});
		await f.runtime.changeCwd(f.b, { source: "user" });
		expect(order).toEqual([f.b]);
	});
});
