/**
 * An AgentSessionRuntime over the faux provider with a file-backed session in a temp directory, for
 * tests of session replacement (`/new`, `/resume`) and file creation. The runtime rebinds each new
 * session as the modes do.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/index.ts";

export interface RuntimeHarness {
	runtime: AgentSessionRuntime;
	faux: FauxProviderRegistration;
	tempDir: string;
	sessionDir: string;
	cleanup: () => Promise<void>;
}

export async function createRuntimeHarness(extensionFactory: ExtensionFactory = () => {}): Promise<RuntimeHarness> {
	const tempDir = join(tmpdir(), `pi-runtime-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sessionDir = join(tempDir, "sessions");
	mkdirSync(sessionDir, { recursive: true });
	const faux = registerFauxProvider();
	faux.setResponses([]);
	const model = faux.getModel();

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: tempDir,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(model.provider, {
							baseUrl: model.baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registered) => ({
								id: registered.id,
								name: registered.name,
								api: registered.api,
								reasoning: registered.reasoning,
								input: registered.input,
								cost: registered.cost,
								contextWindow: registered.contextWindow,
								maxTokens: registered.maxTokens,
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
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: SessionManager.create(tempDir, sessionDir),
	});
	runtime.setRebindSession((session) => session.bindExtensions({}));
	await runtime.session.bindExtensions({});

	return {
		runtime,
		faux,
		tempDir,
		sessionDir,
		async cleanup() {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}
