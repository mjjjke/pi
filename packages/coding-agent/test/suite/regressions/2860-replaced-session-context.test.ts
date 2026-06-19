import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../../../src/index.ts";

function getText(message: AgentSession["messages"][number]): string {
	if (!("content" in message)) {
		return "";
	}
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
}

describe("regression #2860: replaced session callbacks", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		responses: string[],
		options?: { bindCommandContext?: boolean },
	) {
		const tempDir = join(tmpdir(), `pi-2860-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
							extensionFactory(pi);
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});

		const rebindSession = async (): Promise<void> => {
			const session = runtime.session;
			await session.bindExtensions(
				options?.bindCommandContext === false
					? {}
					: {
							commandContextActions: {
								waitForIdle: () => session.agent.waitForIdle(),
								newSession: async (options) => runtime.newSession(options),
								fork: async (entryId, options) => {
									const result = await runtime.fork(entryId, options);
									return { cancelled: result.cancelled };
								},
								navigateTree: async (targetId, options) => {
									const result = await session.navigateTree(targetId, {
										summarize: options?.summarize,
										customInstructions: options?.customInstructions,
										replaceInstructions: options?.replaceInstructions,
										label: options?.label,
									});
									return { cancelled: result.cancelled };
								},
								switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
								reload: async () => {
									await session.reload();
								},
							},
						},
			);
		};

		runtime.setRebindSession(async () => {
			await rebindSession();
		});
		await rebindSession();

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux };
	}

	it("rebinds before withSession, targets the replacement session, and invalidates stale pi/ctx", async () => {
		const events: string[] = [];
		let oldCtx: ExtensionCommandContext | undefined;
		let oldPi: ExtensionAPI | undefined;
		let oldSessionFile: string | undefined;
		let staleCtxThrows = false;
		let stalePiThrows = false;
		let replacementSessionFile: string | undefined;
		let instanceId = 0;
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				const currentInstance = ++instanceId;
				pi.on("session_start", () => {
					events.push(`start:${currentInstance}`);
				});
				pi.on("session_shutdown", () => {
					events.push(`shutdown:${currentInstance}`);
				});
				pi.registerCommand("repro", {
					description: "repro",
					handler: async (_args, ctx) => {
						oldCtx = ctx;
						oldPi = pi;
						oldSessionFile = ctx.sessionManager.getSessionFile();
						await ctx.newSession({
							parentSession: oldSessionFile,
							withSession: async (replacedCtx) => {
								events.push(`with:${currentInstance}`);
								replacementSessionFile = replacedCtx.sessionManager.getSessionFile();
								try {
									oldCtx?.sessionManager.getSessionFile();
								} catch {
									staleCtxThrows = true;
								}
								try {
									oldPi?.sendUserMessage("stale message");
								} catch {
									stalePiThrows = true;
								}
								replacedCtx.appendDeveloperMessage("Replacement session mask.");
								await replacedCtx.sendUserMessage("Hello from the new session!");
							},
						});
					},
				});
			},
			["hello reply"],
		);

		expect(events).toEqual(["start:1"]);

		await runtime.session.prompt("/repro");

		expect(events).toEqual(["start:1", "shutdown:1", "start:2", "with:1"]);
		expect(replacementSessionFile).toBeDefined();
		expect(replacementSessionFile).not.toBe(oldSessionFile);
		expect(staleCtxThrows).toBe(true);
		expect(stalePiThrows).toBe(true);
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"developer:Replacement session mask.",
			"user:Hello from the new session!",
			"assistant:hello reply",
		]);
	});

	it("queues requestNewSession from agent_end and runs setup and withSession in the replacement session", async () => {
		let requested = false;
		let oldCtx: ExtensionCommandContext | undefined;
		let oldPi: ExtensionAPI | undefined;
		let oldSessionFile: string | undefined;
		let completion: Promise<{ cancelled: boolean }> | undefined;
		let completionResult: { cancelled: boolean } | undefined;
		let duplicateQueued: boolean | undefined;
		let replacementSessionFile: string | undefined;
		let staleCtxThrows = false;
		let stalePiThrows = false;
		const artifactPath = "/tmp/plan.md";
		const planText = "Plan text";
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				pi.on("agent_end", async (_event, ctx) => {
					if (requested) {
						return;
					}
					requested = true;
					oldCtx = ctx as ExtensionCommandContext;
					oldPi = pi;
					oldSessionFile = ctx.sessionManager.getSessionFile();

					const request = await ctx.requestNewSession({
						parentSession: oldSessionFile,
						setup: async (sessionManager) => {
							sessionManager.appendCustomEntry("pi-collaboration-mode", {
								mode: "default",
								artifactPath,
								instructionPending: true,
							});
						},
						withSession: async (freshCtx) => {
							replacementSessionFile = freshCtx.sessionManager.getSessionFile();
							await freshCtx.sendMessage({
								customType: "pi-collaboration-handoff",
								content: planText,
								display: true,
							});
							await freshCtx.sendUserMessage("Implement the plan.", { deliverAs: "followUp" });
						},
					});
					if (request.queued) {
						completion = request.completion.then((result) => {
							completionResult = result;
							return result;
						});
					}
					const duplicate = await ctx.requestNewSession();
					duplicateQueued = duplicate.queued;
				});
			},
			["plan reply", "fresh reply"],
		);

		await runtime.session.prompt("make a plan");
		expect(completion).toBeDefined();
		await completion;

		expect(completionResult).toEqual({ cancelled: false });
		expect(duplicateQueued).toBe(false);
		expect(replacementSessionFile).toBeDefined();
		expect(replacementSessionFile).not.toBe(oldSessionFile);
		expect(runtime.session.sessionFile).toBe(replacementSessionFile);
		expect(runtime.session.sessionManager.getHeader()?.parentSession).toBe(oldSessionFile);
		expect(runtime.session.sessionManager.getSessionName()).toBeUndefined();

		const customStateEntry = runtime.session.sessionManager
			.getEntries()
			.find((entry) => entry.type === "custom" && entry.customType === "pi-collaboration-mode");
		expect(customStateEntry).toMatchObject({
			type: "custom",
			customType: "pi-collaboration-mode",
			data: { mode: "default", artifactPath, instructionPending: true },
		});

		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"custom:Plan text",
			"user:Implement the plan.",
			"assistant:fresh reply",
		]);

		try {
			oldCtx?.sessionManager.getSessionFile();
		} catch {
			staleCtxThrows = true;
		}
		try {
			oldPi?.sendUserMessage("stale message");
		} catch {
			stalePiThrows = true;
		}
		expect(staleCtxThrows).toBe(true);
		expect(stalePiThrows).toBe(true);
	});

	it("resolves requestNewSession completion as cancelled when session_before_switch cancels", async () => {
		let requested = false;
		let originalSessionFile: string | undefined;
		let completion: Promise<{ cancelled: boolean }> | undefined;
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				pi.on("session_before_switch", () => ({ cancel: true }));
				pi.on("agent_end", async (_event, ctx) => {
					if (requested) {
						return;
					}
					requested = true;
					originalSessionFile = ctx.sessionManager.getSessionFile();
					const request = await ctx.requestNewSession({ parentSession: originalSessionFile });
					if (request.queued) {
						completion = request.completion;
					}
				});
			},
			["stays put"],
		);

		await runtime.session.prompt("try replacement");

		expect(completion).toBeDefined();
		await expect(completion!).resolves.toEqual({ cancelled: true });
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:try replacement",
			"assistant:stays put",
		]);
	});

	it("continues queued messages when deferred request fails before replacement", async () => {
		let requested = false;
		let completion: Promise<void> | undefined;
		let completionRejected = false;
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				pi.on("agent_end", async (_event, ctx) => {
					if (requested) {
						return;
					}
					requested = true;
					const request = await ctx.requestNewSession();
					if (request.queued) {
						completion = request.completion.then(
							() => {},
							() => {
								completionRejected = true;
							},
						);
					}
					pi.sendUserMessage("continue after failed replacement", { deliverAs: "followUp" });
				});
			},
			["first reply", "second reply"],
			{ bindCommandContext: false },
		);

		await runtime.session.prompt("start");
		await completion;

		expect(completionRejected).toBe(true);
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:start",
			"assistant:first reply",
			"user:continue after failed replacement",
			"assistant:second reply",
		]);
	});

	it("supports withSession for fork", async () => {
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("fork-it", {
					description: "fork-it",
					handler: async (_args, ctx) => {
						const leafId = ctx.sessionManager.getLeafId();
						if (!leafId) {
							throw new Error("Missing leaf id");
						}
						await ctx.fork(leafId, {
							position: "at",
							withSession: async (replacedCtx) => {
								await replacedCtx.sendUserMessage("fork callback message");
							},
						});
					},
				});
			},
			["seed reply", "fork reply"],
		);

		await runtime.session.prompt("seed");
		await runtime.session.prompt("/fork-it");

		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:seed",
			"assistant:seed reply",
			"user:fork callback message",
			"assistant:fork reply",
		]);
	});

	it("supports withSession for switchSession", async () => {
		let targetSessionPath = "";
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("switch-it", {
					description: "switch-it",
					handler: async (_args, ctx) => {
						await ctx.switchSession(targetSessionPath, {
							withSession: async (replacedCtx) => {
								await replacedCtx.sendUserMessage("switch callback message");
							},
						});
					},
				});
			},
			["root reply", "target reply", "switch reply"],
		);

		await runtime.session.prompt("root");
		const originalSessionPath = runtime.session.sessionFile;
		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.prompt("target");
		targetSessionPath = runtime.session.sessionFile!;
		await runtime.switchSession(originalSessionPath!);

		await runtime.session.prompt("/switch-it");

		expect(runtime.session.sessionFile).toBe(targetSessionPath);
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:target",
			"assistant:target reply",
			"user:switch callback message",
			"assistant:switch reply",
		]);
	});
});
