/**
 * HelixEditor against the real native addon and a fake TUI.
 * Build the addon first: `bun run build:native`.
 */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	Editor,
	KeybindingsManager,
	type KeybindingsConfig,
	setKeybindings,
	TUI_KEYBINDINGS,
	CURSOR_MARKER,
	renderFakeCursor,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { HelixEditor } from "../src/editor.ts";

const ESC = "\x1b";
const ENTER = "\r";
const TAB = "\t";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const HOME = "\x1b[H";
const CTRL_L = "\x0c";
const CTRL_D = "\x04";
const paste = (s: string) => `\x1b[200~${s}\x1b[201~`;

const COMMANDS = ["model", "quit", "tree"];

/** Slash commands only, resolved synchronously (one microtask). */
const provider: AutocompleteProvider = {
	async getSuggestions(lines, line, col) {
		const before = (lines[line] ?? "").slice(0, col);
		if (!before.startsWith("/") || before.includes(" ")) return null;
		const items: AutocompleteItem[] = COMMANDS.filter((c) => c.startsWith(before.slice(1))).map((c) => ({
			value: `/${c}`,
			label: c,
		}));
		return { items, prefix: before };
	},
	applyCompletion(lines, line, col, item, prefix) {
		const text = lines[line] ?? "";
		const next = `${text.slice(0, col - prefix.length)}${item.value} ${text.slice(col)}`;
		return {
			lines: lines.map((l, i) => (i === line ? next : l)),
			cursorLine: line,
			cursorCol: col - prefix.length + item.value.length + 1,
		};
	},
};

const tick = () => new Promise((r) => setTimeout(r, 0));

interface Harness {
	editor: HelixEditor;
	submitted: string[];
	actions: string[];
	written: string[];
	type(...keys: string[]): void;
}

function harness(mode: "helix" | "vi" = "helix", bindings?: KeybindingsConfig): Harness {
	const written: string[] = [];
	let hardwareCursor = false;
	const tui = {
		requestRender() {},
		getShowHardwareCursor: () => hardwareCursor,
		setShowHardwareCursor(v: boolean) {
			hardwareCursor = v;
		},
		terminal: { rows: 40, columns: 80, write: (s: string) => void written.push(s) },
	};
	const id = (s: string) => s;
	const theme = {
		borderColor: id,
		selectList: { selectedPrefix: id, selectedText: id, description: id, scrollInfo: id, noMatch: id },
	};
	const keybindings = new KeybindingsManager({
		...TUI_KEYBINDINGS,
		"app.interrupt": { defaultKeys: "escape", description: "" },
		"app.clear": { defaultKeys: "ctrl+c", description: "" },
		"app.exit": { defaultKeys: "ctrl+d", description: "" },
		"app.model.select": { defaultKeys: "ctrl+l", description: "" },
		"app.clipboard.pasteImage": { defaultKeys: "ctrl+v", description: "" },
		"app.message.followUp": { defaultKeys: "alt+enter", description: "" },
	} as never, bindings);
	setKeybindings(keybindings);
	const h: Harness = {
		submitted: [],
		actions: [],
		written,
		editor: undefined as never,
		type(...keys) {
			for (const k of keys) h.editor.handleInput(k);
		},
	};
	h.editor = new HelixEditor(tui as never, theme as never, keybindings as never, mode, {
		copy() {},
		selectionStyle: id,
		badgeStyle: (_m, s) => s,
	});
	h.editor.onSubmit = (text) => void h.submitted.push(text);
	for (const action of ["app.interrupt", "app.exit", "app.model.select"] as const) {
		h.editor.onAction(action as never, () => void h.actions.push(action));
	}
	h.editor.setAutocompleteProvider(provider);
	h.editor.focused = true;
	return h;
}

let h: Harness;
beforeEach(() => {
	h = harness();
});

