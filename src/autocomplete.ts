/**
 * pi's AutocompleteProvider driven against a plain text + cursor, with a
 * SelectList popup. Mirrors pi-tui Editor's trigger rules.
 */
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	SelectList,
	type SelectListTheme,
} from "@earendil-works/pi-tui";

export interface TextState {
	readonly text: string;
	readonly cursor: number;
}

const SLASH_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 };
const DEFAULT_TRIGGERS = ["@", "#"];

function sameState(a: TextState, b: TextState): boolean {
	return a.text === b.text && a.cursor === b.cursor;
}

/** (line, col) of a UTF-16 index, as AutocompleteProvider expects. */
export function toLineCol(text: string, cursor: number): { lines: string[]; line: number; col: number } {
	const lines = text.split("\n");
	const before = text.slice(0, cursor).split("\n");
	return { lines, line: before.length - 1, col: before.at(-1)?.length ?? 0 };
}

export function fromLineCol(lines: string[], line: number, col: number): TextState {
	let cursor = 0;
	for (let i = 0; i < line; i++) cursor += (lines[i]?.length ?? 0) + 1;
	return { text: lines.join("\n"), cursor: cursor + col };
}

export class Completion {
	provider?: AutocompleteProvider;
	list?: SelectList;
	private prefix = "";
	private shownFor?: TextState;
	private exactCommand?: AutocompleteItem;
	private force = false;
	private abort?: AbortController;
	private triggers = DEFAULT_TRIGGERS;
	private requestId = 0;
	/**
	 * The text the popup is completing right now. A request that resolves
	 * after the text moved on is dropped rather than applied to stale text.
	 */
	current?: () => TextState;

	constructor(
		private readonly theme: SelectListTheme,
		private readonly maxVisible: () => number,
		private readonly requestRender: () => void,
		private readonly isColonPrompt: () => boolean = () => false,
	) {}

	setProvider(provider: AutocompleteProvider): void {
		this.cancel();
		this.provider = provider;
		const extra = (provider.triggerCharacters ?? []).filter((c) => c.length === 1 && c !== "/" && !/\s/.test(c));
		this.triggers = [...new Set([...DEFAULT_TRIGGERS, ...extra])];
	}

	get open(): boolean {
		return this.list !== undefined;
	}

	/** Decide whether `state` should show suggestions; refresh if open. */
	update(state: TextState, typed?: string): void {
		if (!this.provider) return;
		const { lines, line, col } = toLineCol(state.text, state.cursor);
		const before = (lines[line] ?? "").slice(0, col);
		if (this.open) {
			this.request(state, this.force);
			return;
		}
		if (typed === undefined) return;
		const slash = line === 0 && before.trimStart().startsWith("/");
		const token = /(?:^|[\s([{<`])([^\s]*)$/u.exec(before)?.[1] ?? "";
		const symbol = token.length > 0 && this.triggers.includes(token[0] as string);
		if (slash || symbol) this.request(state, false);
	}

	/** Tab with nothing open: force file completion (or slash command). */
	forceOpen(state: TextState): void {
		if (!this.provider) return;
		const { lines, line, col } = toLineCol(state.text, state.cursor);
		const before = (lines[line] ?? "").slice(0, col);
		const slashCommand = line === 0 && before.trimStart().startsWith("/") && !before.trimStart().includes(" ");
		if (!slashCommand && this.provider.shouldTriggerFileCompletion?.(lines, line, col) === false) return;
		this.request(state, !slashCommand, true);
	}

	private request(state: TextState, force: boolean, explicitTab = false): void {
		const provider = this.provider;
		if (!provider) return;
		// Keep painting the previous list during refresh, but don't apply it.
		this.shownFor = undefined;
		this.abort?.abort();
		const controller = new AbortController();
		this.abort = controller;
		const id = ++this.requestId;
		const { lines, line, col } = toLineCol(state.text, state.cursor);
		void provider.getSuggestions(lines, line, col, { signal: controller.signal, force }).then(
			(suggestions) => {
				if (controller.signal.aborted || id !== this.requestId) return;
				const now = this.current?.();
				if (now && !sameState(now, state)) {
					this.close();
					this.requestRender();
					return;
				}
				if (!suggestions || suggestions.items.length === 0) {
					this.close();
				} else if (force && explicitTab && suggestions.items.length === 1) {
					this.onAutoApply?.(this.apply(state, suggestions.items[0] as AutocompleteItem, suggestions.prefix));
					this.close();
				} else {
					this.show(state, suggestions.items, suggestions.prefix, force);
				}
				this.requestRender();
			},
			() => {
				if (id !== this.requestId) return;
				this.close();
				this.requestRender();
			},
		);
	}

	/** Called when a single forced match is applied without showing a list. */
	onAutoApply?: (state: TextState) => void;

	private show(state: TextState, items: AutocompleteItem[], prefix: string, force: boolean): void {
		this.shownFor = state;
		this.prefix = prefix;
		this.force = force;
		this.exactCommand = undefined;
		this.list = new SelectList(items, this.maxVisible(), this.theme, prefix.startsWith("/") ? SLASH_LAYOUT : undefined);
		if (this.isColonPrompt()) {
			// Command-name completion replaces the leading slash token; argument
			// and file completions can also have slash-prefixed values or prefixes.
			if (force || prefix !== state.text.slice(0, state.cursor) || !/^\/[^\s/]*$/u.test(prefix)) return;
			const command = state.text.split(" ", 1)[0];
			// Pi returns bare command names. Wrapped providers may include the slash.
			const exact = items.findIndex((i) => i.value === command || `/${i.value}` === command);
			if (exact >= 0) {
				this.exactCommand = items[exact];
				this.list.setSelectedIndex(exact);
			} else if (prefix === "/q" && state.text === prefix) {
				const quit = items.findIndex((i) => i.value === "quit" || i.value === "/quit");
				if (quit >= 0) this.list.setSelectedIndex(quit);
			}
			return;
		}
		const exact = items.findIndex((i) => i.value === prefix);
		const starts = items.findIndex((i) => prefix && i.value.startsWith(prefix));
		const best = exact >= 0 ? exact : starts;
		if (best >= 0) this.list.setSelectedIndex(best);
	}

	/** Accept the highlighted item. Colon Enter can run an exact command unchanged. */
	accept(state: TextState, preserveExactCommand = false): { state: TextState; slash: boolean } | undefined {
		const item = this.list?.getSelectedItem();
		if (!item || !this.shownFor || !sameState(this.shownFor, state)) return undefined;
		const slash = this.prefix.startsWith("/");
		const next = preserveExactCommand && item === this.exactCommand ? state : this.apply(state, item, this.prefix);
		this.cancel();
		return { state: next, slash };
	}

	private apply(state: TextState, item: AutocompleteItem, prefix: string): TextState {
		const { lines, line, col } = toLineCol(state.text, state.cursor);
		const result = (this.provider as AutocompleteProvider).applyCompletion(lines, line, col, item, prefix);
		return fromLineCol(result.lines, result.cursorLine, result.cursorCol);
	}

	private close(): void {
		this.list = undefined;
		this.shownFor = undefined;
		this.exactCommand = undefined;
		this.prefix = "";
		this.force = false;
	}

	cancel(): void {
		this.abort?.abort();
		this.abort = undefined;
		this.requestId++;
		this.close();
	}
}
