import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness } from "./harness.ts";

export async function cwdFixture(
	options: { extension?: ExtensionFactory; settings?: Settings; tools?: string[]; persist?: boolean } = {},
) {
	const seed = await createHarness({
		models: [
			{ id: "a", reasoning: true },
			{ id: "b", reasoning: true },
		],
	});
	const root = mkdtempSync(join(tmpdir(), "pi-cwd-runtime-"));
	const a = join(root, "a");
	const b = join(root, "b");
	const agentDir = join(root, "agent");
	for (const path of [a, b, agentDir]) mkdirSync(path, { recursive: true });
	writeFileSync(join(a, "AGENTS.md"), "Instructions for A");
	writeFileSync(join(b, "AGENTS.md"), "Instructions for B");
	const factories: string[] = [];
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent, carry }) => {
		factories.push(cwd);
		const settingsManager = SettingsManager.create(cwd, agentDir);
		if (options.settings) settingsManager.applyOverrides(options.settings);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			resourceLoaderOptions: {
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				extensionFactories: [
					(pi) => {
						pi.registerProvider(seed.getModel().provider, {
							baseUrl: seed.getModel().baseUrl,
							apiKey: "faux-key",
							api: seed.faux.api,
							models: seed.models.map((m) => ({ ...m, compat: { supportsMidConvoSystemMessages: true } })),
						});
						options.extension?.(pi);
					},
				],
			},
		});
		return {
			services,
			diagnostics: [],
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				carry,
				tools: options.tools,
				model: carry ? undefined : services.modelRuntime.getModel(seed.getModel().provider, seed.getModel().id),
				thinkingLevel: carry ? undefined : "low",
			})),
		};
	};
	const manager = options.persist ? SessionManager.create(a, join(root, "sessions-a")) : SessionManager.inMemory(a);
	const runtime = await createAgentSessionRuntime(factory, { cwd: a, agentDir, sessionManager: manager });
	runtime.setSessionDirResolver((cwd) => join(root, cwd === a ? "sessions-a" : "sessions-b"));
	runtime.setRebindSession(async (session) => session.bindExtensions({ mode: "tui" }));
	await runtime.session.bindExtensions({ mode: "tui" });
	seed.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage("ok")));
	return {
		runtime,
		seed,
		root,
		a,
		b,
		agentDir,
		factories,
		cleanup: async () => {
			await runtime.dispose();
			seed.cleanup();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
