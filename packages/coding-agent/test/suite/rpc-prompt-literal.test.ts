import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessageText } from "./harness.ts";
import { createRpcHarness, type RpcHarness } from "./rpc-harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	onRawStdoutBroken: vi.fn(() => () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

function createResources(): { skillsDir: string; promptsDir: string } {
	const root = join(tmpdir(), `pi-rpc-literal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const skillsDir = join(root, "skills");
	const promptsDir = join(root, "prompts");
	mkdirSync(join(skillsDir, "demo"), { recursive: true });
	mkdirSync(promptsDir, { recursive: true });
	writeFileSync(join(skillsDir, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill\n---\nSKILL BODY\n");
	writeFileSync(join(promptsDir, "tpl.md"), "---\ndescription: Demo template\n---\nTEMPLATE BODY $1\n");
	return { skillsDir, promptsDir };
}

describe("RPC prompt expandPromptTemplates", () => {
	const harnesses: RpcHarness[] = [];
	let commandRuns: string[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
		commandRuns = [];
	});

	async function setup(): Promise<RpcHarness> {
		const { skillsDir, promptsDir } = createResources();
		const harness = await createRpcHarness(rpcIo, {
			additionalSkillPaths: [skillsDir],
			additionalPromptTemplatePaths: [promptsDir],
			extensionFactory: (pi) => {
				pi.registerCommand("name", {
					description: "Test command",
					handler: async (args) => {
						commandRuns.push(args);
					},
				});
			},
		});
		harnesses.push(harness);
		return harness;
	}

	async function promptAndCollect(harness: RpcHarness, command: Record<string, unknown>): Promise<string[]> {
		const seen: string[] = [];
		harness.faux.setResponses([
			(context) => {
				const last = context.messages[context.messages.length - 1];
				seen.push(getMessageText(last));
				return fauxAssistantMessage("ok");
			},
		]);
		harness.send(command);
		const response = await harness.waitForResponse(String(command.id));
		expect(response).toMatchObject({ success: true });
		await harness.runtime.session.waitForIdle();
		return seen;
	}

	it("sends extension command, skill and template prompts literally when expandPromptTemplates is false", async () => {
		const harness = await setup();
		expect(harness.runtime.session.promptTemplates.map((t) => t.name)).toContain("tpl");
		expect(harness.runtime.session.resourceLoader.getSkills().skills.map((s) => s.name)).toContain("demo");

		for (const [id, message] of [
			["c1", "/name arg"],
			["c2", "/skill:demo please"],
			["c3", "/tpl X"],
		] as const) {
			const seen = await promptAndCollect(harness, {
				id,
				type: "prompt",
				message,
				expandPromptTemplates: false,
			});
			expect(seen).toEqual([message]);
		}
		expect(commandRuns).toEqual([]);
	});

	it("keeps expanding by default", async () => {
		const harness = await setup();

		harness.send({ id: "d1", type: "prompt", message: "/name arg" });
		expect(await harness.waitForResponse("d1")).toMatchObject({ success: true });
		expect(commandRuns).toEqual(["arg"]);

		const skill = await promptAndCollect(harness, { id: "d2", type: "prompt", message: "/skill:demo please" });
		expect(skill[0]).toContain("SKILL BODY");
		expect(skill[0]).toContain('<skill name="demo"');

		const template = await promptAndCollect(harness, {
			id: "d3",
			type: "prompt",
			message: "/tpl X",
			expandPromptTemplates: true,
		});
		expect(template).toEqual(["TEMPLATE BODY X"]);
	});

	it("queues a literal steer while streaming", async () => {
		const harness = await setup();
		const seen: string[][] = [];
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.faux.setResponses([
			async (context) => {
				seen.push(context.messages.filter((m) => m.role === "user").map((m) => getMessageText(m)));
				await released;
				return fauxAssistantMessage("first");
			},
			(context) => {
				seen.push(context.messages.filter((m) => m.role === "user").map((m) => getMessageText(m)));
				return fauxAssistantMessage("second");
			},
		]);
		harness.send({ id: "s0", type: "prompt", message: "start" });
		await harness.waitForResponse("s0");
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		harness.send({
			id: "s1",
			type: "prompt",
			message: "/tpl Y",
			streamingBehavior: "steer",
			expandPromptTemplates: false,
		});
		expect(await harness.waitForResponse("s1")).toMatchObject({ success: true });
		release();
		await vi.waitFor(() => expect(seen).toHaveLength(2));
		await harness.runtime.session.waitForIdle();
		expect(seen[1]).toEqual(["start", "/tpl Y"]);
		expect(commandRuns).toEqual([]);
	});

	it("queues a literal follow-up while streaming", async () => {
		const harness = await setup();
		const seen: string[][] = [];
		let release = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.faux.setResponses([
			async (context) => {
				seen.push(context.messages.filter((m) => m.role === "user").map((m) => getMessageText(m)));
				await released;
				return fauxAssistantMessage("first");
			},
			(context) => {
				seen.push(context.messages.filter((m) => m.role === "user").map((m) => getMessageText(m)));
				return fauxAssistantMessage("second");
			},
		]);
		harness.send({ id: "f0", type: "prompt", message: "start" });
		await harness.waitForResponse("f0");
		await vi.waitFor(() => expect(seen).toHaveLength(1));
		harness.send({
			id: "f1",
			type: "prompt",
			message: "/tpl Z",
			streamingBehavior: "followUp",
			expandPromptTemplates: false,
		});
		expect(await harness.waitForResponse("f1")).toMatchObject({ success: true });
		release();
		await vi.waitFor(() => expect(seen).toHaveLength(2));
		await harness.runtime.session.waitForIdle();
		expect(seen[1]).toEqual(["start", "/tpl Z"]);
		expect(commandRuns).toEqual([]);
	});
});