describe("submit", () => {
	test("Enter submits trimmed text and clears, from insert and normal", () => {
		h.type(..."hi ", ENTER);
		expect(h.submitted).toEqual(["hi"]);
		expect(h.editor.getText()).toBe("");
		h.type(..."yo", ESC, ENTER);
		expect(h.submitted).toEqual(["hi", "yo"]);
	});

	test("submit is an undo boundary without changing normal mode or the yank register", () => {
		h.type(ESC, "i", "abc", ESC, "y", ENTER);
		expect(h.submitted).toEqual(["abc"]);
		expect(h.editor.render(40).at(-1)).toContain(" NOR ");
		h.type("u");
		expect(h.editor.getText()).toBe("");
		h.type("p");
		expect(h.editor.getText()).toBe("c");
	});

	test("Shift+Enter inserts a newline in insert mode", () => {
		h.type("a", "\x1b[13;2u", "b");
		expect(h.editor.getText()).toBe("a\nb");
		expect(h.submitted).toEqual([]);
	});

	test("the tui.input.newLine binding (Ctrl+J) inserts a newline in insert mode", () => {
		h.type("a", "\n", "b", "\x1b[106;5u", "c");
		expect(h.editor.getText()).toBe("a\nb\nc");
		expect(h.submitted).toEqual([]);
	});

	test("a rebound tui.input.newLine key is honored", () => {
		h = harness("helix", { "tui.input.newLine": "ctrl+o" } as never);
		h.type("a", "\x0f", "b");
		expect(h.editor.getText()).toBe("a\nb");
		expect(h.submitted).toEqual([]);
	});
});

describe("mouse", () => {
	const click = (y: number, x = 3) =>
		h.editor.handleMouse({
			type: "click", button: "left", x, y, screenX: x, screenY: y, width: 40, height: 10,
			shift: false, alt: false, ctrl: false,
		} as never);

	test("clicking a popup item applies it without submitting", async () => {
		h.type("/");
		await tick();
		const lines = h.editor.render(40);
		const row = lines.findIndex((l) => l.includes("quit"));
		expect(row).toBeGreaterThan(0);
		expect(click(row)).toMatchObject({ handled: true, focus: true });
		expect(h.editor.getText()).toBe("/quit ");
		expect(h.submitted).toEqual([]);
		expect(h.editor.render(40).some((l) => l.includes("tree"))).toBe(false);
	});

	test("clicking a text row still moves the cursor", () => {
		h.type(..."hello");
		h.editor.render(40);
		click(1, 3);
		expect(h.editor.getCursor().col).toBe(3);
	});
});

describe("paste undo", () => {
	test("one undo after a paste in normal mode restores the previous text", () => {
		h.type(..."hello world", ESC, paste("XYZ"));
		expect(h.editor.getText()).toContain("XYZ");
		h.type("u");
		expect(h.editor.getText()).toBe("hello world");
	});
});

describe("text input", () => {
	test("multi-scalar Unicode is inserted whole in insert mode", () => {
		h.type("日本語", "👩‍💻", "e\u0301");
		expect(h.editor.getText()).toBe("日本語👩‍💻e\u0301");
		expect(h.editor.getCursor()).toEqual({ line: 0, col: "日本語👩‍💻e\u0301".length });
		h.type(ESC, "dd");
		expect(h.editor.getText()).toBe("日本語👩‍💻e\u0301");
	});

	test("is inserted sanitized, without submitting", () => {
		h.type(paste("a\r\nb\x1b[31m\tc\x07"));
		expect(h.editor.getText()).toBe("a\nb[31m\tc");
		expect(h.submitted).toEqual([]);
	});

	test("goes to the colon line on one line", () => {
		h.type(ESC, ":", paste("tr\nee"), ENTER);
		expect(h.submitted).toEqual(["/tr ee"]);
	});
});

