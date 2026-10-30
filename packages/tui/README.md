# @earendil-works/pi-tui

Minimal terminal UI framework with differential rendering and synchronized output for flicker-free interactive CLI applications.

## Features

- **Interchangeable Renderers**: Shared `TUI` interface with main-screen and alternate-screen implementations
- **Differential Rendering**: Updates only changed lines or viewport rows
- **Application-owned Scrolling**: Alternate-screen viewport supports mouse, trackpad, and keyboard navigation
- **Synchronized Output**: Uses CSI 2026 for atomic screen updates (no flicker)
- **Bracketed Paste Mode**: Handles large pastes correctly with markers for >10 line pastes
- **Component-based**: Simple Component interface with render() method
- **Theme Support**: Components accept theme interfaces for customizable styling
- **Built-in Components**: Text, TruncatedText, Input, Editor, Markdown, Loader, SelectList, SettingsList, MouseRegion, Spacer, Image, Box, Container, VStack, HStack, ScrollView
- **Inline Images**: Renders images in terminals that support Kitty or iTerm2 graphics protocols
- **Autocomplete Support**: File paths and slash commands

## Quick Start

```typescript
import { type TUI, Text, Editor, ProcessTerminal, TuiMainScreen, matchesKey } from "@earendil-works/pi-tui";

// Create terminal
const terminal = new ProcessTerminal();

// Create the default main-screen renderer through the shared TUI interface
const tui: TUI = new TuiMainScreen(terminal);

// Add components
tui.addChild(new Text("Welcome to my app!"));

import { defaultEditorTheme as editorTheme } from './test/test-themes.ts';
const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => {
  console.log("Submitted:", text);
  tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// Focus the editor so it receives keyboard input
tui.setFocus(editor);

// In raw mode Ctrl+C doesn't send SIGINT — intercept it here to allow exit
tui.addInputListener((data) => {
  if (matchesKey(data, 'ctrl+c')) {
    tui.stop();
    process.exit(0);
  }
});

// Start
tui.start();
```

## Core API

### TUI interface and renderers

`TUI` is the shared interface for component management, focus, overlays, input, lifecycle, terminal queries, and rendering. Choose a concrete renderer only when constructing the application:

- `TuiMainScreen` renders into the main terminal buffer and preserves terminal scrollback.
- `TuiAltScreen` renders a fixed-height viewport in the alternate terminal buffer with application-owned scrolling. When stopped, it restores the main buffer and prints the complete final document.

```typescript
import { type TUI, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";

const tui: TUI = new TuiMainScreen(terminal);
// To use an application-owned viewport in the alternate terminal buffer instead:
// const tui: TUI = new TuiAltScreen(terminal);

tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender(); // Request a re-render

// Global debug key handler (Shift+Ctrl+D)
tui.onDebug = () => console.log("Debug triggered");
```

### Colors and terminal styles

Colors are values that can be converted or mixed before terminal rendering:

```typescript
import {
  colorToRgb,
  foregroundAnsi,
  getTerminalColorMode,
  mixColors,
  parseColor,
  rgbColor,
  styleText,
} from "@earendil-works/pi-tui";

const accent = parseColor("oklch(70% 0.12 220)");
const background = parseColor("#20242a");
const foreground = mixColors(accent, background, 0.2);

const text = styleText(
  "Ready",
  { fg: foreground, bg: background, bold: true },
  getTerminalColorMode(),
);
```

`Color` is an indexed ANSI color, an sRGB color, or an OKLCH color. Every color converts to sRGB, so color math such as `mixColors()` always works. Indices 0-15 follow the user's terminal palette, so their sRGB values are approximations. `styleText()` converts colors to truecolor or 256-color output based on the requested terminal mode.

`parseColor()` also accepts OKHSL, as in `okhsl(250 60% 55%)`; `okhslColor()` builds it in code and `colorToOkhsl()` reads any color's OKHSL channels. OKHSL saturation is relative to the most the sRGB gamut allows at the hue and lightness, so every value is in gamut and equal saturation looks equally colorful across hues. OKHSL colors are converted to sRGB when created.

Conversions are not cached. OKLCH colors, especially ones outside the sRGB gamut, are more expensive to convert than sRGB or indexed colors. For colors used on every render, convert once and reuse the result:

