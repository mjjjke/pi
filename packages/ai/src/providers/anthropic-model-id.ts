/** Parse a native Claude family/version id, optionally suffixed with an eight-digit date. */
export function parseAnthropicModelId(
	id: string | undefined,
): { family: string; major: number; minor: number } | undefined {
	const match = id?.toLowerCase().match(/^claude-([a-z]+)-(\d+)(?:[.-](\d{1,2}))?(?:-\d{8})?$/);
	if (!match) return undefined;
	return { family: match[1], major: Number(match[2]), minor: Number(match[3] ?? "0") };
}