describe("app keys", () => {
	test("a bound ctrl key reaches pi, not the engine", () => {
		h.type("a", CTRL_L);
		expect(h.actions).toEqual(["app.model.select"]);
		expect(h.editor.getText()).toBe("a");
	});

	test("exit only when the buffer is empty", () => {
		h.type(CTRL_D);
		expect(h.actions).toEqual(["app.exit"]);
		h.type("a", ESC, CTRL_D);
		expect(h.actions).toEqual(["app.exit"]);
	});

	test("Esc leaves insert first, then interrupts", () => {
		h.type("a", ESC);
		expect(h.actions).toEqual([]);
		h.type(ESC);
		expect(h.actions).toEqual(["app.interrupt"]);
	});

	test("extension shortcuts run once per key and win over app bindings", () => {
		const seen: string[] = [];
		h.editor.onExtensionShortcut = (data) => {
			seen.push(data);
			return data === CTRL_L;
		};
		h.type(CTRL_L, CTRL_D);
		expect(seen).toEqual([CTRL_L, CTRL_D]);
		expect(h.actions).toEqual(["app.exit"]);
	});

	test("plain editing keys keep priority, while unsupported keys can run app bindings", () => {
		h = harness("helix", { "app.model.select": ["x", "super+a"] });
		h.type("x", "\x1b[97;9u", "y");
		expect(h.actions).toEqual(["app.model.select"]);
		expect(h.editor.getText()).toBe("xy");
	});

	test("remapped interrupt and dynamic handler follow the configured binding", () => {
		h = harness("helix", { "app.interrupt": "ctrl+g" });
		h.editor.onEscape = () => void h.actions.push("dynamic interrupt");
		h.type(ESC, ESC, "\x07");
		expect(h.actions).toEqual(["dynamic interrupt"]);
	});

	test("bound follow-up wins over the Alt+Enter newline fallback", () => {
		h.type("a", "\x1b\r");
		expect(h.editor.getText()).toBe("a\n");
		h.editor.onAction("app.message.followUp", () => void h.actions.push("follow-up"));
		h.type("\x1b\r");
		expect(h.actions).toEqual(["follow-up"]);
		expect(h.editor.getText()).toBe("a\n");
	});

	test("unknown and unhandled input never reaches the base text editor", () => {
		const base = spyOn(Editor.prototype, "handleInput");
		try {
			h.type("\x1b[999~", "\x1b[15~", CTRL_D, "a", ESC, ESC);
			expect(base).not.toHaveBeenCalled();
			expect(h.actions).toEqual(["app.exit", "app.interrupt"]);
			expect(h.editor.getText()).toBe("a");
		} finally {
			base.mockRestore();
		}
	});
});

describe("history", () => {
	test("Up on the first line browses, Down returns to the draft", () => {
		h.editor.addToHistory("old");
		h.type(..."draft", UP);
		expect(h.editor.getText()).toBe("old");
		h.type(DOWN);
		expect(h.editor.getText()).toBe("draft");
	});

	test("physical arrows move between logical lines before browsing", () => {
		h.editor.addToHistory("old");
		h.type(paste("one\ntwo"), UP);
		expect(h.editor.getText()).toBe("one\ntwo");
		expect(h.editor.getCursor().line).toBe(0);
		h.type(DOWN);
		expect(h.editor.getCursor().line).toBe(1);
		h.type(UP, UP);
		expect(h.editor.getText()).toBe("old");
	});

	test("modal motions, counted and modified arrows, and select arrows never browse implicitly", () => {
		h.editor.addToHistory("old");
		h.type("draft", "\x1b[1;2A", ESC, "k", "3", UP, "v", UP);
		expect(h.editor.getText()).toBe("draft");
		expect(h.editor.render(40).at(-1)).toContain(" SEL ");
	});

	test("explicit Pi history bindings browse away from the edge before app actions", () => {
		h = harness("helix", {
			"tui.editor.historyPrevious": "ctrl+p",
			"tui.editor.historyNext": "ctrl+n",
			"app.model.select": "ctrl+p",
		});
		h.editor.addToHistory("old");
		h.type(paste("one\ntwo"), "\x10");
		expect(h.editor.getText()).toBe("old");
		expect(h.actions).toEqual([]);
		h.type("\x0e");
		expect(h.editor.getText()).toBe("one\ntwo");
	});
});

