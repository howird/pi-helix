/**
 * pi input editor backed by reedline's edit model (helix or vi).
 *
 * Extends CustomEditor for pi's app keybindings and border, but owns text
 * state, input handling and painting. The base Editor's own state is never
 * touched.
 */
import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	CURSOR_MARKER,
	renderFakeCursor,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Completion, type TextState, toLineCol } from "./autocomplete.ts";
import { ColonLine, colonWindow, resolveColonAlias } from "./colon.ts";
import { History } from "./history.ts";
import { type Key, keyLabel, translate } from "./keys.ts";
import { createEngine, type EditModeName, type Engine, type EngineState, type Mode } from "./native.ts";
import { cursorShapes } from "./cursor.ts";
import { hitTest, paint, type Row } from "./render.ts";

export interface EditorHost {
	copy(text: string): void;
	selectionStyle(text: string): string;
	badgeStyle(mode: Mode, text: string): string;
}

const BADGE: Record<Mode, string> = { normal: "NOR", insert: "INS", select: "SEL" };

const CURSOR_SHAPE = cursorShapes();

function fitPendingKeys(keys: readonly Key[], width: number): string {
	if (width <= 0 || keys.length === 0) return "";
	const labels = keys.map(keyLabel);
	const full = labels.join("");
	if (visibleWidth(full) <= width) return full;

	let suffix = "";
	for (let i = labels.length - 1; i >= 0; i--) {
		const next = labels[i] + suffix;
		if (visibleWidth(`…${next}`) > width) break;
		suffix = next;
	}
	return suffix ? `…${suffix}` : "";
}

