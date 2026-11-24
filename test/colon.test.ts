import { describe, expect, test } from "bun:test";
import { colonWindow } from "../src/colon.ts";

// East Asian wide characters take two columns.
const width = (ch: string) => (/[　-鿿＀-￯]/.test(ch) ? 2 : 1);
const win = (text: string, cursor: number, w: number) => colonWindow(text, cursor, w, width);
const cols = (s: string) => [...s].reduce((n, ch) => n + width(ch), 0);
/** Columns of the rendered line: prompt, text, cursor cell. */
const total = (w: { before: string; at: string; after: string }) => 1 + cols(w.before) + cols(w.at) + cols(w.after);

describe("colonWindow", () => {
	test("short text is shown whole", () => {
		expect(win("tree", 2, 20)).toEqual({ before: "tr", at: "e", after: "e" });
		expect(win("tree", 4, 20)).toEqual({ before: "tree", at: " ", after: "" });
		expect(win("", 0, 20)).toEqual({ before: "", at: " ", after: "" });
	});

	test("text that exactly fits is not scrolled", () => {
		// ":" + 8 chars + cursor cell = 10 columns.
		expect(win("abcdefgh", 8, 10)).toEqual({ before: "abcdefgh", at: " ", after: "" });
	});

	test("long text scrolls to the cursor and never exceeds the width", () => {
		const text = "abcdefghijklmnopqrstuvwxyz";
		for (let cursor = 0; cursor <= text.length; cursor++) {
			const w = win(text, cursor, 10);
			expect(total(w)).toBeLessThanOrEqual(10);
			expect(w.at).toBe(text[cursor] ?? " ");
			expect(text).toContain(w.before + (text[cursor] ?? "") + w.after);
		}
		expect(win(text, 26, 10)).toEqual({ before: "stuvwxyz", at: " ", after: "" });
		expect(win(text, 0, 10)).toEqual({ before: "", at: "a", after: "bcdefghi" });
	});

	test("wide characters", () => {
		const text = "日本語日本語日本語";
		for (let cursor = 0; cursor <= text.length; cursor++) {
			expect(total(win(text, cursor, 9))).toBeLessThanOrEqual(9);
		}
		expect(win(text, 1, 40).at).toBe("本");
	});

	test("astral characters count as one cursor step", () => {
		expect(win("a😀b", 3, 20)).toEqual({ before: "a😀", at: "b", after: "" });
	});

	test("tiny widths still show the cursor", () => {
		expect(win("abc", 1, 1)).toEqual({ before: "", at: "b", after: "" });
		expect(win("abc", 1, 2)).toEqual({ before: "", at: "b", after: "" });
	});
});