describe("completion", () => {
	test("typing / opens the popup; Enter accepts and submits", async () => {
		h.type("/");
		await tick();
		expect(h.editor.isShowingAutocomplete()).toBe(true);
		h.type("t");
		await tick();
		h.type(ENTER);
		expect(h.submitted).toEqual(["/tree"]);
		expect(h.editor.isShowingAutocomplete()).toBe(false);
	});

	test("normal slash completion does not prefer /quit for /q", async () => {
		h.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "quiet" }, { name: "quit" }], "."));
		h.type("/", "q");
		await tick();
		h.type(ENTER);
		expect(h.submitted).toEqual(["/quiet"]);
	});

	test("Tab accepts without submitting", async () => {
		h.type("/", "m");
		await tick();
		h.type(TAB);
		expect(h.editor.getText()).toBe("/model ");
		expect(h.submitted).toEqual([]);
	});

	test("cursor-only prompt movement dismisses the popup", async () => {
		h.type("/", "t");
		await tick();
		expect(h.editor.isShowingAutocomplete()).toBe(true);
		h.type(LEFT);
		expect(h.editor.getCursor().col).toBe(1);
		expect(h.editor.isShowingAutocomplete()).toBe(false);
		await tick();
		expect(h.editor.isShowingAutocomplete()).toBe(false);
	});

	test("Enter during a refresh cannot submit an old popup item", async () => {
		h.type("/");
		await tick();
		h.type("t", ENTER);
		expect(h.submitted).toEqual(["/t"]);
		await tick();
		expect(h.editor.isShowingAutocomplete()).toBe(false);
	});

	test("popup navigation takes precedence over history and configured image paste", async () => {
		h = harness("helix", {
			"tui.editor.historyNext": "down",
			"tui.select.pageDown": "ctrl+v",
		});
		h.editor.addToHistory("old");
		h.editor.onPasteImage = () => void h.actions.push("paste image");
		h.type("/");
		await tick();
		h.type(DOWN, "\x16", TAB);
		expect(h.editor.getText()).toBe("/tree ");
		expect(h.actions).toEqual([]);
		h.type("\x16");
		expect(h.actions).toEqual(["paste image"]);
	});

	test("Esc closes the popup and stays in insert mode", async () => {
		h.type("/");
		await tick();
		h.type(ESC);
		expect(h.editor.isShowingAutocomplete()).toBe(false);
		h.type("q");
		expect(h.editor.getText()).toBe("/q");
		expect(h.actions).toEqual([]);
	});
});

