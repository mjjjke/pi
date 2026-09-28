import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGeneratedCapabilities } from "../scripts/fork-model-capabilities.ts";
import { MODEL_DATA_MANIFEST_FILE, validateModelDataDirectory } from "../scripts/model-data.ts";
import { buildPinnedModelData, writePinnedModelData } from "../scripts/pin-release-model-data.ts";
import type { Api, Model } from "../src/types.ts";

function model(overrides: Partial<Model<Api>> & Pick<Model<Api>, "id" | "provider" | "api">): Model<Api> {
	return {
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
		write("anthropic.json", { "anthropic-messages": { [anthropicModel.id]: anthropicModel } });
		write("openai-codex.json", { "openai-codex-responses": { [codexModel.id]: codexModel } });
		write("xai.json", { "openai-responses": { [plainModel.id]: plainModel } });
		write(MODEL_DATA_MANIFEST_FILE, { schemaVersion: 3, generatedAt: "2026-09-22T19:00:00.000Z", files: {} });
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
			expect(read(file)[api][source.id].capabilities).toEqual(expected);
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
});