```typescript
const { r, g, b } = colorToRgb(mixColors(accent, background, 0.2));
const foreground = rgbColor(r, g, b); // cheap to render repeatedly
const foregroundCode = foregroundAnsi(foreground, getTerminalColorMode());
```

### Alternate-screen viewport layouts

`TuiAltScreen` can render an explicit terminal-height layout. `VStack` and `HStack` allocate constrained regions, while `ScrollView` owns scrolling for one region. These semantics are intentionally unavailable on `TuiMainScreen`, where the terminal owns scrollback.

```typescript
import {
  Container,
  isViewportTUI,
  ScrollView,
  Text,
  VStack,
} from "@earendil-works/pi-tui";

const transcript = new Container();
transcript.addChild(new Text("History"));

const editorAndFooter = new VStack([
  editor,
  new Text("status"),
]);

if (isViewportTUI(tui)) {
  tui.setLayoutRoot(new VStack([
    {
      component: new ScrollView(transcript, {
        follow: "end",
        primary: true,
        overscroll: "chain",
      }),
      basis: 0,
      grow: 1,
      minSize: 1,
    },
    {
      component: editorAndFooter,
      basis: "auto",
      shrink: 1,
      minSize: 1,
    },
  ]));
}
```

Stack entries support `basis`, `grow`, `shrink`, `minSize`, `maxSize`, and responsive `visible` callbacks. Mouse-wheel input targets the scroll view under the pointer and unused delta chains to outer scroll views by default. The primary scroll view receives the alternate-screen keyboard navigation actions and wheel input over non-scrollable regions. It can also jump between OSC 133 semantic prompt markers, matching common terminal prompt-navigation shortcuts. Press `Ctrl+Shift+F` to open or close its bordered search panel. The panel shows the configured previous/next shortcuts and provides clickable arrow controls; by default, `Enter`/`Ctrl+G` and `Shift+Enter`/`Ctrl+Shift+G` move between matches, and `Escape` also closes search. `TuiAltScreenOptions.searchMatchStyle` and `searchCurrentMatchStyle` customize match highlighting, while `searchNavigationButtonStyle` styles each arrow button and receives its hover state. `TuiAltScreenOptions.scrollToEndIndicator` renders a clickable label centered on the last row of a `follow: "end"` primary scroll view while it is scrolled away from the end; clicking it resumes end-following.

Layout geometry is rebuilt for each requested frame. Stateful components are retained, and their existing rendered-line caches remain effective. Calling `render(width)` directly on these layout components produces an unbounded document, which is also used when alt mode restores the main screen.

### Overlays

Overlays render components on top of existing content without replacing it. Useful for dialogs, menus, and modal UI.

```typescript
// Show overlay with default options (centered, max 80 cols)
const handle = tui.showOverlay(component);

// Show overlay with custom positioning and sizing
// Values can be numbers (absolute) or percentage strings (e.g., "50%")
const handle = tui.showOverlay(component, {
  // Sizing
  width: 60,              // Fixed width in columns
  width: "80%",           // Width as percentage of terminal
  minWidth: 40,           // Minimum width floor
  maxHeight: 20,          // Maximum height in rows
  maxHeight: "50%",       // Maximum height as percentage of terminal

  // Anchor-based positioning (default: 'center')
  anchor: 'bottom-right', // Position relative to anchor point
  offsetX: 2,             // Horizontal offset from anchor
  offsetY: -1,            // Vertical offset from anchor

  // Percentage-based positioning (alternative to anchor)
  row: "25%",             // Vertical position (0%=top, 100%=bottom)
  col: "50%",             // Horizontal position (0%=left, 100%=right)

  // Absolute positioning (overrides anchor/percent)
  row: 5,                 // Exact row position
  col: 10,                // Exact column position

  // Margin from terminal edges
  margin: 2,              // All sides
  margin: { top: 1, right: 2, bottom: 1, left: 2 },

  // Responsive visibility
  visible: (termWidth, termHeight) => termWidth >= 100  // Hide on narrow terminals

  // Focus behavior
  nonCapturing: true       // Don't auto-focus when shown
});

// OverlayHandle methods
handle.hide();              // Permanently remove the overlay
handle.setHidden(true);     // Temporarily hide (can show again)
handle.setHidden(false);    // Show again after hiding
handle.isHidden();          // Check if temporarily hidden
handle.focus();             // Focus and bring to visual front
handle.unfocus();           // Release focus to normal fallback
handle.unfocus({ target: baseComponent }); // Release this overlay to a specific component
handle.unfocus({ target: null });   // Release this overlay and leave focus empty
handle.isFocused();         // Check if overlay has focus
handle.getBounds();         // Get last rendered terminal-relative bounds

handle.unfocus();
// Overlay loses focus; TUI falls back to another visible capturing overlay or the previous focus target.

handle.unfocus({ target: null });
// Overlay loses focus; no component receives input until focus is set again.

// A focused visible overlay reclaims keyboard input after temporary replacement UI
// releases focus. If you want a specific component to receive input while overlays remain
// visible, call handle.unfocus({ target: component }).

// Hide topmost overlay
tui.hideOverlay();

// Check if any visible overlay is active
tui.hasOverlay();
```

