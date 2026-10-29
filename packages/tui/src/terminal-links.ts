import { sliceByColumn } from "./utils.ts";

export type LinkPolicy = (target: string) => string | undefined;
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/;

/** Generic transcript policy. Applications may supply a narrower or editor-aware policy. */
export const webLinkPolicy: LinkPolicy = (target) => {
	if (target.length > 4096 || CONTROLS.test(target)) return undefined;
	try {
		const url = new URL(target);
		if (CONTROLS.test(decodeURIComponent(target)) || url.username || url.password) return undefined;
		return ["http:", "https:", "mailto:"].includes(url.protocol) ? target : undefined;
	} catch {
		return undefined;
	}
};

/** Strip untrusted terminal commands before Markdown lexing or styling a label. */
export function sanitizeTerminalText(text: string): string {
	return text.replace(
		/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c|$)|\x1b[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
		"",
	);
}

const sgr = /\x1b\[[0-9;:]{0,128}m/y;
const osc8 = /\x1b\]8;(?:id=[A-Za-z0-9_-]{1,64})?;([\x21-\x7e]{0,4096})(?:\x07|\x1b\\)/y;
const marker = /\x1b(?:\]133;[ABC]|_pi:(?:c|fc|\/fc))\x07/y;
const up = /\x1b\[[1-9][0-9]{0,3}A/y;
const kittyHeader = /\x1b_G[A-Za-z]=[A-Za-z0-9]{1,16}(?:,[A-Za-z]=[A-Za-z0-9]{1,16})*/y;
const itermHeader =
	/\x1b\]1337;File=(?:inline|size|width|height|name|preserveAspectRatio)=[A-Za-z0-9+/=%.]{1,256}(?:;(?:inline|size|width|height|name|preserveAspectRatio)=[A-Za-z0-9+/=%.]{1,256})*:/y;

function base64(text: string): boolean {
	// Avoid a repeated-group regex on image-sized payloads (it can overflow the regexp stack).
	if (text.length % 4 !== 0) return false;
	const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
	return !/[^A-Za-z0-9+/]/.test(text.slice(0, text.length - padding));
}

function imageEnd(line: string, start: number): number | undefined {
	kittyHeader.lastIndex = start;
	const kitty = kittyHeader.exec(line);
	if (kitty) {
		const end = kittyHeader.lastIndex;
		if (line.startsWith("\x1b\\", end)) return end + 2;
		if (line[end] === ";") {
			const stop = line.indexOf("\x1b\\", end + 1);
			if (stop >= 0 && base64(line.slice(end + 1, stop))) return stop + 2;
		}
	}
	itermHeader.lastIndex = start;
	if (itermHeader.exec(line)) {
		const end = itermHeader.lastIndex;
		const stop = line.indexOf("\x07", end);
		if (stop >= 0 && base64(line.slice(end, stop))) return stop + 1;
	}
	return undefined;
}

/** S1: closed G1–G7 grammar, dropping only unrecognized ESC/C1, then cutting text only. */
export function neutralizeTerminalLinks(line: string, policy: LinkPolicy = webLinkPolicy, width = Infinity): string {
	if (!/[\x1b\u0080-\u009f]/.test(line)) return line;
	// The overwhelmingly common cold-history case needs no token allocation.
	if (line.includes("\x1b[") && !/[\x1b\u0080-\u009f]/.test(line.replace(/\x1b\[[0-9;:]{0,128}m/g, ""))) return line;
	const pieces: Array<{ text: string; token: boolean }> = [];
	let dropped = false;
	let image = false;
	let textStart = 0;
	let i = 0;
	while (i < line.length) {
		const c = line.charCodeAt(i);
		if (c !== 27 && !(c >= 128 && c <= 159)) {
			i++;
			continue;
		}
		if (i > textStart) pieces.push({ text: line.slice(textStart, i), token: false });
		let end: number | undefined;
		if (c === 27) {
			sgr.lastIndex = i;
			marker.lastIndex = i;
			osc8.lastIndex = i;
			if (sgr.exec(line)) end = sgr.lastIndex;
			else if (marker.exec(line)) end = marker.lastIndex;
			else {
				const link = osc8.exec(line);
				if (link && (!link[1] || policy(link[1]))) end = osc8.lastIndex;
				else {
					end = imageEnd(line, i);
					if (end !== undefined) image = true;
					else {
						up.lastIndex = i;
						if (up.exec(line) && imageEnd(line, up.lastIndex) !== undefined) end = up.lastIndex;
					}
				}
			}
		}
		if (end === undefined) {
			dropped = true;
			i++;
		} else {
			pieces.push({ text: line.slice(i, end), token: true });
			i = end;
		}
		textStart = i;
	}
	if (textStart < line.length) pieces.push({ text: line.slice(textStart), token: false });
	if (!dropped) return line;
	const text = pieces
		.filter((piece) => !piece.token)
		.map((piece) => piece.text)
		.join("");
	let remaining = image
		? 0
		: Number.isFinite(width)
			? sliceByColumn(text, 0, Math.max(0, width), true).length
			: text.length;
	return pieces
		.map((piece) => {
			if (piece.token) return piece.text;
			const keep = piece.text.slice(0, remaining);
			remaining -= keep.length;
			return keep;
		})
		.join("");
}

/** Frame-bounded cache: positional hits avoid rebuilding a history-sized map for a streaming row. */
export class TerminalLinkFilter {
	private previous = new Map<string, string>();
	private previousLines: readonly string[] = [];
	private previousOutput: string[] = [];
	private width = 0;
	private policy: LinkPolicy | undefined;
	filter(lines: string[], policy: LinkPolicy, width: number): string[] {
		const samePolicy = this.policy === policy && this.width === width;
		if (!samePolicy) {
			this.previous.clear();
			this.previousLines = [];
			this.previousOutput = [];
		}
		this.policy = policy;
		this.width = width;
		let result: string[] | undefined;
		const changed: number[] = [];
		const count = Math.max(lines.length, this.previousLines.length);
		for (let index = 0; index < count; index++) {
			if (lines[index] === this.previousLines[index]) continue;
			result ??= this.previousOutput.slice();
			changed.push(index);
			const line = lines[index];
			if (line !== undefined)
				result[index] = this.previous.get(line) ?? neutralizeTerminalLinks(line, policy, width);
		}
		if (!result) return this.previousOutput;
		result.length = lines.length;
		// All lookups precede pruning: moved lines still hit the previous generation.
		// Removing a duplicate key is harmless: unchanged positions retain their cached output.
		for (const index of changed) {
			const old = this.previousLines[index];
			if (old !== undefined) this.previous.delete(old);
		}
		for (const index of changed) {
			const line = lines[index];
			if (line !== undefined) this.previous.set(line, result[index]);
		}
		this.previousLines = [...lines];
		this.previousOutput = result;
		return result;
	}
}
