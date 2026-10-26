import { type Component, Container, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { cwdAppliedNotice, formatCwdWarning, resolveCwdTarget } from "../src/core/cwd-change.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const prototype = InteractiveMode.prototype as unknown as {
	handleCdCommand(this: object, args: string): Promise<void>;
};

function invoke(name: string, mode: object, ...args: unknown[]): unknown {
	return Reflect.apply(Reflect.get(InteractiveMode.prototype, name), mode, args);
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function footerRebindHarness(height = 1) {
	const frames: string[][] = [];
	const footerContainer = new Container();
	const oldFooter = {
		render: vi.fn(() => Array.from({ length: height }, () => "old custom footer")),
		invalidate() {},
		dispose: vi.fn(),
	};
	footerContainer.addChild(oldFooter);
	const mode = {
		footerContainer,
		customFooter: oldFooter as (Component & { dispose?(): void }) | undefined,
		footer: { render: () => ["destination built-in footer"], invalidate: vi.fn() },
		footerDataProvider: { clearExtensionStatuses: vi.fn() },
		defaultEditor: {},
		editor: { render: () => [], invalidate() {} },
		editorContainer: new Container(),
		ui: {
			terminal: { columns: 80 },
			hideOverlay: vi.fn(),
			setFocus: vi.fn(),
			requestRender: () => {
				frames.push(footerContainer.render(80));
			},
		},
		runtimeHost: {
			session: {
				reload: vi.fn(async (_options: { beforeSessionStart: () => void }) => {}),
				settingsManager: { getHideThinkingBlock: () => false, getOutputPad: () => 1 },
				resourceLoader: { getThemes: () => ({ themes: [] }) },
				modelRuntime: { getError: () => undefined },
			},
		},
		programStatus: { reset: vi.fn() },
		keybindings: { reload: vi.fn() },
		themeController: { applyFromSettings: vi.fn() },
		clearExtensionTerminalInputListeners: vi.fn(),
		setExtensionHeader: vi.fn(),
		clearExtensionWidgets: vi.fn(),
		setCustomEditorComponent: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
		updateTerminalTitle: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		applyRuntimeSettings: vi.fn(),
		renderCurrentSessionState: vi.fn(),
		subscribeToAgent: vi.fn(),
		bindCurrentSessionExtensions: vi.fn(async () => {}),
		updateAvailableProviderCount: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		rebuildChatFromMessages: vi.fn(),
		setupExtensionShortcuts: vi.fn(),
		showLoadedResources: vi.fn(),
		maybeSaveImplicitProjectTrustAfterReload: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	invoke("setExtensionFooter", mode, () => oldFooter);
	frames.length = 0;
	oldFooter.dispose.mockClear();
	return { mode, frames, oldFooter, footerContainer, finishStartup: deferred(), startupEntered: deferred() };
}

describe("interactive /cd", () => {
	beforeAll(() => initTheme("dark"));
	it.each(["cd", "reload"] as const)("%s freezes the outgoing footer until every startup handler finishes", async (operation) => {
		for (const destinationFooter of ["custom", "built-in", "cleared"] as const) {
			const { mode, frames, oldFooter, footerContainer, finishStartup, startupEntered } = footerRebindHarness();
			const nextFooter = { render: () => ["destination custom footer"], invalidate() {}, dispose: vi.fn() };
			const startup = async () => {
				startupEntered.resolve();
				if (destinationFooter !== "built-in") {
					invoke("setExtensionFooter", mode, () => nextFooter);
					if (destinationFooter === "cleared") invoke("setExtensionFooter", mode, undefined);
				}
				await finishStartup.promise;
			};
			mode.bindCurrentSessionExtensions.mockImplementation(startup);
			mode.runtimeHost.session.reload.mockImplementation(async ({ beforeSessionStart }) => {
				beforeSessionStart();
				await startup();
			});
			let switching: unknown;
			if (operation === "cd") {
				// The runtime calls this after relocation, before creating/binding the destination.
				invoke("resetExtensionUI", mode);
				switching = invoke("rebindCurrentSession", mode, { renderBeforeBind: true });
			} else {
				switching = invoke("handleReloadCommand", mode);
			}
			await startupEntered.promise;
			expect(oldFooter.dispose).toHaveBeenCalledOnce();
			expect(footerContainer.render(80)).toEqual(["old custom footer"]);
			expect(frames.length).toBeGreaterThan(0);
			expect(frames.every((frame) => frame.length === 1 && frame[0] === "old custom footer")).toBe(true);
			finishStartup.resolve();
			await switching;
			expect(footerContainer.render(80)).toEqual([
				destinationFooter === "custom" ? "destination custom footer" : "destination built-in footer",
			]);
			if (destinationFooter === "cleared") expect(nextFooter.dispose).toHaveBeenCalledOnce();
		}
	});

	it("an older rebind cannot expose the footer while a newer reload is still starting", async () => {
		const { mode, footerContainer, finishStartup, startupEntered } = footerRebindHarness();
		mode.bindCurrentSessionExtensions.mockImplementation(async () => {
			startupEntered.resolve();
			await finishStartup.promise;
		});
		invoke("resetExtensionUI", mode);
		const earlier = invoke("rebindCurrentSession", mode, { renderBeforeBind: true });
		await startupEntered.promise;
		const reloadEntered = deferred();
		const finishReload = deferred();
		mode.runtimeHost.session.reload.mockImplementation(async () => {
			invoke("setExtensionFooter", mode, () => ({ render: () => ["reloaded footer"], invalidate() {} }));
			reloadEntered.resolve();
			await finishReload.promise;
		});
		// A deferred startup command can reach ctx.reload() before its binder returns.
		const later = invoke("handleReloadCommand", mode);
		await reloadEntered.promise;
		finishStartup.resolve();
		await earlier;
		expect(footerContainer.render(80)).toEqual(["old custom footer"]);
		finishReload.resolve();
		await later;
		expect(footerContainer.render(80)).toEqual(["reloaded footer"]);
	});

	it("a failed reload replaces the frozen snapshot with the built-in footer", async () => {
		const { mode, frames, footerContainer } = footerRebindHarness();
		mode.runtimeHost.session.reload.mockRejectedValue(new Error("reload failed"));
		await invoke("handleReloadCommand", mode);
		expect(mode.showError).toHaveBeenCalledWith("Reload failed: reload failed");
		expect(frames[0]).toEqual(["old custom footer"]);
		expect(footerContainer.render(80)).toEqual(["destination built-in footer"]);
	});

	it.each([0, 1, 3])("reserves %s outgoing rows in regular and fullscreen through overlapping resets", (height) => {
		const { mode, footerContainer, oldFooter } = footerRebindHarness(height);
		const editor = { render: () => ["EDITOR TOP", "INPUT", "EDITOR BOTTOM"], invalidate() {} };
		const regular = new Container();
		regular.addChild(editor);
		regular.addChild(footerContainer);
		const viewport = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor,
			footer: footerContainer,
		});
		const geometry = () => ({
			regularRows: regular.render(80).length,
			editorRow: renderLayoutFrame(viewport.root, 80, 24, () => {}).lines.findIndex((line) =>
				line.includes("EDITOR TOP"),
			),
		});
		const before = geometry();
		oldFooter.render.mockClear();
		invoke("resetExtensionUI", mode);
		expect(footerContainer.render(40)).toEqual(Array(height).fill("old custom footer"));
		expect(geometry()).toEqual(before);
		const next = { render: vi.fn(() => Array(height).fill("NEW FOOTER")), invalidate() {} };
		invoke("setExtensionFooter", mode, () => next);
		expect(geometry()).toEqual(before);
		expect(next.render).not.toHaveBeenCalled();
		invoke("resetExtensionUI", mode);
		invoke("setExtensionFooter", mode, () => next);
		expect(geometry()).toEqual(before);
		expect(oldFooter.render).not.toHaveBeenCalled();
		expect(next.render).not.toHaveBeenCalled();
		invoke("showFooterAfterRebind", mode, Reflect.get(mode, "footerRebind"));
		expect(geometry()).toEqual(before);
		expect(footerContainer.render(80)).toEqual(Array(height).fill("NEW FOOTER"));
	});

	it("keeps footer mouse capture, keyboard and focus hooks on the actual mounted footer, never the placeholder", () => {
		const { mode, footerContainer } = footerRebindHarness();
		const footer = {
			render: () => ["CLICK"],
			invalidate: vi.fn(),
			handleMouse: vi.fn((_event: TuiMouseEvent) => ({ capture: true, focus: true, render: false })),
			handleInput: vi.fn((_data: string) => {}),
			wantsKeyRelease: true,
			focused: false,
		};
		const event: TuiMouseEvent = {
			type: "press",
			button: "left",
			x: 0,
			y: 0,
			screenX: 2,
			screenY: 23,
			width: 80,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
		};
		invoke("setExtensionFooter", mode, () => footer);
		const dispatched = footerContainer.handleMouse(event);
		expect(footer.handleMouse).toHaveBeenCalledWith(event);
		expect(footer.handleMouse.mock.contexts[0]).toBe(footer);
		expect(dispatched).toMatchObject({ handled: true, capture: true, focus: true, render: false });
		expect(dispatched?.target.component).toBe(footer);
		expect(dispatched?.focusTarget).toBe(footer);
		expect(dispatched?.focusTarget?.wantsKeyRelease).toBe(true);
		dispatched?.focusTarget?.handleInput?.("key release");
		expect(footer.handleInput).toHaveBeenCalledWith("key release");
		expect(footer.handleInput.mock.contexts[0]).toBe(footer);
		footerContainer.invalidate();
		expect(footer.invalidate).toHaveBeenCalledOnce();

		// Real requestRender is deferred: old mouse geometry may survive until the next frame.
		mode.ui.requestRender = () => {};
		invoke("resetExtensionUI", mode);
		expect(footerContainer.handleMouse(event)).toBeUndefined();
		expect(footerContainer.render(80)).toEqual(["CLICK"]);
		expect(footerContainer.handleMouse(event)).toBeUndefined();
		footerContainer.invalidate();
		expect(footer.handleMouse).toHaveBeenCalledOnce();
		expect(footer.invalidate).toHaveBeenCalledOnce();

		const destination = { ...footer, handleMouse: vi.fn(footer.handleMouse.getMockImplementation()) };
		invoke("setExtensionFooter", mode, () => destination);
		footerContainer.render(80);
		expect(footerContainer.handleMouse(event)).toBeUndefined();
		expect(destination.handleMouse).not.toHaveBeenCalled();
		invoke("showFooterAfterRebind", mode, Reflect.get(mode, "footerRebind"));
		footerContainer.render(80);
		expect(footerContainer.handleMouse(event)?.target.component).toBe(destination);
		expect(destination.handleMouse).toHaveBeenCalledOnce();
		expect(footer.handleMouse).toHaveBeenCalledOnce();
	});

	it("freezes a copy of the last footer render, with a blank fallback before any render", () => {
		const { mode, oldFooter, footerContainer } = footerRebindHarness();
		const lines = ["frozen line", "second line"];
		oldFooter.render.mockReturnValue(lines);
		footerContainer.render(80);
		invoke("resetExtensionUI", mode);
		lines[0] = "mutated outgoing buffer";
		lines.push("extra row");
		expect(footerContainer.render(80)).toEqual(["frozen line", "second line"]);
		expect(footerContainer.render(5).map(strip)).toEqual(["froze", "secon"]);
		Reflect.set(mode, "footerRenderedLines", undefined);
		Reflect.set(mode, "footerRenderedHeight", 2);
		invoke("resetExtensionUI", mode);
		expect(footerContainer.render(80)).toEqual(["", ""]);
	});

	it.each(["cd", "reload"] as const)(
		"%s preserves the editor dock height and frozen footer in both viewport modes",
		async (operation) => {
			for (const height of [3, 7]) {
				const { mode, oldFooter, footerContainer, finishStartup, startupEntered } = footerRebindHarness(2);
				const editor = {
					render: () => Array(height).fill("EDITOR"),
					invalidate() {},
					getText: () => "draft",
					setText: vi.fn(),
				};
				Object.assign(mode, { editor });
				mode.editorContainer.addChild(editor);
				const regular = new Container();
				regular.addChild(mode.editorContainer);
				regular.addChild(footerContainer);
				const viewport = createChatViewport({
					document: new Container(),
					pendingMessages: new Container(),
					status: new Container(),
					editor: mode.editorContainer,
					footer: footerContainer,
				});
				const geometry = () => ({
					regularRows: regular.render(80).length,
					fullscreenFooter: renderLayoutFrame(viewport.root, 80, 24, () => {}).lines.slice(-2),
				});
				const before = geometry();
				const startup = async () => {
					startupEntered.resolve();
					invoke("setExtensionFooter", mode, () => ({ render: () => ["NEW", "NEW"], invalidate() {} }));
					await finishStartup.promise;
				};
				mode.runtimeHost.session.reload.mockImplementation(startup);
				Object.assign(mode, { formatDisplayPath: (path: string) => path });
				Object.assign(mode.runtimeHost, {
					changeCwd: async () => {
						invoke("resetExtensionUI", mode);
						oldFooter.render.mockClear();
						await startup();
						invoke("showFooterAfterRebind", mode, Reflect.get(mode, "footerRebind"));
						return { changed: false, error: "busy" };
					},
				});
				oldFooter.render.mockClear();
				const switching =
					operation === "cd"
						? invoke(
								"performCwdChange",
								mode,
								"/a/very/long/destination/path/that/must/not/wrap/over/multiple/rows",
								{ source: "user" },
							)
						: invoke("handleReloadCommand", mode);
				await startupEntered.promise;
				expect(mode.editorContainer.render(80)).toHaveLength(height);
				expect(mode.editorContainer.render(20)).toHaveLength(height);
				expect(mode.editorContainer.render(80).map(strip)[1]).toContain(
					operation === "cd" ? "Changing working directory" : "Reloading",
				);
				expect(geometry()).toEqual(before);
				expect(footerContainer.render(80)).toEqual(["old custom footer", "old custom footer"]);
				expect(oldFooter.render).not.toHaveBeenCalled();
				finishStartup.resolve();
				await switching;
				expect(mode.editorContainer.render(80)).toHaveLength(height);
				expect(regular.render(80)).toHaveLength(before.regularRows);
				expect(footerContainer.render(80)).toEqual(["NEW", "NEW"]);
			}
		},
	);

	it("registers the command and resolves exactly one matching quote pair, not shell syntax", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((c) => c.name === "cd")).toBe(true);
		expect(resolveCwdTarget('  "../two words"  ', "/one/a")).toBe("/one/two words");
		expect(resolveCwdTarget("$HOME; pwd", "/one")).toBe("/one/$HOME; pwd");
	});

	it.each([
		["isStreaming", "Wait for the current response to finish before changing directory."],
		["isCompacting", "Wait for compaction to finish before changing directory."],
		["isBashRunning", "Wait for the shell command to finish before changing directory."],
	])("refuses %s without runtime changes", async (flag, text) => {
		const showWarning = vi.fn();
		const changeCwd = vi.fn();
		await prototype.handleCdCommand.call(
			{ session: { [flag]: true }, sessionManager: { getCwd: () => "/a" }, showWarning, runtimeHost: { changeCwd } },
			"/b",
		);
		expect(showWarning).toHaveBeenCalledWith(text);
		expect(changeCwd).not.toHaveBeenCalled();
	});

	it.each(["idle", "shell", "compaction"] as const)(
		"Escape while a cwd is pending cancels it and preserves %s stop behavior",
		(state) => {
			const abort = vi.fn(async () => {});
			const abortBash = vi.fn();
			const session = {
				pendingCwdChange: { state: "pending" },
				isIdle: state !== "compaction",
				isCompacting: state === "compaction",
				isBashRunning: state === "shell",
				abort,
				abortBash,
				abortCompaction: vi.fn(),
			};
			const editor = { onEscape: undefined as (() => void) | undefined, onAction: vi.fn() };
			const context = { session, defaultEditor: editor, ui: {}, restoreQueuedMessagesToEditor: vi.fn() };
			Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(context);
			editor.onEscape?.();
			expect(abort).toHaveBeenCalledOnce();
			if (state === "shell") expect(abortBash).toHaveBeenCalledOnce();
		},
	);

	it("distinguishes committed cleanup warnings from power-loss durability warnings", () => {
		expect(formatCwdWarning("cd: unlink /old: refused", "~/b")).toBe(
			"cd: could not remove the old session file (cd: unlink /old: refused); it stays hidden from /resume and is removed the next time this session is opened or changes directory.",
		);
		expect(formatCwdWarning("cd: fsync /new: refused", "~/b")).toBe(
			"cd: changed to ~/b, but the change may not survive a power loss (cd: fsync /new: refused); the old copy is kept hidden until it does.",
		);
	});

	it("query and same directory are dim status rows, no transition", async () => {
		const showStatus = vi.fn();
		const context = { sessionManager: { getCwd: () => "/a" }, formatDisplayPath: (p: string) => p, showStatus };
		await prototype.handleCdCommand.call(context, "");
		await prototype.handleCdCommand.call(context, "/a");
		expect(showStatus.mock.calls.map(([text]) => text)).toEqual(["Working directory: /a", "Already in /a"]);
	});

	it.each([40, 80])("renders one unboxed cwd marker at %s columns, expanded shows literal notice", (width) => {
		const from = "/home/u/previous-project";
		const to = "/home/u/destination-project";
		const notice = cwdAppliedNotice(from, to);
		const component = new CustomMessageComponent({
			role: "custom",
			customType: "pi.cwd",
			content: notice,
			display: true,
			details: { kind: "applied", from, to },
			timestamp: 0,
		});
		const rows = component
			.render(width)
			.map(strip)
			.filter((row) => row.trim());
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("✓ cd");
		expect(rows[0]).not.toContain("[pi.cwd]");
		expect(visibleWidth(rows[0])).toBeLessThanOrEqual(width);
		component.setExpanded(true);
		expect(component.render(width).map(strip).join("\n").replace(/\s+/g, " ")).toContain(notice);
	});
});
