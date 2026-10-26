import { resolvePath } from "../utils/paths.ts";
import type { ProjectTrustContext, ReplacedSessionContext } from "./extensions/types.ts";

export interface ChangeCwdOptions {
	source: "user" | "model";
	reason?: string;
	requestId?: string;
	projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}

export type ChangeCwdResult =
	| { changed: true; from: string; to: string; warning?: string; heldSettings?: string }
	| { changed: false; error: string };

export type CwdChangeCompletion = "applied" | "cancelled" | "untrusted" | "failed";
export type RequestCwdChangeResult =
	| { status: "pending"; requestId: string; from: string; to: string; completion: Promise<CwdChangeCompletion> }
	| { status: "rejected"; reason: string };
export type CwdChangeHandler = (target: string, options: ChangeCwdOptions) => Promise<ChangeCwdResult>;
export type RequestCwdChange = (path: string, options?: { reason?: string }) => RequestCwdChangeResult;

export interface PendingCwdChange {
	requestId: string;
	from: string;
	to: string;
	reason?: string;
	source: "user" | "model";
	state: "pending" | "trust" | "applying";
	trusted?: boolean;
	resolve: (outcome: CwdChangeCompletion) => void;
}

export function resolveCwdTarget(input: string, cwd: string): string {
	let path = input.trim();
	if (
		path.length >= 2 &&
		((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")))
	)
		path = path.slice(1, -1);
	if (!path) throw new Error("Not changed: cd needs a directory in args.");
	return resolvePath(path, cwd);
}

export function cwdAppliedNotice(from: string, to: string): string {
	return `Working-directory change (not a request). At this point the session's working directory changed from ${from} to ${to}. Paths in earlier messages keep the meaning they had when those messages were written. Background tasks started before this point keep their own working directories.`;
}
