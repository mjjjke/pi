import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
	authorizeBrowserUrl,
	authorizeLinkTarget,
	openTranscriptLink,
	transcriptSinkPolicy,
} from "../src/utils/link-policy.ts";

const dir = mkdtempSync(join(process.env.PI_SCRATCH_DIR ?? "/tmp", "links-"));
const file = join(dir, "a #é%00.ts");
writeFileSync(file, "");
mkdirSync(join(dir, "folder"));
writeFileSync(join(dir, "ambiguous:12"), "");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
describe("browser authorization", () => {
	for (const url of ["https://example.com/a", "http://localhost:123/a", "http://127.0.0.1/a", "http://[::1]/"])
		it(url, () => expect(authorizeBrowserUrl(url)).toBe(new URL(url).href));
	for (const url of [
		"http://example.com/",
		"smb://host/share",
		"file:///x.desktop",
		"zed://file/x",
		"ssh://host/",
		"https://user:pass@x/",
		"https://x/%00",
		"https://x/\x1b]0;title\x07",
	])
		it(`refuses ${JSON.stringify(url)}`, () => expect(authorizeBrowserUrl(url)).toBeUndefined());
});
it("canonical editor construction, decoding exactly once, position and file checks", () => {
	const target = authorizeLinkTarget(pathToFileURL(file).href, { editorLinks: "zed", line: 12, col: 3 });
	expect(target).toBe(`zed://file${pathToFileURL(file).pathname}:12:3`);
	expect(authorizeLinkTarget(target!, { editorLinks: "zed" })).toBe(target);
	expect(authorizeLinkTarget(pathToFileURL(file).href, { editorLinks: "file" })).toBeUndefined();
	for (const url of [
		"zed://ssh/x",
		"zed://file/x?x",
		"file://host/x",
		pathToFileURL(join(dir, "folder")).href,
		pathToFileURL(join(dir, "ambiguous:12")).href,
		"zed://file/x%00:1",
		"zed://file/x:0",
	])
		expect(authorizeLinkTarget(url, { editorLinks: "zed" })).toBeUndefined();
	expect(transcriptSinkPolicy("zed")("zed://file/x%00:1")).toBeUndefined();
});
it("click reauthorizes before invoking an injected opener", () => {
	const open = vi.fn();
	const target = authorizeLinkTarget(pathToFileURL(file).href, { editorLinks: "zed" })!;
	expect(openTranscriptLink(target, { editorLinks: "zed" }, open)).toBeUndefined();
	expect(open).toHaveBeenCalledExactlyOnceWith(target);
	expect(openTranscriptLink("smb://host/share", { editorLinks: "zed" }, open)).toContain("Not opened");
	expect(open).toHaveBeenCalledTimes(1);
});
