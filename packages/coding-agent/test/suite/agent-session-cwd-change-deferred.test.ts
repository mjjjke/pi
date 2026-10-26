import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cwdFixture } from "./cwd-change-fixture.ts";
import { getMessageText } from "./harness.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("deferred cwd requests", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length) await cleanups.pop()?.();
	});
	async function fixture(options: Parameters<typeof cwdFixture>[0] = {}) {
		const f = await cwdFixture(options);
		cleanups.push(f.cleanup);
		f.runtime.setCwdChangeHandler((target, options) => f.runtime.changeCwd(target, options));
		return f;
	}

	it("is absent without an interactive binding", async () => {
		const f = await cwdFixture();
		cleanups.push(f.cleanup);
		expect(f.runtime.session.extensionRunner.createContext().requestCwdChange).toBeUndefined();
	});

	it("applies on the next tick after settle, never inside a settle handler; rejects a second request", async () => {
		const f = await fixture();
		f.runtime.session.subscribe((event) => {
			if (event.type === "agent_settled") expect(f.runtime.cwd).toBe(f.a);
		});
		const run = f.runtime.session.prompt("hello");
		const request = f.runtime.session.extensionRunner.createContext().requestCwdChange!(f.b);
		expect(request.status).toBe("pending");
		expect(f.runtime.session.extensionRunner.createContext().requestCwdChange!(f.b).status).toBe("rejected");
		await run;
		expect(f.runtime.cwd).toBe(f.a);
		if (request.status !== "pending") throw new Error("request rejected");
		expect(await request.completion).toBe("applied");
		expect(f.runtime.cwd).toBe(f.b);
		expect(f.runtime.session.messages.filter((m) => m.role === "custom" && m.customType === "pi.cwd")).toHaveLength(
			1,
		);
	});

	it.each(["abort", "dispose", "tree"] as const)(
		"%s before the immediate cancels once on the origin",
		async (action) => {
			const f = await fixture();
			await f.runtime.session.prompt("hello");
			const old = f.runtime.session;
			const target = old.sessionManager
				.getBranch()
				.find((e) => e.type === "message" && e.message.role === "system")!.id;
			const request = old.extensionRunner.createContext().requestCwdChange!(f.b);
			if (request.status !== "pending") throw new Error("request rejected");
			if (action === "abort") await old.abort();
			else if (action === "dispose") old.dispose();
			else await old.navigateTree(target);
			expect(await request.completion).toBe("cancelled");
			await tick();
			expect(f.runtime.cwd).toBe(f.a);
			const outcomes = old.sessionManager
				.getEntries()
				.filter((e) => e.type === "custom_message" && e.customType === "pi.cwd");
			expect(outcomes).toHaveLength(1);
			if (action === "tree") expect(old.sessionManager.getBranch()).not.toContain(outcomes[0]);
		},
	);

	it("keeps pending across reload and accepts a new request after it applied", async () => {
		const f = await fixture();
		await f.runtime.session.prompt("hello");
		const request = f.runtime.session.extensionRunner.createContext().requestCwdChange!(f.b);
		if (request.status !== "pending") throw new Error("request rejected");
		await f.runtime.session.reload();
		expect(await request.completion).toBe("applied");
		const next = f.runtime.session.extensionRunner.createContext().requestCwdChange!(f.a);
		expect(next.status).toBe("pending");
		await f.runtime.session.abort();
	});

	it("trust No adds exactly one cancelled child and leaves original history and location unchanged", async () => {
		const f = await fixture();
		await f.runtime.session.prompt("hello");
		const prefix = structuredClone(f.runtime.session.messages);
		f.runtime.setResolveTargetTrust(async () => false);
		const request = f.runtime.session.extensionRunner.createContext().requestCwdChange!(f.b);
		if (request.status !== "pending") throw new Error("request rejected");
		expect(await request.completion).toBe("untrusted");
		expect(f.runtime.cwd).toBe(f.a);
		expect(f.runtime.session.messages.slice(0, prefix.length)).toEqual(prefix);
		expect(f.runtime.session.messages).toHaveLength(prefix.length + 1);
		expect(getMessageText(f.runtime.session.messages.at(-1))).toContain(`${f.b} is not trusted`);
	});

	it.each(["abort", "tree", "dispose"] as const)(
		"%s during trust prevents commit and owns the only outcome",
		async (action) => {
			const f = await fixture();
			await f.runtime.session.prompt("hello");
			const old = f.runtime.session;
			let answer!: (value: boolean) => void;
			f.runtime.setResolveTargetTrust(
				() =>
					new Promise<boolean>((resolve) => {
						answer = resolve;
					}),
			);
			const request = old.extensionRunner.createContext().requestCwdChange!(f.b);
			if (request.status !== "pending") throw new Error("request rejected");
			await tick();
			if (action === "abort") await old.abort();
			else if (action === "dispose") old.dispose();
			else await old.navigateTree(old.sessionManager.getBranch()[0]!.id);
			answer(true);
			await tick();
			expect(await request.completion).toBe("cancelled");
			expect(f.runtime.cwd).toBe(f.a);
			expect(
				old.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "pi.cwd"),
			).toHaveLength(1);
		},
	);

	it("target removed during trust fails once without relocation", async () => {
		const f = await fixture();
		await f.runtime.session.prompt("hello");
		f.runtime.setResolveTargetTrust(async () => {
			rmSync(f.b, { recursive: true });
			return true;
		});
		const request = f.runtime.session.extensionRunner.createContext().requestCwdChange!(f.b);
		if (request.status !== "pending") throw new Error("request rejected");
		expect(await request.completion).toBe("failed");
		expect(f.runtime.cwd).toBe(f.a);
		expect(getMessageText(f.runtime.session.messages.at(-1))).toContain(
			"Working-directory change failed (not a request).",
		);
	});
});
