import { describe, expect, test } from "bun:test";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { Completion, type TextState } from "../src/autocomplete.ts";

const THEME = {
	selectedPrefix: (s: string) => s,
	selectedText: (s: string) => s,
	description: (s: string) => s,
	scrollInfo: (s: string) => s,
	noMatch: (s: string) => s,
};

/** A provider whose single request resolves when the test says so. */
function setup(items: string[]) {
	let resolve!: (s: AutocompleteSuggestions | null) => void;
	const provider = {
		getSuggestions: () => new Promise<AutocompleteSuggestions | null>((r) => (resolve = r)),
		applyCompletion: (lines: string[], line: number, _col: number, item: { value: string }) => ({
			lines: lines.map((l, i) => (i === line ? item.value : l)),
			cursorLine: line,
			cursorCol: item.value.length,
		}),
	} as unknown as AutocompleteProvider;
	const completion = new Completion(THEME as never, () => 5, () => {});
	completion.setProvider(provider);
	let now: TextState = { text: "src/ed", cursor: 6 };
	completion.current = () => now;
	const applied: TextState[] = [];
	completion.onAutoApply = (s) => applied.push(s);
	const finish = async () => {
		resolve({ items: items.map((value) => ({ value, label: value })), prefix: "src/ed" });
		await new Promise((r) => setTimeout(r, 0));
	};
	return { completion, applied, finish, type: (s: TextState) => (now = s), state: () => now };
}

describe("Completion", () => {
	test("a single forced match is applied", async () => {
		const t = setup(["src/editor.ts"]);
		t.completion.forceOpen(t.state());
		await t.finish();
		expect(t.applied).toEqual([{ text: "src/editor.ts", cursor: 13 }]);
		expect(t.completion.open).toBe(false);
	});

	test("a forced match is dropped when the text moved on", async () => {
		const t = setup(["src/editor.ts"]);
		t.completion.forceOpen(t.state());
		t.type({ text: "src/ed and more", cursor: 15 });
		await t.finish();
		expect(t.applied).toEqual([]);
		expect(t.completion.open).toBe(false);
	});

	test("a list for stale text is not shown", async () => {
		const t = setup(["src/editor.ts", "src/edit.ts"]);
		t.completion.forceOpen(t.state());
		t.type({ text: "src/ed", cursor: 3 });
		await t.finish();
		expect(t.completion.open).toBe(false);
	});

	test("a forced match is dropped on cursor-only movement", async () => {
		const t = setup(["src/editor.ts"]);
		t.completion.forceOpen(t.state());
		t.type({ ...t.state(), cursor: 3 });
		await t.finish();
		expect(t.applied).toEqual([]);
	});

	test("a visible list is only accepted at its original text and cursor", async () => {
		const t = setup(["src/editor.ts", "src/edit.ts"]);
		t.completion.forceOpen(t.state());
		await t.finish();
		expect(t.completion.open).toBe(true);
		expect(t.completion.accept({ ...t.state(), cursor: 3 })).toBeUndefined();
		expect(t.completion.accept({ ...t.state(), text: "src/ex" })).toBeUndefined();
		expect(t.completion.accept(t.state())?.state.text).toBe("src/editor.ts");
	});

	test("old items cannot be accepted while a replacement request is pending", async () => {
		const t = setup(["src/editor.ts", "src/edit.ts"]);
		t.completion.forceOpen(t.state());
		await t.finish();
		const old = t.state();
		t.type({ text: "src/edi", cursor: 7 });
		t.completion.update(t.state(), "i");
		expect(t.completion.open).toBe(true);
		expect(t.completion.accept(t.state())).toBeUndefined();
		expect(t.completion.accept(old)).toBeUndefined();
		await t.finish();
		expect(t.completion.accept(t.state())?.state.text).toBe("src/editor.ts");
	});
});
