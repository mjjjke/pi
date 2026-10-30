import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	backgroundAnsi,
	colorToOklch,
	colorToRgb,
	getPointerHoverBackground,
	parseColor,
	type RgbColor,
	rgbColor,
	setPointerHoverBackground,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import {
	generateSystemThemeColors,
	type SystemThemeInput,
	wcagContrast,
} from "../src/modes/interactive/theme/system-theme.ts";
import {
	initTheme,
	loadThemeFromPath,
	setTheme,
	setThemeJsonValidator,
	type ThemeColor,
	theme,
} from "../src/modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../src/modes/interactive/theme/theme-schema.ts";
import { createInteractiveTui } from "../src/modes/interactive/tui-renderer.ts";

setThemeJsonValidator(validateThemeJson);
const rgb = (value: string): RgbColor => colorToRgb(parseColor(value));
const lightness = (value: string): number => colorToOklch(parseColor(value)).l;
const tempDirs: string[] = [];
const palette = [
	"#21222c",
	"#ff5555",
	"#50fa7b",
	"#f1fa8c",
	"#bd93f9",
	"#ff79c6",
	"#8be9fd",
	"#f8f8f2",
	"#6272a4",
	"#ff6e6e",
	"#69ff94",
	"#ffffa5",
	"#d6acff",
	"#ff92df",
	"#a4ffff",
	"#ffffff",
].map(rgb);
const terminals: Record<string, SystemThemeInput> = {
	darkPalette: { background: rgb("#282a36"), foreground: rgb("#f8f8f2"), palette },
	lightPalette: { background: rgb("#fdf6e3"), foreground: rgb("#303030"), palette },
	darkBackgroundOnly: { background: rgb("#1e1e1e") },
	lightBackgroundOnly: { background: rgb("#ffffff") },
	grayscale: { background: rgb("#282a36"), palette, saturation: 0 },
	midGray: { background: rgb("#808080"), foreground: rgb("#ffffff") },
};
const rowColors: ThemeColor[] = [
	"text",
	"accent",
	"success",
	"error",
	"warning",
	"muted",
	"dim",
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
];

function builtin(name: string): { name: string; colors: Record<string, string | number> } {
	return JSON.parse(readFileSync(new URL(`../src/modes/interactive/theme/${name}.json`, import.meta.url), "utf8"));
}

afterEach(() => {
	setPointerHoverBackground(undefined);
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("hover theme", () => {
	it("falls back to toolPendingBg for themes that omit hoverBg", () => {
		const json = builtin("dark");
		delete json.colors.hoverBg;
		const dir = mkdtempSync(join(tmpdir(), "pi-hover-theme-"));
		tempDirs.push(dir);
		const path = join(dir, "legacy.json");
		writeFileSync(path, JSON.stringify(json));
		const theme = loadThemeFromPath(path, "truecolor");
		expect(theme.getBgAnsi("hoverBg")).toBe(theme.getBgAnsi("toolPendingBg"));
	});

	it.each([
		["dark", "okhsl(229 5% 18%)", "#21252c"],
		["light", "okhsl(235 12% 95%)", "#ffffff"],
	])("gives %s its specified neutral hover, distinct from selection and page", (name, value, page) => {
		const json = builtin(name);
		expect(json.colors.hoverBg).toBe(value);
		const path = new URL(`../src/modes/interactive/theme/${name}.json`, import.meta.url).pathname;
		for (const mode of ["truecolor", "256color"] as const) {
			const theme = loadThemeFromPath(path, mode);
			expect(theme.getBgAnsi("hoverBg")).not.toBe(theme.getBgAnsi("selectedBg"));
			expect(theme.getBgAnsi("hoverBg")).not.toBe(backgroundAnsi(parseColor(page), mode));
		}
		expect(wcagContrast(rgb(value), rgb(page))).toBeGreaterThan(1.05);
	});

	it("accepts optional hoverBg in the runtime and published schemas", () => {
		const json = builtin("dark");
		json.colors.hoverBg = "#123456";
		expect(() => validateThemeJson("hover", json)).not.toThrow();
		const schema = JSON.parse(readFileSync(new URL("../schemas/theme.schema.json", import.meta.url), "utf8"));
		expect(schema.properties.colors.properties.hoverBg).toBeDefined();
		expect(schema.properties.colors.required).not.toContain("hoverBg");
	});

	it.each(Object.entries(terminals))(
		"derives a weaker neutral hover and readable row/effort colors: %s",
		(name, input) => {
			const { colors } = generateSystemThemeColors(input);
			const hover = colors.hoverBg as string;
			expect(hover).toMatch(/^#[0-9a-f]{6}$/);
			const backgroundL = colorToOklch(rgbColor(input.background!.r, input.background!.g, input.background!.b)).l;
			const distance = Math.abs(lightness(hover) - backgroundL);
			const panelDistance = Math.abs(lightness(colors.toolPendingBg as string) - backgroundL);
			expect(distance, name).toBeLessThan(panelDistance);
			// Away from limiting/relaxation, the neutral panel and hover use exactly the same construction.
			if (name !== "midGray") expect(distance / panelDistance, name).toBeCloseTo(0.5, 1);
			for (const token of rowColors) {
				const value = colors[token];
				const foreground = value === "" ? input.foreground! : rgb(value as string);
				expect(wcagContrast(foreground, rgb(hover)), `${name} ${token}`).toBeGreaterThan(
					token === "text" ? 4.49 : 1.5,
				);
			}
			if (input.saturation === 0) expect(colorToOklch(parseColor(hover)).c).toBeLessThan(0.005);
		},
	);

	it("wires a live hover provider in the fullscreen composition root", () => {
		initTheme("dark");
		createInteractiveTui({
			tuiMode: "fullscreen",
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal: new VirtualTerminal(),
		});
		const dark = getPointerHoverBackground();
		expect(dark).toBe(theme.getBgAnsi("hoverBg"));
		expect(setTheme("light").success).toBe(true);
		expect(getPointerHoverBackground()).toBe(theme.getBgAnsi("hoverBg"));
		expect(getPointerHoverBackground()).not.toBe(dark);
	});

	it("uses no hover background or faint-background marker without terminal reports", () => {
		for (const input of [{}, { saturation: 0 }, { appearanceHint: "light" as const }]) {
			const result = generateSystemThemeColors(input);
			expect(result.colors.hoverBg).toBe("");
			expect(result.dim).not.toContain("hoverBg");
		}
	});
});
