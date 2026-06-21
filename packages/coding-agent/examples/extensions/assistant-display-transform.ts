/**
 * Assistant message display transform example.
 *
 * Keeps a raw boundary marker in assistant messages for persistence/provider
 * context, but renders a friendly status line in the interactive TUI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUBMIT_WORK_MARKER = "<submit_work/>";
const SUBMITTED_LABEL = "Plan submitted";

type FenceMarker = "`" | "~";

function fenceMarkerForLine(line: string): FenceMarker | undefined {
	const match = /^( {0,3})(`{3,}|~{3,})/.exec(line);
	if (!match) return undefined;
	return match[2]?.startsWith("`") ? "`" : "~";
}

function lineFenceStates(lines: string[]): boolean[] {
	const states: boolean[] = [];
	let openFence: FenceMarker | undefined;

	for (const line of lines) {
		states.push(openFence !== undefined);
		const marker = fenceMarkerForLine(line);
		if (!marker) continue;
		if (openFence === undefined) {
			openFence = marker;
		} else if (openFence === marker) {
			openFence = undefined;
		}
	}

	return states;
}

function replaceFinalBoundaryMarker(text: string): string | undefined {
	const lines = text.split("\n");
	const fenceStates = lineFenceStates(lines);
	let markerLineIndex = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i]?.trim().length) {
			markerLineIndex = i;
			break;
		}
	}
	if (markerLineIndex < 0) return undefined;
	if (fenceStates[markerLineIndex]) return undefined;
	if (lines[markerLineIndex]?.trim() !== SUBMIT_WORK_MARKER) return undefined;

	const nextLines = [...lines];
	nextLines[markerLineIndex] = SUBMITTED_LABEL;
	return nextLines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerAssistantMessageDisplayTransform("pi-collaboration-modes", (message) => {
		let changed = false;
		const content = message.content.map((block) => {
			if (block.type !== "text") return block;
			const text = replaceFinalBoundaryMarker(block.text);
			if (text === undefined) return block;
			changed = true;
			return { ...block, text };
		});

		return changed ? content : undefined;
	});
}