describe("colon line", () => {
	test(": in normal mode runs a slash command and keeps the draft", () => {
		h.type(..."draft", ESC, ...":tree", ENTER);
		expect(h.submitted).toEqual(["/tree"]);
		expect(h.editor.getText()).toBe("draft");
	});

	test("colon dispatch saves the exact draft for history before a later Pi clear", async () => {
		const draft = "  first\nsecond \t";
		h.editor.setText(draft);
		const dispatched: { command: string; live: string }[] = [];
		h.editor.onSubmit = async (command) => {
			dispatched.push({ command, live: h.editor.getText() });
			await tick();
			h.editor.setText("");
		};
		h.type(ESC, ...":unlisted", ENTER);
		expect(h.editor.getText()).toBe(draft);
		await tick();
		expect(h.editor.getText()).toBe("");
		h.type(UP);
		expect(h.editor.getText()).toBe(draft);
		expect(dispatched).toEqual([{ command: "/unlisted", live: draft }]);
		h.type(DOWN, DOWN);
		expect(h.editor.getText()).toBe("");
		h.type(UP);
		expect(h.editor.getText()).toBe(draft);
		h = harness();
		h.type(UP);
		expect(h.editor.getText()).toBe("");
	});

	test("an empty or canceled colon command does not save a snapshot", () => {
		h.type("draft", ESC, ":", ENTER, ":", "t", ESC);
		h.editor.setText("");
		h.type(UP);
		expect(h.editor.getText()).toBe("");
		expect(h.submitted).toEqual([]);
	});

	test(": in insert mode is text", () => {
		h.type(":", "q", ENTER);
		expect(h.submitted).toEqual([":q"]);
	});

	test(": after a pending motion is its argument", () => {
		h.type(..."a:b", ESC, "g", "h", "f", ":");
		// Still the mode badge, not the command line.
		expect(h.editor.render(40).at(-1)).toContain(" NOR ");
		h.type("d");
		expect(h.editor.getText()).toBe("b");
	});

	test(":q is an alias for /quit whether or not completion is ready", async () => {
		h.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "quiet" }, { name: "quit" }], "."));
		h.type(ESC, ...":q", ENTER); // Completion is not ready.
		h.type(...":q");
		await tick();
		h.type(ENTER);
		expect(h.submitted).toEqual(["/quit", "/quit"]);
	});

	test("a real /q command wins over the alias once it is offered", async () => {
		h.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "q" }, { name: "quit" }], "."));
		h.type(ESC, ...":q");
		await tick();
		h.type(ENTER);
		expect(h.submitted).toEqual(["/q"]);
	});

	test("only :q is aliased; there is no force-quit handling", async () => {
		h.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "quit" }], "."));
		h.type(ESC);
		for (const command of ["quit", "q!", "quit!"]) {
			h.type(":", ...command);
			await tick();
			h.type(ENTER);
		}
		expect(h.submitted).toEqual(["/quit", "/q!", "/quit!"]);
		expect(h.actions).toEqual([]);
	});

	test("exactly :q highlights /quit if offered; navigation can override it", async () => {
		h.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "quiet" }, { name: "quit" }], "."));
		h.type(ESC, ...":q");
		await tick();
		expect(h.editor.render(40).map((row) => row.trimEnd())).toContain("→ quit");
		h.type(ENTER, ...":q");
		await tick();
		h.type(DOWN, ENTER, ...":qui");
		await tick();
		h.type(ENTER);
		expect(h.submitted).toEqual(["/quit", "/quiet", "/quiet"]);
	});

	test("an exact Pi command wins over an earlier suggestion and preserves typed arguments", async () => {
		h.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "quit" }, { name: "model" }], "."));
		h.type(ESC, ...":model sonnet", HOME, TAB);
		await tick();
		// At the start of the command, Pi offers all names in registration order.
		h.type(ENTER);
		expect(h.submitted).toEqual(["/model sonnet"]);
	});

	test("a matching slash-prefixed argument is not treated as an exact command", async () => {
		h.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{
			name: "model",
			getArgumentCompletions: () => [{ value: "/other", label: "other" }, { value: "/q", label: "q" }],
		}], "."));
		h.type(ESC, ...":model /q");
		await tick();
		h.type(ENTER);
		expect(h.submitted).toEqual(["/model /other"]);
	});

	test("Esc and Backspace on an empty line cancel", () => {
		h.type(ESC, ":", "t", ESC, ENTER);
		expect(h.submitted).toEqual([""]);
		h.type(":", "\x7f", "x");
		expect(h.submitted).toEqual([""]);
	});

	test("Enter runs the first current match without navigation", async () => {
		h.type(ESC, ":", "m");
		await tick();
		expect(h.editor.isShowingAutocomplete()).toBe(true);
		h.type(ENTER);
		expect(h.submitted).toEqual(["/model"]);
	});

	test("Enter takes the popup item once the user navigated", async () => {
		h.type(ESC, ":");
		h.type(TAB);
		await tick();
		expect(h.editor.isShowingAutocomplete()).toBe(true);
		h.type(DOWN);
		h.type(ENTER);
		expect(h.submitted).toEqual(["/quit"]);
	});

	test("typing after navigating selects from the refreshed matches", async () => {
		h.type(ESC, ":");
		h.type(TAB);
		await tick();
		h.type(DOWN, "t");
		await tick();
		h.type(ENTER);
		expect(h.submitted).toEqual(["/tree"]);
	});

	test("Enter during colon refresh submits the typed text, not a stale selection", async () => {
		h.type(ESC, ":", TAB);
		await tick();
		h.type(DOWN, "t", ENTER);
		expect(h.submitted).toEqual(["/t"]);
		await tick();
		expect(h.editor.isShowingAutocomplete()).toBe(false);
	});

	test("cursor-only colon movement dismisses the popup and its selected item", async () => {
		h.type(ESC, ":", "m");
		await tick();
		expect(h.editor.isShowingAutocomplete()).toBe(true);
		h.type(DOWN, LEFT);
		expect(h.editor.isShowingAutocomplete()).toBe(false);
		await tick();
		expect(h.editor.isShowingAutocomplete()).toBe(false);
		h.type(ENTER);
		expect(h.submitted).toEqual(["/m"]);
	});

	test("moving away and back cancels an in-flight colon request", async () => {
		h.type(ESC, ":", "m", LEFT, RIGHT);
		await tick();
		expect(h.editor.isShowingAutocomplete()).toBe(false);
	});

	test("Tab during refresh cannot apply an old colon popup item", async () => {
		h.type(ESC, ":", TAB);
		await tick();
		h.type("t", TAB, ENTER);
		expect(h.submitted).toEqual(["/t"]);
		await tick();
		expect(h.editor.isShowingAutocomplete()).toBe(false);
	});

	test("Tab completes without running", async () => {
		h.type(ESC, ":", "t");
		await tick();
		h.type(TAB);
		expect(h.submitted).toEqual([]);
		h.type(ENTER);
		expect(h.submitted).toEqual(["/tree"]);
	});
});