**Anchor values**: `'center'`, `'top-left'`, `'top-right'`, `'bottom-left'`, `'bottom-right'`, `'top-center'`, `'bottom-center'`, `'left-center'`, `'right-center'`

**Resolution order**:
1. `minWidth` is applied as a floor after width calculation
2. For position: absolute `row`/`col` > percentage `row`/`col` > `anchor`
3. `margin` clamps final position to stay within terminal bounds
4. `visible` callback controls whether overlay renders (called each frame)

### Component Interface

All components implement:

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  invalidate(): void;
}
```

| Method | Description |
|--------|-------------|
| `render(width)` | Returns an array of strings, one per line. Each line **must not exceed `width`** or the TUI will error. Use `truncateToWidth()` or manual wrapping to ensure this. |
| `handleInput?(data)` | Called when the component has focus and receives keyboard input. The `data` string contains raw terminal input (may include ANSI escape sequences). |
| `handleMouse?(event)` | Called by `TuiAltScreen` for normalized pointer input targeted at the component. |
| `invalidate()` | Required. Clear any cached render state so the next `render()` starts from scratch. Components without cached render state can use an empty implementation. |

The TUI appends a full SGR reset and OSC 8 reset at the end of each rendered line. Styles do not carry across lines. If you emit multi-line text with styling, reapply styles per line or use `wrapTextWithAnsi()` so styles are preserved for each wrapped line.

### Mouse Input

`TuiAltScreen` normalizes SGR mouse input and hit-tests components and overlays. Events contain component-local `x`/`y`, absolute `screenX`/`screenY`, bounds, button, modifiers, click count, and wheel delta. `TuiMainScreen` does not capture mouse input because the terminal owns its scrollback.

```typescript
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
  if (event.type === "click" && event.button === "left") {
    this.expanded = !this.expanded;
    return { handled: true };
  }
  if (event.type === "press" && event.button === "left") {
    return { handled: true, capture: true, focus: true };
  }
  if (event.type === "drag") {
    this.updateFromPointer(event.x, event.y);
    return { handled: true, render: true };
  }
  return undefined;
}
```

Returning `handled` suppresses renderer-level fallback behavior. `capture` keeps subsequent drag and release events routed to the same component. A captured component gesture ends early when keyboard focus moves to a different component or a non-release key reaches the focused component: its remaining drag, release and click are swallowed. Focus requested by the gesture's own handler results does not end it. Wheel, hover, text selection, scrollbar drag and modified-link clicks are unaffected. `focus` requests keyboard focus. The optional `render` flag controls repainting: press, click, drag, and wheel default to rendering; move and release do not. Set `render: true` for a hover state that visibly changed, or `render: false` for a handled no-op. Render requests are coalesced and terminal output remains differential.

Unhandled gestures retain alternate-screen defaults: wheel input scrolls the nearest `ScrollView` and chains unused delta, primary-button drags select text, OSC 8 links open before parent click handlers, and unhandled right-click preserves configured paste behavior. A click is emitted only when press/release completes without a drag. Renderer clicks carry `clickSource: "captured"` after an accepted component press, or `"fallback"` after an unhandled press (used by Editor click-to-position). Every press receives a monotonically increasing, renderer-local `gestureId`; its drag, release and synthesized click (captured or fallback) carry the same ID. New presses get new IDs even after cancellation, a lost release, focus loss or renderer restart. Move and wheel events have no gesture ID. Forwarding handlers must preserve `gestureId` along with click provenance. Directly constructed events may omit `clickSource` and `gestureId`. The captured-gesture lifetime rule does not guard fallback clicks.

Use `MouseRegion` to add mouse behavior without changing a component's rendering:

```typescript
const collapsible = new MouseRegion(content, (event) => {
  if (event.type !== "click" || event.button !== "left") return undefined;
  expanded = !expanded;
  return { handled: true };
});
```

`Container` and `Box` route events to nested children using geometry recorded by the last rendered frame, so pointer motion does not rerender children merely to hit-test them. Explicit `VStack`, `HStack`, and `ScrollView` layouts use the alternate-screen layout frame directly.

#### ListMouse

`ListMouse<K>` shares press-time row identity and click/wheel policy without changing keyboard handling or rendering. Use stable keys (indices only for static lists). A left press selects without activating; a renderer click requires the same `gestureId` as the press this helper accepted and uses its original key/zone even after rows are rebuilt. A click from another gesture clears stale press state without acting, even when that gesture's press went directly to another control inside the same captured target (such as a search input). Fallback clicks never act and also clear stale press state. Omitting `gestureId` preserves direct-event behavior: captured clicks still require an accepted press, while undefined-source direct clicks may select and activate without a press, for synthetic callers/tests.

```typescript
const mouse = new ListMouse<string>({
  select: (key) => { selectedKey = key; },
  activate: (key) => {
    const item = currentItems.find((item) => item.id === key);
    if (!item) return false;
    onSelect(item);
    return true;
  },
  step: (direction) => stepSelectionClamped(direction), // -1 or 1; returns visible change
  ownsWheel: () => currentItems.length > maxVisible,
});

