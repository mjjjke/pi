#!/usr/bin/env node
// Fork-only: replace the ignored generated model data (src/providers/data) with
// the catalog published in the @earendil-works/pi-ai release tarball, plus the
// fork's model capabilities. Keeps the fork's data equal to the release its
// tests were written against, instead of whatever the live catalogs return
// today. Build with `npm run build:offline` afterwards. See FORK.md.
//
// Usage: node packages/ai/scripts/pin-release-model-data.ts [--version X.Y.Z] [--from <data dir>]
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Api, Model } from "../src/types.ts";
import { getGeneratedCapabilities } from "./fork-model-capabilities.ts";
import {
	assertExactModelIds,
	createModelDataManifest,
	MODEL_DATA_MANIFEST_FILE,
	type ModelDataManifest,
	type ModelDataStructure,
	readModelDataProviderIds,
	validateModelDataDirectory,
} from "./model-data.ts";

export interface PinnedModelData {
	structure: ModelDataStructure;
	fileContents: Record<string, string>;
	manifest: ModelDataManifest;
}

type ProviderGroups = Record<string, Record<string, Model<Api>>>;

export function buildPinnedModelData(sourceDataDir: string, providerIds: readonly string[]): PinnedModelData {
	const sourceProviderIds = readdirSync(sourceDataDir)
		.filter((entry) => entry.endsWith(".json") && entry !== MODEL_DATA_MANIFEST_FILE)
		.map((entry) => entry.slice(0, -".json".length));
	assertExactModelIds("Release data providers vs tracked shards", providerIds, sourceProviderIds);

	const sourceManifest = JSON.parse(readFileSync(join(sourceDataDir, MODEL_DATA_MANIFEST_FILE), "utf8")) as {
		generatedAt?: unknown;
	};
	if (typeof sourceManifest.generatedAt !== "string") {
		throw new Error(`${join(sourceDataDir, MODEL_DATA_MANIFEST_FILE)} has no generatedAt timestamp`);
	}

	const structure: ModelDataStructure = {};
	const fileContents: Record<string, string> = {};
	for (const providerId of [...providerIds].sort()) {
		const filename = `${providerId}.json`;
		const groups = JSON.parse(readFileSync(join(sourceDataDir, filename), "utf8")) as ProviderGroups;
		structure[providerId] = {};
		for (const [api, models] of Object.entries(groups)) {
			for (const [modelId, model] of Object.entries(models)) {
				const capabilities = getGeneratedCapabilities(model);
				if (capabilities) model.capabilities = capabilities;
				structure[providerId][modelId] = api;
			}
		}
		fileContents[filename] = `${JSON.stringify(groups)}\n`;
	}

	return {
		structure,
		fileContents,
		manifest: createModelDataManifest(structure, fileContents, sourceManifest.generatedAt),
	};
}

export function writePinnedModelData(pinned: PinnedModelData, dataDir: string): void {
	const parentDir = dirname(dataDir);
	const stagingRoot = mkdtempSync(join(parentDir, ".model-pin-"));
	const stagedDataDir = join(stagingRoot, "data");
	const previousDataDir = join(stagingRoot, "previous-data");
	try {
		mkdirSync(stagedDataDir);
		for (const [filename, content] of Object.entries(pinned.fileContents)) {
			writeFileSync(join(stagedDataDir, filename), content);
		}
		writeFileSync(join(stagedDataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(pinned.manifest)}\n`);
		validateModelDataDirectory(pinned.structure, stagedDataDir);

		const hadPreviousData = existsSync(dataDir);
		if (hadPreviousData) renameSync(dataDir, previousDataDir);
		try {
			renameSync(stagedDataDir, dataDir);
		} catch (error) {
			if (hadPreviousData) renameSync(previousDataDir, dataDir);
			throw error;
		}
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
	}
}

function readArgs(argv: string[]): { version?: string; from?: string } {
	const args: { version?: string; from?: string } = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--version" || arg === "--from") {
			const value = argv[++i];
			if (!value) throw new Error(`${arg} requires a value`);
			args[arg === "--version" ? "version" : "from"] = value;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

function extractReleaseData(version: string, workDir: string): string {
	const spec = `@earendil-works/pi-ai@${version}`;
	const tarball = execFileSync("npm", ["pack", spec, "--silent", "--pack-destination", workDir], {
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.at(-1);
	if (!tarball) throw new Error(`npm pack ${spec} returned no tarball name`);
	execFileSync("tar", ["xzf", join(workDir, tarball), "-C", workDir]);
	const dataDir = join(workDir, "package", "dist", "providers", "data");
	if (!existsSync(dataDir)) throw new Error(`${spec} has no dist/providers/data`);
	return dataDir;
}

function main(): void {
	const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	const args = readArgs(process.argv.slice(2));
	const version =
		args.version ??
		(JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string }).version;
	const workDir = mkdtempSync(join(tmpdir(), "pi-ai-release-data-"));
	try {
		const sourceDataDir = args.from ?? extractReleaseData(version, workDir);
		const pinned = buildPinnedModelData(sourceDataDir, readModelDataProviderIds(packageRoot));
		writePinnedModelData(pinned, join(packageRoot, "src", "providers", "data"));
		const withCapabilities = Object.values(pinned.fileContents).reduce(
			(count, content) => count + (content.match(/"capabilities":/g)?.length ?? 0),
			0,
		);
		console.log(
			`Pinned model data to ${args.from ?? `@earendil-works/pi-ai@${version}`} ` +
				`(${Object.keys(pinned.fileContents).length} providers, ${withCapabilities} models with fork capabilities).`,
		);
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
