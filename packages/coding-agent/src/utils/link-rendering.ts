import { setImageLinkPolicy, setMarkdownLinkOptions, type TUI, TuiAltScreen } from "@earendil-works/pi-tui";
import { LinkDetector } from "./link-detector.ts";
import { authorizeLinkTarget, type EditorLinks, transcriptSinkPolicy } from "./link-policy.ts";

let editorLinks: EditorLinks = "file";
export function getEditorLinks(): EditorLinks {
	return editorLinks;
}

/** Like the active theme, transcript rendering settings belong to the active interactive presentation. */
export function configureLinkRendering(tui: TUI, cwd: string, editor: EditorLinks, modifier: "ctrl" | "none"): void {
	editorLinks = editor;
	const detector = new LinkDetector(cwd, editor);
	setMarkdownLinkOptions({ linkPolicy: detector.authorize, linkify: detector.linkify });
	setImageLinkPolicy((target) => authorizeLinkTarget(target, { editorLinks: editor, origin: "imageFallback" }));
	tui.setLinkPolicy(transcriptSinkPolicy(editor));
	if (tui instanceof TuiAltScreen) tui.setLinkOpenModifier(modifier);
	tui.invalidate();
}