// Manual renderer: reset geometry at each render, then record only visible item lines.
mouse.beginRows();
mouse.addRow(item.id, localY, visibleHeight);
// handleMouse(event) delegates to mouse.handle(event).

// Alternatively, a container-of-rows renderer can wrap a whole (possibly wrapped) row:
container.addChild(mouse.row(item.id, new Text(item.label, 0, 0)));
```

`activate(key)` must revalidate against the current list and return whether it acted. Only a successful activation closes the helper; a removed key leaves it usable. `closeOnActivate: false` supports toggles. `closed` reports permanent closure; `close()` is idempotent, for a finished surface still mounted. `enabled: () => false` leaves events unhandled and records no press (for modal states or an arming delay).

`step` is optional. Wheel events are handled only inside item-row bounds and while `ownsWheel()` is true (default true when `step` exists). Manual bounds include interior separators, not titles, counters or hints; region bounds cover that row only. Wheel uses the delta's sign, never touches the held press, and reports the step's boolean as `render`, including handled no-ops at a clamped end.

`addRow(key, y, height = 1, zones?)` and `row(key, child, zones?)` accept `ListMouseZone[]` (`{ name, x, width }`). A zone click calls optional `zoneClick(key, zone)` instead of `activate`, never closes, and must revalidate its key/zone there. `hitTest(x, y)` returns `{ key, zone? }` for manual rows. Right/middle buttons and release, drag, move and leave are unhandled.

### Focusable Interface (IME Support)

Components that display a text cursor and need IME (Input Method Editor) support should implement the `Focusable` interface:

```typescript
import { CURSOR_MARKER, type Component, type Focusable, renderFakeCursor } from "@earendil-works/pi-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;  // Set by TUI when focus changes
  
  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    // Emit marker right before the fake cursor
    return [`> ${beforeCursor}${marker}${renderFakeCursor(atCursor)}${afterCursor}`];
  }

  invalidate(): void {}
}
```

When a `Focusable` component has focus, TUI:
1. Sets `focused = true` on the component
2. Scans rendered output for `CURSOR_MARKER` (a zero-width APC escape sequence)
3. Positions the hardware terminal cursor at that location
4. Shows the hardware cursor only when `showHardwareCursor` is enabled

`renderFakeCursor()` wraps the cursor cell in zero-width markers. TUI renders them as reverse video. When `showHardwareCursor` is enabled, TUI removes the fake cursor that directly follows `CURSOR_MARKER`, so the focused component shows only the terminal cursor. Fake cursors without a preceding `CURSOR_MARKER` stay visible.

The hardware cursor remains hidden by default. This keeps the fake cursor rendering, while still positioning the hardware cursor for terminals that track IME candidate windows with hidden cursors. Some terminals require a visible hardware cursor for IME positioning; enable it with the renderer constructor's `showHardwareCursor` argument or `setShowHardwareCursor(true)`. The `Editor` and `Input` built-in components already implement this interface.

**Container components with embedded inputs:** When a container component (dialog, selector, etc.) contains an `Input` or `Editor` child, the container must implement `Focusable` and propagate the focus state to the child:

```typescript
import { Container, type Focusable, Input } from "@earendil-works/pi-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput: Input;

  // Propagate focus to child input for IME cursor positioning
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor() {
    super();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
  }
}
```

Without this propagation, typing with an IME (Chinese, Japanese, Korean, etc.) will show the candidate window in the wrong position.

## Built-in Components

### Container

Groups child components.

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### Box

Container that applies padding and background color to all children.

```typescript
const box = new Box(
  1,                              // paddingX (default: 1)
  1,                              // paddingY (default: 1)
  (text) => chalk.bgGray(text)   // optional background function
);
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text));  // Change background dynamically
```

### Text

Displays multi-line text with word wrapping and padding.

```typescript
const text = new Text(
  "Hello World",                  // text content
  1,                              // paddingX (default: 1)
  1,                              // paddingY (default: 1)
  (text) => chalk.bgGray(text)   // optional background function
);
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
```

### TruncatedText

Single-line text that truncates to fit viewport width. Useful for status lines and headers.

```typescript
const truncated = new TruncatedText(
  "This is a very long line that will be truncated...",
  0,  // paddingX (default: 0)
  0   // paddingY (default: 0)
);
```

### Input

Single-line text input with horizontal scrolling.

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

Clicking positions the cursor and gives the input keyboard focus in alternate-screen mode.

**Key Bindings:**
- `Enter` - Submit
- `Ctrl+A` / `Ctrl+E` - Line start/end
- `Ctrl+W` or `Alt+Backspace` - Delete word backwards
- `Ctrl+U` - Delete to start of line
- `Ctrl+K` - Delete to end of line
- `Ctrl+Left` / `Ctrl+Right` - Word navigation
- `Alt+Left` / `Alt+Right` - Word navigation
- Arrow keys, Backspace, Delete work as expected

### Editor

Multi-line text editor with autocomplete, file completion, paste handling, and vertical scrolling when content exceeds terminal height.

```typescript
interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
}