export class HelixEditor extends CustomEditor {
	private readonly engine: Engine;
	private st: EngineState;
	private readonly promptHistory = new History();
	private readonly colon = new ColonLine();
	private colonOpen = false;
	private readonly completion: Completion;
	private padding = 0;
	private maxVisible = 5;
	private scroll = 0;
	private rows: Row[] = [];
	private visibleRowCount = 0;
	private listRowCount = 0;
	/** Hardware-cursor setting to restore when we lose focus; set while we own it. */
	private savedHardwareCursor: boolean | undefined;
	private cursorShape: string | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly bindings: KeybindingsManager,
		editMode: EditModeName,
		private readonly host: EditorHost,
	) {
		super(tui, theme, bindings);
		this.engine = createEngine(editMode);
		this.st = this.engine.state();
		this.completion = new Completion(
			theme.selectList,
			() => this.maxVisible,
			() => tui.requestRender(),
			() => this.colonOpen,
		);
		this.completion.current = () => (this.colonOpen ? this.colonTextState() : this.textState());
		this.completion.onAutoApply = (s) => {
			if (this.colonOpen) this.applyColonText(s);
			else this.applyText(s);
		};

		// TUI assigns `focused` directly; the base class declares it as a field,
		// so intercept it with an own accessor to manage the hardware cursor.
		let focused = this.focused;
		Object.defineProperty(this, "focused", {
			configurable: true,
			enumerable: true,
			get: () => focused,
			set: (value: boolean) => {
				focused = value;
				this.syncCursor();
			},
		});
	}

	/** Show the terminal cursor while focused, bar in insert mode, block otherwise. */
	private syncCursor(): void {
		const tui = this.tui;
		if (this.focused) {
			if (this.savedHardwareCursor === undefined) {
				this.savedHardwareCursor = tui.getShowHardwareCursor();
				tui.setShowHardwareCursor(true);
			}
			const shape = this.colonOpen || this.st.mode === "insert" ? CURSOR_SHAPE.bar : CURSOR_SHAPE.block;
			if (shape !== this.cursorShape) {
				this.cursorShape = shape;
				tui.terminal.write(shape);
			}
		} else if (this.savedHardwareCursor !== undefined) {
			tui.setShowHardwareCursor(this.savedHardwareCursor);
			this.savedHardwareCursor = undefined;
			this.cursorShape = undefined;
			tui.terminal.write(CURSOR_SHAPE.reset);
		}
	}

	// ---- EditorComponent surface -------------------------------------------------

	override getText(): string {
		return this.st.buffer;
	}

	override getExpandedText(): string {
		return this.st.buffer;
	}

	override getLines(): string[] {
		return this.st.buffer.split("\n");
	}

	override getCursor(): { line: number; col: number } {
		const { line, col } = toLineCol(this.st.buffer, this.st.cursor);
		return { line, col };
	}

	override setText(text: string): void {
		this.completion.cancel();
		this.promptHistory.reset();
		this.update(this.engine.setText(text));
		this.onChange?.(this.st.buffer);
	}

	override insertTextAtCursor(text: string): void {
		if (!text) return;
		this.completion.cancel();
		this.promptHistory.reset();
		this.update(this.engine.insertString(text));
		this.onChange?.(this.st.buffer);
	}

	override addToHistory(text: string): void {
		this.promptHistory.add(text);
	}

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.completion.setProvider(provider);
	}

	override setPaddingX(padding: number): void {
		this.padding = Math.max(0, padding);
	}

	override getPaddingX(): number {
		return this.padding;
	}

	override setAutocompleteMaxVisible(n: number): void {
		this.maxVisible = Math.max(3, Math.min(20, n));
	}

	override getAutocompleteMaxVisible(): number {
		return this.maxVisible;
	}

	override isShowingAutocomplete(): boolean {
		return this.completion.open;
	}

	// ---- input ----------------------------------------------------------------------

	override handleInput(data: string): void {
		const input = translate(data);
		if (input.kind === "ignore") return;

		// Extension shortcuts come first, as in CustomEditor. Paste is text.
		if (input.kind !== "paste" && this.onExtensionShortcut?.(data)) return;
		const key = input.kind === "key" ? input.key : undefined;

		if (input.kind !== "paste" && this.completionKey(data, key)) return;
		if (this.colonOpen) {
			const before = this.colonTextState();
			let typed: string | undefined;
			if (key) {
				this.colonKey(key);
				if (key.code === "char" && !key.ctrl && !key.alt) typed = key.ch;
			} else if (input.kind === "paste" || input.kind === "text") {
				this.colon.insert(input.text.replace(/\n/g, " "));
				if (input.kind === "text") typed = input.text;
			}
			if (!this.colonOpen) {
				this.completion.cancel();
			} else {
				const after = this.colonTextState();
				if (after.text !== before.text) {
					this.completion.update(after, typed);
				} else if (after.cursor !== before.cursor) {
					this.completion.cancel();
				}
			}
			this.requestRender();
			return;
		}

		let checkedApp = false;
		if (input.kind !== "paste") {
			const kb = this.bindings;
			if (kb.matches(data, "tui.editor.historyPrevious")) {
				this.browseHistory(-1);
				return;
			}
			if (kb.matches(data, "tui.editor.historyNext")) {
				this.browseHistory(1);
				return;
			}
			// Keep the modal editor first for ordinary keys, except Pi's reserved
			// actions. Unsupported input can only go to app handlers, never base text.
			const appFirst = !key || (key.code !== "esc" && (
				key.ctrl || key.alt || key.code.startsWith("f") || key.code === "backtab" ||
				kb.matches(data, "app.clipboard.pasteImage") || kb.matches(data, "app.clear") ||
				(kb.matches(data, "app.exit") && this.st.buffer.length === 0)
			));
			if (appFirst) {
				checkedApp = true;
				if (this.handleAppKey(data)) return;
			}
		}
		if (input.kind === "paste" || (input.kind === "text" && this.st.mode === "insert")) {
			if (!input.text) return;
			this.update(this.engine.insertString(input.text));
			this.afterEdit(input.kind === "text" ? input.text : undefined);
			return;
		}
		if (!key) return;

		const history = this.arrowHistory(key);
		if (history !== undefined) {
			this.browseHistory(history);
			return;
		}

		// `:` in normal mode with nothing pending opens the command line.
		if (
			this.st.mode === "normal" &&
			!this.st.pending &&
			key.code === "char" &&
			key.ch === ":" &&
			!key.ctrl &&
			!key.alt
		) {
			this.colonOpen = true;
			this.completion.cancel();
			this.colon.open();
			this.requestRender();
			return;
		}

		// Newline in insert mode: pi's binding (Shift+Enter, Ctrl+J by default)
		// or Shift/Alt+Enter. Reedline would ignore or submit on these.
		if (
			this.st.mode === "insert" &&
			(this.bindings.matches(data, "tui.input.newLine") ||
				(key.code === "enter" && (key.shift || key.alt) && !key.ctrl))
		) {
			this.update(this.engine.insertString("\n"));
			this.afterEdit();
			return;
		}

		// Tab with no applicable popup selection: force completion.
		if (key.code === "tab" && !key.shift && !key.ctrl && !key.alt && this.st.mode === "insert") {
			this.completion.forceOpen(this.textState());
			return;
		}

		const before = this.st;
		const next = this.engine.feed(key);
		if (next.yanked) this.host.copy(next.yanked);
		this.update(next);

		if (next.action === "submit") {
			this.submit();
			return;
		}
		if (next.buffer !== before.buffer) {
			this.afterEdit(next.mode === "insert" && key.code === "char" && !key.ctrl && !key.alt ? key.ch : undefined);
		} else if (next.cursor !== before.cursor || next.mode !== "insert") {
			this.completion.cancel();
		}
		if (!checkedApp && (next.action === "abort" || next.action === "unhandled")) this.handleAppKey(data);
	}

	private interrupt(): void {
		(this.onEscape ?? this.actionHandlers.get("app.interrupt"))?.();
	}

	/** CustomEditor's app dispatch order, without falling through to its text editor. */
	private handleAppKey(data: string): boolean {
		const kb = this.bindings;
		if (kb.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return true;
		}
		if (kb.matches(data, "app.interrupt")) {
			this.interrupt();
			return true;
		}
		if (kb.matches(data, "app.exit") && this.st.buffer.length === 0) {
			(this.onCtrlD ?? this.actionHandlers.get("app.exit"))?.();
			return true;
		}
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && kb.matches(data, action)) {
				handler();
				return true;
			}
		}
		return false;
	}

	/** Only an unmodified arrow at a logical edge can implicitly browse. */
	private arrowHistory(key: Key): -1 | 1 | undefined {
		if ((key.code !== "up" && key.code !== "down") || key.shift || key.ctrl || key.alt) return;
		if (this.st.pending || this.st.mode === "select" || (this.st.mode === "insert" && this.st.selection)) return;
		const { lines, line } = toLineCol(this.st.buffer, this.st.cursor);
		if (key.code === "up" && line === 0) return -1;
		if (key.code === "down" && line === lines.length - 1) return 1;
	}

	/** The colon line as the provider sees it: `:tree` → `/tree`. */
	private colonTextState(): TextState {
		return { text: `/${this.colon.text}`, cursor: this.colon.cursor + 1 };
	}

	private completionKey(data: string, key?: Key): boolean {
		const list = this.completion.list;
		if (!list) return false;
		if (key?.code === "esc") {
			this.completion.cancel();
			this.requestRender();
			return true;
		}
		const kb = this.bindings;
		if (
			kb.matches(data, "tui.select.up") ||
			kb.matches(data, "tui.select.down") ||
			kb.matches(data, "tui.select.pageUp") ||
			kb.matches(data, "tui.select.pageDown")
		) {
			list.handleInput(data);
			this.requestRender();
			return true;
		}
		if (!key || key.shift || key.alt || key.ctrl || (key.code !== "tab" && key.code !== "enter")) return false;
		return this.acceptCompletion(key.code === "enter" ? key : undefined);
	}

	/** Apply the highlighted popup item; Enter also runs a command. */
	private acceptCompletion(enter?: Key): boolean {
		const result = this.completion.accept(
			this.colonOpen ? this.colonTextState() : this.textState(),
			this.colonOpen && enter !== undefined,
		);
		if (!result) return false;
		if (this.colonOpen) {
			this.applyColonText(result.state);
			if (enter) {
				// The popup chose the command, so aliases do not apply.
				this.submitColon(this.colon.text);
				this.requestRender();
			}
		} else {
			this.applyText(result.state);
			if (enter && result.slash) this.submit();
		}
		return true;
	}

	/** Close the command line and run `text` as a slash command. */
	private submitColon(text: string): void {
		this.colonOpen = false;
		const command = text.trim();
		if (!command) return;
		this.promptHistory.saveUnsent(this.st.buffer);
		this.onSubmit?.(`/${command}`);
	}

	private colonKey(key: Key): void {
		const c = this.colon;
		if (key.code === "esc" || (key.code === "backspace" && c.text.length === 0)) {
			this.colonOpen = false;
			return;
		}
		if (key.code === "enter") {
			// No popup item to take: run what was typed, `:q` as `/quit`.
			this.submitColon(resolveColonAlias(c.text));
			return;
		}
		if (key.ctrl && key.code === "char") {
			if (key.ch === "w") c.deleteWord();
			else if (key.ch === "a") c.home();
			else if (key.ch === "e") c.end();
			else if (key.ch === "u") c.set("");
			else if (key.ch === "c") this.colonOpen = false;
			return;
		}
		switch (key.code) {
			case "tab":
				this.completion.forceOpen(this.colonTextState());
				return;
			case "char":
				if (!key.alt && key.ch) c.insert(key.ch);
				return;
			case "backspace":
				c.backspace();
				return;
			case "delete":
				c.delete();
				return;
			case "left":
				c.left();
				return;
			case "right":
				c.right();
				return;
			case "home":
				c.home();
				return;
			case "end":
				c.end();
				return;
		}
	}

	private submit(): void {
		this.completion.cancel();
		const text = this.st.buffer.trim();
		this.promptHistory.reset();
		this.engine.setText("");
		this.update(this.engine.clearUndo());
		this.scroll = 0;
		this.onChange?.("");
		this.onSubmit?.(text);
	}

	private browseHistory(direction: -1 | 1): void {
		this.completion.cancel();
		const text = direction === -1 ? this.promptHistory.prev(this.st.buffer) : this.promptHistory.next();
		if (text === undefined) {
			this.requestRender();
			return;
		}
		this.update(this.engine.setText(text));
		if (direction === -1) this.update(this.engine.moveTo(0));
		this.onChange?.(this.st.buffer);
	}

	private afterEdit(typed?: string): void {
		this.promptHistory.reset();
		this.onChange?.(this.st.buffer);
		if (this.st.mode === "insert") this.completion.update(this.textState(), typed);
		else this.completion.cancel();
	}

	private applyText(s: TextState): void {
		this.promptHistory.reset();
		this.engine.setText(s.text);
		this.update(this.engine.moveTo(s.cursor));
		this.onChange?.(this.st.buffer);
		this.requestRender();
	}

	/** Put a provider-side state (`/tree`) back on the colon line (`tree`). */
	private applyColonText(s: TextState): void {
		const text = s.text.replace(/^\//, "");
		this.colon.set(text);
		this.colon.cursor = Math.max(0, Math.min(text.length, s.cursor - 1));
		this.requestRender();
	}

	private textState(): TextState {
		return { text: this.st.buffer, cursor: this.st.cursor };
	}

	private update(state: EngineState): void {
		this.st = state;
		this.requestRender();
	}

	private requestRender(): void {
		this.syncCursor();
		this.tui.requestRender();
	}

	// ---- rendering ---------------------------------------------------------------

	private renderColonBorder(width: number): string {
		if (width <= 0) return "";
		const marker = this.focused ? CURSOR_MARKER : "";
		if (width === 1) return marker + renderFakeCursor(":");

		// Fit the command and its cursor before adding any border decoration.
		for (let windowWidth = width; ;) {
			const { before, at, after } = colonWindow(this.colon.text, this.colon.cursor, windowWidth, visibleWidth);
			const cell = visibleWidth(at) <= width - 1 ? at : " ";
			const cursor = marker + renderFakeCursor(cell);
			const line = windowWidth > 1 ? `:${before}${cursor}${after}` : `:${cursor}`;
			const spare = width - visibleWidth(line);
			if (spare >= 0) {
				const prefix = spare >= 2 ? this.borderColor("─") + " " : "";
				return prefix + line + this.borderColor("─".repeat(spare - (prefix ? 2 : 0)));
			}
			// A joined grapheme can be wider than the sum of its scalar widths.
			windowWidth = Math.max(1, windowWidth + spare);
		}
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		if (this.colonOpen) return this.renderColonBorder(width);
		const badge = this.host.badgeStyle(this.st.mode, ` ${BADGE[this.st.mode]} `);
		const remaining = width - visibleWidth(badge) - 1;
		if (!badge || remaining < 0) return super.renderBottomBorder(width, hiddenLineCount);
		const hint = hiddenLineCount > 0 ? ` ↓ ${hiddenLineCount} more ` : "";
		const hintWidth = visibleWidth(hint);
		if (hint && remaining < hintWidth + 2) return super.renderBottomBorder(width, hiddenLineCount);

		const keyDivider = "─";
		const keyEnd = " ─";
		// Keep at least one dash before the scroll hint, if present.
		const keyWidth = remaining - hintWidth - (hint ? 1 : 0) - keyDivider.length - 1 - keyEnd.length;
		const keys = fitPendingKeys(this.st.pendingKeys, keyWidth);
		const suffix = keys ? ` ${keys}${keyEnd}` : "";
		const fill = remaining - hintWidth - visibleWidth(suffix);
		const divider = hint ? (keys ? keyDivider : "─") : "";
		const tail = `${"─".repeat(fill - divider.length)}${hint}${divider}${suffix}`;
		return this.borderColor("─") + badge + this.borderColor(tail);
	}

	override render(width: number): string[] {
		this.syncCursor();
		const maxPad = Math.max(0, Math.floor((width - 1) / 2));
		const pad = Math.min(this.padding, maxPad);
		const contentWidth = Math.max(1, width - pad * 2);
		this.rows = paint({
			buffer: this.st.buffer,
			cursor: this.st.cursor,
			selection: this.st.selection,
			mode: this.st.mode,
			width: contentWidth,
			focused: this.focused && !this.colonOpen,
			selectionStyle: (s) => this.host.selectionStyle(s),
		});

		const maxLines = Math.max(5, Math.floor(this.tui.terminal.rows * 0.3));
		const cursorRow = Math.max(0, this.rows.findIndex((r) => r.hasCursor));
		if (cursorRow < this.scroll) this.scroll = cursorRow;
		else if (cursorRow >= this.scroll + maxLines) this.scroll = cursorRow - maxLines + 1;
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.rows.length - maxLines)));
		const visible = this.rows.slice(this.scroll, this.scroll + maxLines);
		this.visibleRowCount = visible.length;

		const left = " ".repeat(pad);
		const out = [this.renderTopBorder(width, this.scroll)];
		for (const row of visible) {
			out.push(left + row.text + " ".repeat(Math.max(0, contentWidth - row.width)) + left);
		}
		out.push(this.renderBottomBorder(width, this.rows.length - this.scroll - visible.length));
		const list = this.completion.list;
		const listLines = list?.render(contentWidth) ?? [];
		this.listRowCount = listLines.length;
		for (const line of listLines) {
			out.push(left + line + " ".repeat(Math.max(0, contentWidth - visibleWidth(line))) + left);
		}
		return out;
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const pad = Math.min(this.padding, Math.max(0, Math.floor((event.width - 1) / 2)));
		const contentWidth = Math.max(1, event.width - pad * 2);
		// The popup sits below the bottom border; a click applies the item.
		const list = this.completion.list;
		const listStart = this.visibleRowCount + 2;
		if (list && event.y >= listStart && event.y < listStart + this.listRowCount) {
			const result = list.handleMouse?.({
				...event,
				x: event.x - pad,
				y: event.y - listStart,
				width: contentWidth,
				height: this.listRowCount,
			});
			if (!result) return undefined;
			if (result.handled && event.type === "click") this.acceptCompletion();
			this.requestRender();
			return { ...result, focus: true };
		}
		// Leave press/drag/release to the renderer's screen selection ("Copied!").
		if (event.type !== "click" || event.button !== "left") return undefined;
		if (event.y <= 0 || event.y > this.visibleRowCount) return { handled: true, focus: true };
		const index = hitTest(this.rows, this.st.buffer, this.scroll + event.y - 1, Math.max(0, event.x - pad), contentWidth);
		this.completion.cancel();
		this.update(this.engine.moveTo(index));
		return { handled: true, focus: true };
	}
}
