/** Command-line shorthands: `:q` runs `/quit`. Arguments are kept. */
const COLON_ALIASES: Record<string, string> = { q: "quit" };

/** Expand an aliased command name; anything else is returned trimmed. */
export function resolveColonAlias(input: string): string {
	const text = input.trim();
	const [, name = "", rest = ""] = /^(\S*)(.*)$/su.exec(text) ?? [];
	const target = Object.hasOwn(COLON_ALIASES, name) ? COLON_ALIASES[name] : undefined;
	return target ? target + rest : text;
}

/**
 * The part of the command line that fits `width` columns after the `:`
 * prompt, split at the cursor. `at` is the character under the cursor, a
 * space when the cursor is past the end. Scrolls to keep the cursor in view,
 * roughly centred.
 */
export function colonWindow(
	text: string,
	cursor: number,
	width: number,
	charWidth: (ch: string) => number,
): { before: string; at: string; after: string } {
	const avail = Math.max(1, width - 1);
	const chars = [...text];
	const widths = chars.map(charWidth);
	// Index of the character under the cursor; chars.length when past the end.
	let index = 0;
	for (let offset = 0; index < chars.length && offset < cursor; index++) offset += (chars[index] as string).length;
	const cursorWidth = index < chars.length ? (widths[index] as number) : 1;

	// Grow the window left from the cursor up to half the room, then right as
	// far as it fits, then left again with whatever is still free.
	let start = index;
	let used = cursorWidth;
	const growLeft = (limit: number) => {
		while (start > 0 && used + (widths[start - 1] as number) <= limit) used += widths[--start] as number;
	};
	growLeft(Math.max(cursorWidth, Math.floor(avail / 2)));
	let end = Math.min(chars.length, index + 1);
	while (end < chars.length && used + (widths[end] as number) <= avail) used += widths[end++] as number;
	growLeft(avail);

	return {
		before: chars.slice(start, index).join(""),
		at: chars[index] ?? " ",
		after: chars.slice(index + 1, end).join(""),
	};
}

/** Minimal line editor for the command line. */
export class ColonLine {
	text = "";
	cursor = 0;

	open(): void {
		this.text = "";
		this.cursor = 0;
	}

	insert(s: string): void {
		this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
		this.cursor += s.length;
	}

	backspace(): boolean {
		if (this.cursor === 0) return this.text.length > 0;
		const before = [...this.text.slice(0, this.cursor)];
		const removed = before.pop() ?? "";
		this.text = before.join("") + this.text.slice(this.cursor);
		this.cursor -= removed.length;
		return true;
	}

	delete(): void {
		const after = [...this.text.slice(this.cursor)];
		after.shift();
		this.text = this.text.slice(0, this.cursor) + after.join("");
	}

	left(): void {
		const before = [...this.text.slice(0, this.cursor)];
		this.cursor -= before.pop()?.length ?? 0;
	}

	right(): void {
		const after = [...this.text.slice(this.cursor)];
		this.cursor += after[0]?.length ?? 0;
	}

	home(): void {
		this.cursor = 0;
	}

	end(): void {
		this.cursor = this.text.length;
	}

	deleteWord(): void {
		const before = this.text.slice(0, this.cursor).replace(/\S*\s*$/, "");
		this.text = before + this.text.slice(this.cursor);
		this.cursor = before.length;
	}

	set(text: string): void {
		this.text = text;
		this.cursor = text.length;
	}
}
