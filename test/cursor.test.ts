import { expect, test } from "bun:test";
import { cursorBlink, cursorShapes } from "../src/cursor.ts";

test("blink by default", () => {
	expect(cursorBlink(undefined)).toBe(true);
	expect(cursorBlink("")).toBe(true);
	expect(cursorBlink("1")).toBe(true);
});

test("steady when disabled", () => {
	for (const v of ["0", "false", "No", " off "]) expect(cursorBlink(v)).toBe(false);
});

test("shapes", () => {
	expect(cursorShapes(true)).toEqual({ block: "\x1b[1 q", bar: "\x1b[5 q", reset: "\x1b[0 q" });
	expect(cursorShapes(false)).toEqual({ block: "\x1b[2 q", bar: "\x1b[6 q", reset: "\x1b[0 q" });
});
