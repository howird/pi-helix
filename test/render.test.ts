import { expect, test } from "bun:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { hitTest, paint } from "../src/render.ts";

const strip = (s: string) =>
	s.replaceAll(CURSOR_MARKER, "").replace(/\x1b_pi:\/?fc\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");
const sel = (s: string) => `[${s}]`;
const base = { focused: true, selectionStyle: sel, width: 20 } as const;

test("single line insert cursor at end", () => {
	const rows = paint({ ...base, buffer: "hello", cursor: 5, mode: "insert" });
	expect(rows.length).toBe(1);
	expect(strip(rows[0]!.text)).toBe("hello ");
	expect(rows[0]!.hasCursor).toBe(true);
	expect(rows[0]!.text).toContain(CURSOR_MARKER);
});

test("multi-line maps rows to buffer ranges", () => {
	const rows = paint({ ...base, buffer: "ab\ncd", cursor: 4, mode: "normal" });
	expect(rows.map((r) => [r.start, r.end])).toEqual([
		[0, 2],
		[3, 5],
	]);
	expect(rows[1]!.hasCursor).toBe(true);
	expect(rows[0]!.hasCursor).toBe(false);
});

test("selection is styled", () => {
	const rows = paint({ ...base, buffer: "foo bar", cursor: 4, selection: [0, 4], mode: "normal" });
	expect(strip(rows[0]!.text)).toBe("[f][o][o][ ]bar");
});

test("wraps long lines at word boundary", () => {
	const rows = paint({ ...base, width: 8, buffer: "hello world foo", cursor: 0, mode: "insert" });
	expect(rows.map((r) => strip(r.text).trimEnd())).toEqual(["hello", "world", "foo"]);
	expect(rows[1]!.start).toBe(6);
});

test("hitTest maps clicks to indices", () => {
	const buffer = "ab\ncdef";
	const rows = paint({ ...base, buffer, cursor: 0, mode: "insert" });
	expect(hitTest(rows, buffer, 1, 2)).toBe(5);
	expect(hitTest(rows, buffer, 0, 10)).toBe(2);
	expect(hitTest(rows, buffer, 5, 0)).toBe(3);
});

test("wide chars", () => {
	const rows = paint({ ...base, buffer: "日本", cursor: 1, mode: "normal" });
	expect(rows[0]!.width).toBe(4);
	expect(hitTest(rows, "日本", 0, 3)).toBe(1);
});

test("a word carried past a space is re-wrapped when the next cell does not fit", () => {
	for (const last of ["\t", "字"]) {
		const buffer = ` ${"a".repeat(18)}${last}`;
		const rows = paint({ ...base, buffer, cursor: 0, mode: "insert" });
		for (const row of rows) expect(visibleWidth(strip(row.text))).toBeLessThanOrEqual(20);
		expect(rows.at(-1)!.end).toBe(buffer.length);
	}
});

test("no painted row exceeds the width", () => {
	const buffers = [
		` ${"a".repeat(18)}\t`,
		"\t\t\tx",
		"a\tb 字字字 cc\tdd",
		"日本語 hello world 日本語日本語",
		`${"word ".repeat(12)}\t${"x".repeat(30)}`,
	];
	for (const width of [3, 4, 5, 8, 20]) {
		for (const buffer of buffers) {
			for (const cursor of [0, buffer.length]) {
				const rows = paint({ ...base, width, buffer, cursor, selection: [0, buffer.length], mode: "normal" });
				for (const row of rows) {
					expect(row.width).toBeLessThanOrEqual(width);
					expect(visibleWidth(strip(row.text).replace(/[\[\]]/g, ""))).toBe(row.width);
				}
				expect(rows.map((r) => buffer.slice(r.start, r.end)).join("")).toBe(buffer);
			}
		}
	}
});
