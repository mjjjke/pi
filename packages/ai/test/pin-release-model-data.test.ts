import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyForkModelData, getGeneratedCapabilities } from "../scripts/fork-model-capabilities.ts";
import { MODEL_DATA_MANIFEST_FILE, validateModelDataDirectory } from "../scripts/model-data.ts";
import { buildPinnedModelData, writePinnedModelData } from "../scripts/pin-release-model-data.ts";
import type { Api, Model } from "../src/types.ts";

function model(overrides: Partial<Model<Api>> & Pick<Model<Api>, "id" | "provider" | "api">): Model<Api> {
	return {
		type: "chat",
		name: overrides.id,
		baseUrl: "https://example.test",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 64000,
		...overrides,
	} as Model<Api>;
}

const anthropicModel = model({ id: "claude-opus-4-6", provider: "anthropic", api: "anthropic-messages" });
const codexModel = model({ id: "gpt-5.5", provider: "openai-codex", api: "openai-codex-responses" });
const plainModel = model({ id: "grok-4.3", provider: "xai", api: "openai-responses" });

describe("pin-release-model-data", () => {
	let root: string;
	let sourceDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pin-model-data-"));
		sourceDir = join(root, "release-data");
		mkdirSync(sourceDir);
		const write = (file: string, value: unknown) =>
			writeFileSync(join(sourceDir, file), `${JSON.stringify(value)}\n`);
		write("anthropic.json", { "anthropic-messages": { [`chat:${anthropicModel.id}`]: anthropicModel } });
		write("openai-codex.json", { "openai-codex-responses": { [`chat:${codexModel.id}`]: codexModel } });
		write("xai.json", { "openai-responses": { [`chat:${plainModel.id}`]: plainModel } });
		write(MODEL_DATA_MANIFEST_FILE, { schemaVersion: 6, generatedAt: "2026-09-22T19:00:00.000Z", files: {} });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("applies the fork capabilities exactly as the generator does", () => {
		const pinned = buildPinnedModelData(sourceDir, ["anthropic", "openai-codex", "xai"]);
		const read = (file: string) => JSON.parse(pinned.fileContents[file]);

		for (const [file, api, source] of [
			["anthropic.json", "anthropic-messages", anthropicModel],
			["openai-codex.json", "openai-codex-responses", codexModel],
			["xai.json", "openai-responses", plainModel],
		] as const) {
			const expected = getGeneratedCapabilities(structuredClone(source));
			expect(read(file)[api][`chat:${source.id}`].capabilities).toEqual(expected);
		}
	});

	it("keeps the release generation timestamp", () => {
		const pinned = buildPinnedModelData(sourceDir, ["anthropic", "openai-codex", "xai"]);
		expect(pinned.manifest.generatedAt).toBe("2026-09-22T19:00:00.000Z");
	});

	it("rejects release data whose providers differ from the tracked shards", () => {
		expect(() => buildPinnedModelData(sourceDir, ["anthropic", "openai-codex"])).toThrow(/extra: xai/);
		expect(() => buildPinnedModelData(sourceDir, ["anthropic", "openai-codex", "xai", "zai"])).toThrow(
			/missing: zai/,
		);
	});

	it("writes a data directory that passes model data validation", () => {
		const pinned = buildPinnedModelData(sourceDir, ["anthropic", "openai-codex", "xai"]);
		const dataDir = join(root, "providers", "data");
		mkdirSync(join(root, "providers"));
		writePinnedModelData(pinned, dataDir);

		expect(() => validateModelDataDirectory(pinned.structure, dataDir)).not.toThrow();
		expect(readFileSync(join(dataDir, "xai.json"), "utf8")).toBe(pinned.fileContents["xai.json"]);
	});

	it("is deterministic", () => {
		const a = buildPinnedModelData(sourceDir, ["anthropic", "openai-codex", "xai"]);
		const b = buildPinnedModelData(sourceDir, ["anthropic", "openai-codex", "xai"]);
		expect(b).toEqual(a);
	});

	it("sets supportsMidConvoSystemMessages for the first-party OpenAI models of the fork compat patch", () => {
		const nano = model({ id: "gpt-5.4-nano", provider: "openai", api: "openai-responses" });
		const pro = model({ id: "gpt-5.5-pro", provider: "openai", api: "openai-responses" });
		const other = model({ id: "gpt-5.4-nano", provider: "openrouter", api: "openai-completions" });
		const write = (file: string, value: unknown) =>
			writeFileSync(join(sourceDir, file), `${JSON.stringify(value)}\n`);
		write("openai.json", {
			"openai-responses": { [`chat:${nano.id}`]: nano, [`chat:${pro.id}`]: pro },
		});
		write("openrouter.json", { "openai-completions": { [`chat:${other.id}`]: other } });
		const pinned = buildPinnedModelData(sourceDir, ["anthropic", "openai", "openai-codex", "openrouter", "xai"]);
		const openai = JSON.parse(pinned.fileContents["openai.json"])["openai-responses"];
		expect(openai[`chat:${nano.id}`].compat).toEqual({ supportsMidConvoSystemMessages: true });
		expect(openai[`chat:${pro.id}`].compat).toEqual({ supportsMidConvoSystemMessages: true });
		const openrouter = JSON.parse(pinned.fileContents["openrouter.json"])["openai-completions"];
		expect(openrouter[`chat:${other.id}`].compat).toBeUndefined();
		const patched = structuredClone(nano);
		applyForkModelData(patched);
		expect(patched).toEqual(openai[`chat:${nano.id}`]);
	});

	it("generate-models applies the same fork patch", () => {
		const source = readFileSync(join(import.meta.dirname, "../scripts/generate-models.ts"), "utf8");
		expect(source).toContain("applyForkModelData(model)");
		expect(source).not.toContain("getGeneratedCapabilities(model)");
	});
});
