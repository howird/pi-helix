/** Submitted prompts and unsent snapshots, browsed newest-first. */
export class History {
	private entries: { text: string; kind: "submitted" | "unsent" }[] = [];
	private index = -1;
	private draft = "";

	constructor(private readonly limit = 100) {}

	add(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (this.entries.find((entry) => entry.kind === "submitted")?.text === trimmed) return;
		this.push(trimmed, "submitted");
	}

	/** Save a prompt a colon command may clear, without treating it as submitted. */
	saveUnsent(text: string): void {
		if (!text) return;
		this.reset();
		// A command that leaves the draft in place would save it again.
		if (this.entries[0]?.text === text) return;
		this.push(text, "unsent");
	}

	private push(text: string, kind: "submitted" | "unsent"): void {
		this.entries.unshift({ text, kind });
		if (this.entries.length > this.limit) this.entries.pop();
	}

	/** Older entry, or undefined if there is none. */
	prev(current: string): string | undefined {
		if (this.index + 1 >= this.entries.length) return undefined;
		if (this.index === -1) this.draft = current;
		this.index++;
		return this.entries[this.index]?.text;
	}

	/** Newer entry; the saved draft past the newest; undefined when not browsing. */
	next(): string | undefined {
		if (this.index === -1) return undefined;
		this.index--;
		return this.index === -1 ? this.draft : this.entries[this.index]?.text;
	}

	reset(): void {
		this.index = -1;
		this.draft = "";
	}
}
