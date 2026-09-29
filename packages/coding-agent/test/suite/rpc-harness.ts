/**
 * RPC mode harness for suite tests: a real AgentSessionRuntime (faux provider, session
 * persisted in a temp dir) driven through runRpcMode.
 *
 * runRpcMode writes to stdout and reads stdin through `output-guard` and `jsonl`. Test
 * files must mock both modules (vi.mock is hoisted per test file) and route them
 * through an RpcIo object created with `vi.hoisted`; see `rpc-prompt-literal.test.ts`.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { expect, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/index.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";

export interface RpcIo {
	outputLines: string[];
	lineHandler: ((line: string) => void) | undefined;
}

export type RpcRecord = Record<string, unknown>;

export interface RpcHarness {
	runtime: AgentSessionRuntime;
	faux: FauxProviderRegistration;
	tempDir: string;
	send(command: Record<string, unknown>): void;
	records(): RpcRecord[];
	responses(id: string): RpcRecord[];
	waitForResponse(id: string): Promise<RpcRecord>;
	cleanup(): Promise<void>;
}

export interface RpcHarnessOptions {
	extensionFactory?: ExtensionFactory;
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
}

function parseRecords(lines: string[]): RpcRecord[] {
	return lines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as RpcRecord);
}

export async function createRpcHarness(io: RpcIo, options: RpcHarnessOptions = {}): Promise<RpcHarness> {
	io.outputLines = [];
	io.lineHandler = undefined;
	const tempDir = join(tmpdir(), `pi-rpc-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const faux = registerFauxProvider();
	faux.setResponses([]);
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

	const runtimeOptions = {
		agentDir: tempDir,
		authStorage,
		model: faux.getModel(),
		resourceLoaderOptions: {
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.registerProvider(faux.getModel().provider, {
						baseUrl: faux.getModel().baseUrl,
						apiKey: "faux-key",
						api: faux.api,
						models: faux.models.map((model) => ({
							id: model.id,
							name: model.name,
							api: model.api,
							reasoning: model.reasoning,
							input: model.input,
							cost: model.cost,
							contextWindow: model.contextWindow,
							maxTokens: model.maxTokens,
						})),
					});
					options.extensionFactory?.(pi);
				},
			],
			additionalSkillPaths: options.additionalSkillPaths,
			additionalPromptTemplatePaths: options.additionalPromptTemplatePaths,
			noSkills: options.additionalSkillPaths === undefined,
			noPromptTemplates: options.additionalPromptTemplatePaths === undefined,
			noThemes: true,
		},
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: runtimeOptions.model,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
	});

	void runRpcMode(runtime);
	await vi.waitFor(() => expect(io.lineHandler).toBeDefined());

	const records = () => parseRecords(io.outputLines);
	const responses = (id: string) => records().filter((record) => record.type === "response" && record.id === id);

	return {
		runtime,
		faux,
		tempDir,
		send(command) {
			io.lineHandler?.(JSON.stringify(command));
		},
		records,
		responses,
		async waitForResponse(id) {
			await vi.waitFor(() => expect(responses(id)).toHaveLength(1));
			return responses(id)[0];
		},
		async cleanup() {
			try {
				await runtime.session.abort();
			} catch {
				// ignore cleanup failures
			}
			runtime.session.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}