describe("modes", () => {
	test("vi has a colon line too", () => {
		h = harness("vi");
		h.type(ESC, ...":tree", ENTER);
		expect(h.submitted).toEqual(["/tree"]);
	});

	test("cursor is a bar in insert and a block in normal", () => {
		h.type("a");
		expect(h.written.at(-1)).toBe("\x1b[5 q");
		h.type(ESC);
		expect(h.written.at(-1)).toBe("\x1b[1 q");
	});

	test("pending keys appear at the right until the sequence completes or is rejected", () => {
		h = harness("vi");
		h.type(ESC);
		const idle = `─ NOR ${"─".repeat(14)}`;
		expect(h.editor.render(20).at(-1)).toBe(idle);
		h.type("2", "g");
		expect(h.editor.render(20).at(-1)).toBe("─ NOR ───────── 2g ─");
		h.type("g");
		expect(h.editor.render(20).at(-1)).toBe(idle);
		h.type("d", "z");
		expect(h.editor.render(20).at(-1)).toBe(idle);
	});

	test("pending keys truncate at whole labels or disappear", () => {
		h.type(ESC, "m", "r", "\x1b[41;8u"); // A modified old surround delimiter.
		expect(h.editor.render(21).at(-1)).toBe("─ NOR ─ mr<C-A-S-)> ─");
		expect(h.editor.render(20).at(-1)).toBe("─ NOR ─ …<C-A-S-)> ─");
		expect(h.editor.render(19).at(-1)).toBe(`─ NOR ${"─".repeat(13)}`);
		h.type(ESC);
		expect(h.editor.render(21).at(-1)).not.toContain("<C-A-S-)>");
	});

	test("the colon command replaces the badge and owns the cursor on the same row", () => {
		h.type("draft", ESC);
		const idle = h.editor.render(20);
		h.type(":", ..."write", LEFT);
		const lines = h.editor.render(20);
		expect(lines).toHaveLength(idle.length);
		expect(lines.slice(0, -1).join("")).toContain(`draf${renderFakeCursor("t")}`);
		expect(lines.slice(0, -1).join("")).not.toContain(CURSOR_MARKER);
		const footer = lines.at(-1) ?? "";
		expect(footer).toBe(`─ :writ${CURSOR_MARKER}${renderFakeCursor("e")}${"─".repeat(12)}`);
		expect(visibleWidth(footer)).toBe(20);
		expect(h.written.at(-1)).toBe("\x1b[5 q");
	});

	test("a long colon command uses the footer width to keep its cursor visible", () => {
		h.type(ESC, ":", ..."abcdefghijklmnopqrstuvwxyz");
		const footer = h.editor.render(10).at(-1) ?? "";
		expect(footer).toBe(`:stuvwxyz${CURSOR_MARKER}${renderFakeCursor(" ")}`);
		expect(visibleWidth(footer)).toBe(10);
	});

	test("a joined grapheme does not overflow a narrow colon footer", () => {
		h.type(ESC, ":", "©️");
		const footer = h.editor.render(3).at(-1) ?? "";
		expect(footer).toContain(CURSOR_MARKER);
		expect(visibleWidth(footer)).toBe(3);
	});

	test("an extra-wide cursor character does not overflow a tiny colon footer", () => {
		h.type(ESC, ":", "日", LEFT);
		expect(h.editor.render(2).at(-1)).toBe(`:${CURSOR_MARKER}${renderFakeCursor(" ")}`);
		expect(h.editor.render(1).at(-1)).toBe(CURSOR_MARKER + renderFakeCursor(":"));
	});

	test("bottom border keeps the scroll hint, dropping the badge when narrow", () => {
		h.editor.setText(Array.from({ length: 20 }, () => "a").join("\n"));
		h.type(ESC, "g", "g", "f");
		const wide = h.editor.render(40).at(-1) ?? "";
		expect(wide).toContain(" NOR ");
		expect(wide).toMatch(/ ↓ 8 more ─ f ─$/);
		expect(visibleWidth(wide)).toBe(40);
		const medium = h.editor.render(20).at(-1) ?? "";
		expect(medium).toContain(" NOR ");
		expect(medium).toContain(" ↓ 8 more ");
		expect(medium).not.toContain(" f ");
		const narrow = h.editor.render(13).at(-1) ?? "";
		expect(narrow).not.toContain(" NOR ");
		expect(narrow).toContain(" ↓ 8 more ");
		expect(visibleWidth(narrow)).toBe(13);
		h.type(ESC, ":");
		expect(h.editor.render(40).at(-1)).not.toContain(" more ");
	});
});
