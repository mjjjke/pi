import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSessionResourceCleanup } from "../../../ai/src/session-resources.ts";
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

	it("formats missing and non-directory target refusals without touching the journal", async () => {
		const f = await fixture();
		const leaf = f.runtime.session.sessionManager.getLeafId();
		expect(await f.runtime.changeCwd(join(f.root, "missing"), { source: "user" })).toEqual({
			changed: false,
			error: `cd: does not exist: ${join(f.root, "missing")}`,
		});
		const file = join(f.root, "file");
		writeFileSync(file, "not a directory");
		expect(await f.runtime.changeCwd(file, { source: "user" })).toEqual({
			changed: false,
			error: `cd: not a directory: ${file}`,
		});
		expect(f.runtime.session.sessionManager.getLeafId()).toBe(leaf);
	});

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

	it("preserves a virtual selection after it routed to a capable physical model", async () => {
		let physical: NonNullable<ReturnType<Awaited<ReturnType<typeof cwdFixture>>["seed"]["getModel"]>>;
		const f = await fixture({
			extension: (pi) => {
				pi.registerVirtualModel({
					provider: "faux",
					id: "virtual",
					name: "Virtual",
					thinkingLevels: ["low", "high"],
					route: () => ({ model: physical, thinkingLevel: "high" }),
				});
			},
		});
		physical = f.seed.getModel();
		await f.runtime.session.setModel(f.runtime.session.modelRuntime.getModel("faux", "virtual")!);
		await f.runtime.session.prompt("before");
		expect((await f.runtime.changeCwd(f.b, { source: "user" })).changed).toBe(true);
		expect(f.runtime.session.model?.id).toBe("virtual");
	});

	it("keeps the live model and effort rather than launch options", async () => {
		const f = await fixture();
		await f.runtime.session.setModel(f.seed.getModel("b")!);
		f.runtime.session.setThinkingLevel("high");
		await f.runtime.changeCwd(f.b, { source: "user" });
		expect(f.runtime.session.model?.id).toBe("b");
		expect(f.runtime.session.thinkingLevel).toBe("high");
	});

	it.each([undefined, ["read"]])(
		"merges newly added defaults, retains dropped live tools, and respects launch tools=%j",
		async (tools) => {
			const f = await fixture({ tools });
			f.runtime.session.settingsManager.applyOverrides({ defaultTools: ["read"] });
			f.runtime.session.setActiveToolsByName(["read"]);
			mkdirSync(join(f.b, ".pi"));
			writeFileSync(join(f.b, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["find"] }));
			f.runtime.setResolveTargetTrust(async () => true);
			expect((await f.runtime.changeCwd(f.b, { source: "user" })).changed).toBe(true);
			expect(f.runtime.session.getActiveToolNames()).toEqual(tools ? ["read"] : ["read", "find"]);
		},
	);

	it("keeps a disabled existing extension tool inactive, but activates a newly loaded default-active tool", async () => {
		let destination = false;
		const f = await fixture({
			extension: (pi) => {
				for (const name of destination ? ["existing", "new"] : ["existing"])
					pi.registerTool({
						name,
						label: name,
						description: name,
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					});
			},
		});
		f.runtime.session.setActiveToolsByName(["read"]);
		destination = true;
		await f.runtime.changeCwd(f.b, { source: "user" });
		expect(f.runtime.session.getActiveToolNames()).toContain("new");
		expect(f.runtime.session.getActiveToolNames()).not.toContain("existing");
	});

	it("lifecycle fields and shutdown contexts follow commit-before-teardown ordering", async () => {
		const events: unknown[] = [];
		const f = await fixture({
			persist: true,
			extension: (pi) => {
				pi.on("session_shutdown", (event, ctx) => {
					if (event.reason === "cwd")
						events.push({ event, cwd: ctx.cwd, recordedCwd: ctx.sessionManager.getCwd() });
				});
				pi.on("session_start", (event) => {
					if (event.reason === "cwd") events.push(event);
				});
			},
		});
		await f.runtime.session.prompt("hello");
		const previousSessionFile = f.runtime.session.sessionFile;
		await f.runtime.changeCwd(f.b, { source: "user" });
		expect(events).toEqual([
			{
				event: {
					type: "session_shutdown",
					reason: "cwd",
					targetCwd: f.b,
					targetSessionFile: f.runtime.session.sessionFile,
				},
				cwd: f.a,
				recordedCwd: f.b,
			},
			{ type: "session_start", reason: "cwd", previousCwd: f.a, previousSessionFile },
		]);
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

	it.each([false, true])("refuses codemode only with active=%s", async (active) => {
		const f = await fixture({
			codemode: active,
			settings: { codemode: { mode: "only" }, ...(active ? { defaultTools: ["read", "codemode"] } : {}) },
		});
		const old = f.runtime.session;
		expect(await f.runtime.changeCwd(f.b, { source: "user" })).toEqual({
			changed: false,
			error: 'cd: not supported while codemode.mode is "only" (it would change tool declarations already sent).',
		});
		expect(f.runtime.session).toBe(old);
	});

	it("refuses a third-party hidden declaration and names the actual owning hook", async () => {
		const f = await fixture({
			extension: (pi) => {
				for (const name of ["first", "hider"])
					pi.registerTool({
						name,
						label: name,
						description: name,
						parameters: Type.Object({}),
						prepareLoadout: () => (name === "hider" ? { hiddenDeclarations: ["read"] } : {}),
						execute: async () => ({ content: [], details: {} }),
					});
			},
		});
		expect(await f.runtime.changeCwd(f.b, { source: "user" })).toEqual({
			changed: false,
			error: "cd: not supported while hider hides tool declarations (it would change tool declarations already sent).",
		});
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

	it("keeps provider resources keyed by the unchanged id, but final disposal releases them", async () => {
		const f = await fixture();
		const cleanup = vi.fn();
		const unregister = registerSessionResourceCleanup(cleanup);
		try {
			const id = f.runtime.session.sessionId;
			await f.runtime.changeCwd(f.b, { source: "user" });
			expect(cleanup).not.toHaveBeenCalled();
			await f.runtime.dispose();
			expect(cleanup).toHaveBeenCalledExactlyOnceWith(id);
		} finally {
			unregister();
		}
	});

	it("refuses before publication when an idle pending instruction cannot precede the notice", async () => {
		const f = await fixture();
		const old = f.runtime.session;
		const append = old.sessionManager.appendMessage.bind(old.sessionManager);
		const fail = vi.spyOn(old.sessionManager, "appendMessage").mockImplementation((message, options) => {
			if (message.role === "developer") throw new Error("instruction refused");
			return append(message, options);
		});
		f.seed.setResponses([
			() => {
				old.queueDeveloperMessage("must precede the notice");
				return fauxAssistantMessage("ok");
			},
		]);
		await old.prompt("hello");
		expect(await f.runtime.changeCwd(f.b, { source: "user" })).toEqual({
			changed: false,
			error: "cd: pending developer instructions could not be committed.",
		});
		expect(f.runtime.session).toBe(old);
		fail.mockRestore();
		f.seed.setResponses([fauxAssistantMessage("usable")]);
		await old.prompt("still usable");
	});

	it("a trust resolver exception is a pre-commit failure and leaves the old runtime usable", async () => {
		const f = await fixture();
		const old = f.runtime.session;
		f.runtime.setResolveTargetTrust(async () => {
			throw new Error("trust failed");
		});
		expect(await f.runtime.changeCwd(f.b, { source: "user" })).toEqual({ changed: false, error: "trust failed" });
		expect(f.runtime.session).toBe(old);
		await old.prompt("still usable");
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
