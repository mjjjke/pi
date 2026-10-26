import type { SessionDirResolver } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { resolvePath } from "../utils/paths.ts";
import type { Args } from "./args.ts";

/** A cwd transfer restores the live selection, not the launch selection. Other flags still apply. */
export function cwdSessionArgs(parsed: Args): Args {
	return { ...parsed, provider: undefined, model: undefined, thinking: undefined };
}

/** Match a launch in the destination, while keeping flag/env paths launch-relative. */
export function createCwdSessionDirResolver(options: {
	launchCwd: string;
	agentDir: string;
	flag?: string;
	environment?: string;
}): SessionDirResolver {
	const fixed = options.flag ?? options.environment;
	const launchDir = fixed ? resolvePath(fixed, options.launchCwd) : undefined;
	return (cwd) => {
		if (launchDir) return launchDir;
		const setting = SettingsManager.create(cwd, options.agentDir).getSessionDir();
		return setting ? resolvePath(setting, cwd) : undefined;
	};
}