interface EditorOptions {
  paddingX?: number;  // Horizontal padding (default: 0)
}

const editor = new Editor(tui, theme, options?);  // tui is required for height-aware scrolling
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true; // Disable submit temporarily
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s); // Change border dynamically
editor.setPaddingX(1); // Update horizontal padding dynamically
editor.getPaddingX();  // Get current padding
```

**Features:**
- Click-to-position cursor and clickable autocomplete rows in alternate-screen mode
- Multi-line editing with word wrap
- Slash command autocomplete (type `/`)
- File path autocomplete (press `Tab`)
- Large paste handling (>10 lines creates `[paste #1 +50 lines]` marker)
- Horizontal lines above/below editor
- Fake cursor rendering (hidden real cursor)

**Key Bindings:**
- `Enter` - Submit
- `Shift+Enter`, `Ctrl+Enter`, or `Alt+Enter` - New line (terminal-dependent, Alt+Enter most reliable)
- `Tab` - Autocomplete
- `Ctrl+K` - Delete to end of line
- `Ctrl+U` - Delete to start of line
- `Ctrl+W` or `Alt+Backspace` - Delete word backwards
- `Alt+D` or `Alt+Delete` - Delete word forwards
- `Ctrl+A` / `Ctrl+E` - Line start/end
- `Ctrl+]` - Jump forward to character (awaits next keypress, then moves cursor to first occurrence)
- `Ctrl+Alt+]` - Jump backward to character
- Arrow keys, Backspace, Delete work as expected

### Markdown

Renders markdown with syntax highlighting and theming support.

```typescript
interface MarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
}

interface DefaultTextStyle {
  color?: (text: string) => string;
  bgColor?: (text: string) => string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

const md = new Markdown(
  "# Hello\n\nSome **bold** text",
  1,              // paddingX
  1,              // paddingY
  theme,          // MarkdownTheme
  defaultStyle    // optional DefaultTextStyle
);
md.setText("Updated markdown");
```

**Features:**
- Headings, bold, italic, code blocks, lists, links, blockquotes
- HTML tags rendered as plain text
- Optional syntax highlighting via `highlightCode`
- Padding support
- Render caching for performance

### Loader

Animated loading spinner.

```typescript
const loader = new Loader(
  tui,                              // TUI instance for render updates
  (s) => chalk.cyan(s),            // spinner color function
  (s) => chalk.gray(s),            // message color function
  "Loading..."                      // message (default: "Loading...")
);
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

### CancellableLoader

Extends Loader with Escape key handling and an AbortSignal for cancelling async operations.

```typescript
const loader = new CancellableLoader(
  tui,                              // TUI instance for render updates
  (s) => chalk.cyan(s),            // spinner color function
  (s) => chalk.gray(s),            // message color function
  "Working..."                      // message
);
loader.onAbort = () => done(null); // Called when user presses Escape
doAsyncWork(loader.signal).then(done);
```

**Properties:**
- `signal: AbortSignal` - Aborted when user presses Escape
- `aborted: boolean` - Whether the loader was aborted
- `onAbort?: () => void` - Callback when user presses Escape

### SelectList

Interactive selection list with keyboard navigation.

```typescript
interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

const list = new SelectList(
  [
    { value: "opt1", label: "Option 1", description: "First option" },
    { value: "opt2", label: "Option 2", description: "Second option" },
  ],
  5,      // maxVisible
  theme   // SelectListTheme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt"); // Filter items
```

**Controls:**
- Mouse move/wheel: Highlight rows in alternate-screen mode
- Click: Select a row
- Arrow keys: Navigate
- Enter: Select
- Escape: Cancel

### SettingsList

Settings panel with value cycling and submenus.

```typescript
interface SettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];  // If provided, Enter/Space cycles through these
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

const settings = new SettingsList(
  [
    { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    { id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
  ],
  10,      // maxVisible
  theme,   // SettingsListTheme
  (id, newValue) => console.log(`${id} changed to ${newValue}`),
  () => console.log("Cancelled")
);
settings.updateValue("theme", "light");
```

**Controls:**
- Mouse move/wheel: Highlight rows in alternate-screen mode
- Click: Activate a row
- Arrow keys: Navigate
- Enter/Space: Activate (cycle value or open submenu)
- Escape: Cancel

### Spacer

Empty lines for vertical spacing.

```typescript
const spacer = new Spacer(2); // 2 empty lines (default: 1)
```

### Image

Renders images inline for terminals that support the Kitty graphics protocol (Kitty, Ghostty, WezTerm) or iTerm2 inline images. Falls back to a text placeholder on unsupported terminals.

```typescript
interface ImageTheme {
  fallbackColor: (str: string) => string;
}

interface ImageOptions {
  maxWidthCells?: number;
  maxHeightCells?: number;
  filename?: string;
}

const image = new Image(
  base64Data,       // base64-encoded image data
  "image/png",      // MIME type
  theme,            // ImageTheme
  options           // optional ImageOptions
);
tui.addChild(image);
```

Supported formats: PNG, JPEG, GIF, WebP. Dimensions are parsed from the image headers automatically.

#### Alternate-screen image compatibility

`TuiAltScreen` supports inline images and partial viewport cropping in terminals that implement the Kitty graphics protocol, including Kitty and Ghostty. iTerm2's inline-image protocol does not provide operations to delete an existing placement or crop its source while scrolling. To prevent stale images from remaining over repainted content, `TuiAltScreen` renders image components as text placeholders in iTerm2. `TuiMainScreen` continues to render iTerm2 inline images normally.

## Autocomplete

### CombinedAutocompleteProvider

Supports both slash commands and file paths.

```typescript
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";

const provider = new CombinedAutocompleteProvider(
  [
    { name: "help", description: "Show help" },
    { name: "clear", description: "Clear screen" },
    { name: "delete", description: "Delete last message" },
  ],
  process.cwd() // base path for file completion
);

editor.setAutocompleteProvider(provider);
```

**Features:**
- Type `/` to see slash commands
- Press `Tab` for file path completion
- Works with `~/`, `./`, `../`, and `@` prefix
- Filters to attachable files for `@` prefix

## Key Detection

Use `matchesKey()` with the `Key` helper for detecting keyboard input (supports Kitty keyboard protocol):

```typescript
import { matchesKey, Key } from "@earendil-works/pi-tui";

if (matchesKey(data, Key.ctrl("c"))) {
  process.exit(0);
}

if (matchesKey(data, Key.enter)) {
  submit();
} else if (matchesKey(data, Key.escape)) {
  cancel();
} else if (matchesKey(data, Key.up)) {
  moveUp();
}
```

**Key identifiers** (use `Key.*` for autocomplete, or string literals):
- Basic keys: `Key.enter`, `Key.escape`, `Key.tab`, `Key.space`, `Key.backspace`, `Key.delete`, `Key.home`, `Key.end`
- Arrow keys: `Key.up`, `Key.down`, `Key.left`, `Key.right`
- With modifiers: `Key.ctrl("c")`, `Key.shift("tab")`, `Key.alt("left")`, `Key.ctrlShift("p")`
- String format also works: `"enter"`, `"ctrl+c"`, `"shift+tab"`, `"ctrl+shift+p"`

## Rendering modes

`TuiMainScreen` uses three rendering strategies:

1. **First Render**: Output all lines without clearing scrollback
2. **Width Changed or Change Above Viewport**: Clear screen and fully re-render
3. **Normal Update**: Move the cursor to the first changed line, clear to the end, and render changed lines

`TuiAltScreen` owns a terminal-height viewport. Without an explicit layout root it preserves the legacy single-document scrolling behavior. With `setLayoutRoot()`, `VStack`, `HStack`, and nested `ScrollView` components can reserve fixed regions and independently scroll constrained regions. It updates changed viewport rows in place, follows streaming output while at the bottom, and preserves a manually selected scroll position while content grows. Mouse-wheel and configurable keyboard navigation scroll without modifying terminal scrollback, including jumps between OSC 133 semantic prompt markers. Scrollbars support hover expansion, thumb dragging, and track-click jumping. Clicking an OSC 8 hyperlink opens it with the configured URL handler. Dragging with the primary mouse button selects text and, unless `TuiAltScreenOptions.copyOnSelect` is `false`, copies it to the clipboard with OSC 52; holding the drag at a scroll view's top or bottom edge auto-scrolls and extends the selection into off-screen content. Kitty images support vertical viewport cropping; iTerm2 inline images fall back to text because the iTerm2 protocol cannot delete or crop placements during viewport repainting.

Both renderers wrap updates in **synchronized output** (`\x1b[?2026h` ... `\x1b[?2026l`) for atomic, flicker-free rendering.

## Terminal Interface

The TUI works with any object implementing the `Terminal` interface:

```typescript
interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
}
```

**Built-in implementations:**
- `ProcessTerminal` - Uses `process.stdin/stdout`
- `VirtualTerminal` - For testing (uses `@xterm/headless`)

## Utilities

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// Get visible width of string (ignoring ANSI codes)
const width = visibleWidth("\x1b[31mHello\x1b[0m"); // 5

// Truncate string to width (preserving ANSI codes, adds ellipsis)
const truncated = truncateToWidth("Hello World", 8); // "Hello..."

// Truncate without ellipsis
const truncatedNoEllipsis = truncateToWidth("Hello World", 8, ""); // "Hello Wo"

// Wrap text to width (preserving ANSI codes across line breaks)
const lines = wrapTextWithAnsi("This is a long line that needs wrapping", 20);
// ["This is a long line", "that needs wrapping"]
```

`wrapTextWithAnsi(text, width)` preserves OSC 8 opens without assigning IDs, including inside framework rendering. Such id-less links highlight only the hovered row segment, as before; independently cached extension output does not acquire shared identities. Only an explicit stable source namespace (the optional third argument) assigns occurrence IDs before wrapping, allowing all row segments of that occurrence to highlight together:

Pi's `Text` owns a namespace per instance, `SettingsList` per item description, and `Markdown` per instance/source token. Assistant messages retain a namespace per message component and content block, including streaming updates. These identities do not depend on render-call order or cache hits. `Text` and `Markdown` cache complete rendered output; Markdown's separate token cache does not skip wrapping individual sources. Containers can partially hit their children's caches: each child still owns its namespace.

```typescript
class LinkedText implements Component {
  private readonly linkIdPrefix = allocateLinkId(); // import from @earendil-works/pi-tui
  text = "";

  render(width: number): string[] {
    return wrapTextWithAnsi(this.text, width, this.linkIdPrefix);
  }

  invalidate(): void {}
}
```

Do not allocate the prefix inside `render()`, or share one between independent sources. For reconstructed `Markdown` children, pass a retained per-owner/per-block prefix through `MarkdownOptions.linkIdPrefix`. Existing explicit OSC 8 IDs and BEL/ST terminators are preserved.

The final output sink drops entire numeric SGR sequences with more than 32 semicolon-separated top-level parameters (colon subparameters do not count), or more than 128 parameter bytes. The style tracker uses the same limit before layout reconstruction. The 32-parameter bound avoids xterm's demonstrated truncation rather than relying on terminal-specific handling of longer lists; it is not a claim about every terminal's parser capacity.

## Creating Custom Components

When creating custom components, **each line returned by `render()` must not exceed the `width` parameter**. The TUI will error if any line is wider than the terminal.

### Handling Input

Use `matchesKey()` with the `Key` helper for keyboard input:

```typescript
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

class MyInteractiveComponent implements Component {
  private selectedIndex = 0;
  private items = ["Option 1", "Option 2", "Option 3"];
  
  public onSelect?: (index: number) => void;
  public onCancel?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.selectedIndex);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    return this.items.map((item, i) => {
      const prefix = i === this.selectedIndex ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
  }

  invalidate(): void {}
}
```

### Handling Line Width

Use the provided utilities to ensure lines fit:

```typescript
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

class MyComponent implements Component {
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    // Option 1: Truncate long lines
    return [truncateToWidth(this.text, width)];

    // Option 2: Check and pad to exact width
    const line = this.text;
    const visible = visibleWidth(line);
    if (visible > width) {
      return [truncateToWidth(line, width)];
    }
    // Pad to exact width (optional, for backgrounds)
    return [line + " ".repeat(width - visible)];
  }

  invalidate(): void {}
}
```

### ANSI Code Considerations

Both `visibleWidth()` and `truncateToWidth()` correctly handle ANSI escape codes:

- `visibleWidth()` ignores ANSI codes when calculating width
- `truncateToWidth()` preserves ANSI codes and properly closes them when truncating

```typescript
import chalk from "chalk";

const styled = chalk.red("Hello") + " " + chalk.blue("World");
const width = visibleWidth(styled); // 11 (not counting ANSI codes)
const truncated = truncateToWidth(styled, 8); // Red "Hello" + " W..." with proper reset
```

### Caching

For performance, components should cache their rendered output and only re-render when necessary:

```typescript
class CachedComponent implements Component {
  private text: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = [truncateToWidth(this.text, width)];

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

## Example

See `test/chat-simple.ts` for a complete chat interface example with:
- Markdown messages with custom background colors
- Loading spinner during responses
- Editor with autocomplete and slash commands
- Spacers between messages

Run it:
```bash
node test/chat-simple.ts
```

## Development

```bash
# Install dependencies (from monorepo root)
npm install

# Run type checking
npm run check

# Run the demo
node test/chat-simple.ts
```

### Debug logging

Set `PI_TUI_WRITE_LOG` to capture the raw ANSI stream written to stdout.

```bash
PI_TUI_WRITE_LOG=/tmp/tui-ansi.log node test/chat-simple.ts
```
