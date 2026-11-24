import { describe, expect, test } from "bun:test";
import { fromId, keyLabel, sanitizePaste, translate } from "../src/keys.ts";

test("pending key labels preserve printable keys and name special keys", () => {
	expect(keyLabel({ code: "char", ch: "A" })).toBe("A");
	expect(keyLabel({ code: "char", ch: " " })).toBe("<Space>");
	expect(keyLabel({ code: "left" })).toBe("<Left>");
	expect(keyLabel({ code: "pageup" })).toBe("<PageUp>");
	expect(keyLabel({ code: "char", ch: "x", ctrl: true })).toBe("<C-x>");
	expect(keyLabel({ code: "up", ctrl: true, alt: true, shift: true })).toBe("<C-A-S-Up>");
});

const key = (code: string, extra: Record<string, unknown> = {}) => ({ kind: "key", key: { code, ...extra } });
const ch = (c: string, extra: Record<string, unknown> = {}) => key("char", { ch: c, ...extra });

describe("translate", () => {
	test("printable ascii", () => {
		expect(translate("a")).toEqual(ch("a"));
		expect(translate("A")).toEqual(ch("A"));
		expect(translate(":")).toEqual(ch(":"));
		expect(translate(" ")).toEqual(ch(" "));
	});

	test("printable unicode", () => {
		expect(translate("é")).toEqual(ch("é"));
		expect(translate("😀")).toEqual(ch("😀"));
	});

	test("multi-scalar text stays together, and isolated surrogates are not input", () => {
		for (const text of ["日本語", "e\u0301", "👩‍💻"]) {
			expect(translate(text)).toEqual({ kind: "text", text });
		}
		expect(translate("\ud83d")).toEqual({ kind: "unknown" });
		expect(translate("text\x07")).toEqual({ kind: "unknown" });
	});

	test("named keys", () => {
		expect(translate("\x1b")).toEqual(key("esc"));
		expect(translate("\r")).toEqual(key("enter"));
		expect(translate("\t")).toEqual(key("tab"));
		expect(translate("\x7f")).toEqual(key("backspace"));
		expect(translate("\x1b[3~")).toEqual(key("delete"));
		expect(translate("\x1b[5~")).toEqual(key("pageup"));
		expect(translate("\x1bOH")).toEqual(key("home"));
		expect(translate("\x1b[H")).toEqual(key("home"));
		expect(translate("\x1b[A")).toEqual(key("up"));
		expect(translate("\x1bOP")).toEqual(key("f1"));
	});

	test("modifiers", () => {
		expect(translate("\x1b[1;5C")).toEqual(key("right", { ctrl: true }));
		expect(translate("\x1b[1;2A")).toEqual(key("up", { shift: true }));
		expect(translate("\x01")).toEqual(ch("a", { ctrl: true }));
		expect(translate("\x1b\r")).toEqual(key("enter", { alt: true }));
		expect(translate("\x1b[Z")).toEqual(key("backtab", { shift: true }));
	});

	test("kitty CSI-u", () => {
		expect(translate("\x1b[13;2u")).toEqual(key("enter", { shift: true }));
		expect(translate("\x1b[97;5u")).toEqual(ch("a", { ctrl: true }));
		expect(translate("\x1b[32u")).toEqual(ch(" "));
		expect(translate("\x1b[58;2u")).toEqual(ch(":"));
		expect(translate("\x1b[27u")).toEqual(key("esc"));
	});

	test("kitty release is ignored", () => {
		expect(translate("\x1b[97;1:3u")).toEqual({ kind: "ignore" });
	});

	test("bracketed paste", () => {
		expect(translate("\x1b[200~line1\r\nline2\x1b[201~")).toEqual({ kind: "paste", text: "line1\nline2" });
	});

	test("paste keeps tabs and newlines, drops other control characters", () => {
		expect(sanitizePaste("a\tb\nc")).toBe("a\tb\nc");
		expect(sanitizePaste("a\rb")).toBe("a\nb");
		expect(sanitizePaste("x\x1b[31mred\x1b[0m\x07\x00\x7f")).toBe("x[31mred[0m");
		expect(translate("\x1b[200~\x1b]0;title\x07ok\x1b[201~")).toEqual({ kind: "paste", text: "]0;titleok" });
	});

	test("paste decodes CSI-u control bytes", () => {
		// Ctrl+J (newline) and Ctrl+I (tab), lower and upper case codepoints.
		expect(sanitizePaste("a\x1b[106;5ub\x1b[73;5uc")).toBe("a\nb\tc");
		// Ctrl+M is a carriage return, normalized like any other.
		expect(sanitizePaste("a\x1b[109;5ub")).toBe("a\nb");
		// Not a letter: left alone, then stripped of its ESC.
		expect(sanitizePaste("a\x1b[49;5ub")).toBe("a[49;5ub");
	});

	test("unknown sequences aren't treated as text", () => {
		expect(translate("\x1b[999~")).toEqual({ kind: "unknown" });
	});

	test("named keys the engine lacks are unknown, not characters", () => {
		// Keypad 5 parses as "clear".
		expect(translate("\x1b[E")).toEqual({ kind: "unknown" });
		expect(translate("\x1bOE")).toEqual({ kind: "unknown" });
		expect(fromId("clear")).toBeUndefined();
		expect(fromId("super+a")).toBeUndefined();
		expect(fromId("ctrl++")).toEqual({ code: "char", ch: "+", ctrl: true });
	});
});

describe("fromId edge cases", () => {
	test("punctuation and combined modifiers", () => {
		expect(translate("\x1b[45;5u")).toEqual(ch("-", { ctrl: true }));
		expect(translate("\x1b[1;6A")).toEqual(key("up", { shift: true, ctrl: true }));
		expect(translate("\x00")).toEqual(ch(" ", { ctrl: true }));
		expect(translate("\x1b\x7f")).toEqual(key("backspace", { alt: true }));
		expect(translate("\x1b[15~")).toEqual(key("f5"));
	});
});
