/**
 * Raw terminal input → reedline key events.
 *
 * pi-tui already splits stdin into one sequence per call and normalizes legacy,
 * xterm-modifier and Kitty CSI-u encodings in `parseKey` ("ctrl+right",
 * "shift+enter", "a"). We map those ids onto the crossterm-shaped key the
 * native engine expects.
 */
import { decodeKittyPrintable, isKeyRelease, parseKey } from "@earendil-works/pi-tui";

export interface Key {
	code: string;
	ch?: string;
	ctrl?: boolean;
	alt?: boolean;
	shift?: boolean;
}

/** A single display token, so the footer can truncate only between keys. */
export function keyLabel({ code, ch, ctrl, alt, shift }: Key): string {
	let name: string;
	switch (code) {
		case "char": name = ch === " " ? "Space" : (ch ?? ""); break;
		case "pageup": name = "PageUp"; break;
		case "pagedown": name = "PageDown"; break;
		default: name = code.charAt(0).toUpperCase() + code.slice(1);
	}
	if (code === "char" && ch !== " " && !ctrl && !alt && !shift) return name;
	return `<${ctrl ? "C-" : ""}${alt ? "A-" : ""}${shift ? "S-" : ""}${name}>`;
}

export type Input =
	| { kind: "key"; key: Key }
	| { kind: "text"; text: string }
	| { kind: "paste"; text: string }
	| { kind: "ignore" }
	| { kind: "unknown" };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const NAMED: Record<string, string> = {
	escape: "esc",
	enter: "enter",
	tab: "tab",
	backspace: "backspace",
	delete: "delete",
	insert: "insert",
	home: "home",
	end: "end",
	pageUp: "pageup",
	pageDown: "pagedown",
	up: "up",
	down: "down",
	left: "left",
	right: "right",
};

function isPrintable(data: string): boolean {
	// No terminal controls or isolated UTF-16 surrogates. With /u, valid
	// surrogate pairs are matched as one Unicode scalar, not as surrogates.
	return data.length > 0 && !/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(data);
}

/**
 * Pasted text as the buffer should hold it: `\n` line endings, tabs kept, no
 * other control characters, so a pasted escape sequence is never painted.
 *
 * Some terminals (tmux popups with extended-keys-format=csi-u) re-encode
 * control bytes inside a paste as CSI-u Ctrl+<letter>; those are decoded
 * first so a newline survives instead of leaking "[106;5u" into the text.
 */
export function sanitizePaste(text: string): string {
	return text
		.replace(/\x1b\[(\d+);5u/g, (match, code) => {
			const cp = Number(code);
			if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
			if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
			return match;
		})
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function translate(data: string): Input {
	if (data.startsWith(PASTE_START)) {
		const end = data.indexOf(PASTE_END);
		const body = data.slice(PASTE_START.length, end === -1 ? undefined : end);
		return { kind: "paste", text: sanitizePaste(body) };
	}
	if (isKeyRelease(data)) return { kind: "ignore" };

	const text = isPrintable(data) ? data : decodeKittyPrintable(data);
	if (text && isPrintable(text)) {
		// Native Char takes one Unicode scalar. IME commits and multi-scalar
		// graphemes must be inserted as a string, not as a sequence of motions.
		if ([...text].length === 1) return { kind: "key", key: { code: "char", ch: text } };
		return { kind: "text", text };
	}

	const id = parseKey(data);
	const key = id === undefined ? undefined : fromId(id);
	return key ? { kind: "key", key } : { kind: "unknown" };
}

/**
 * Parse a pi-tui key id such as "shift+ctrl+up" or "ctrl+-".
 *
 * Undefined for ids the engine has no key for ("clear", "super+a"): passing
 * those on as a character would type or run their first letter.
 */
export function fromId(id: string): Key | undefined {
	const parts = id.split("+");
	// "ctrl++" / "+" : the base key may itself be "+".
	let base = parts.pop() as string;
	if (base === "" && parts.length > 0) {
		parts.pop();
		base = "+";
	}
	const key: Key = { code: "char" };
	for (const mod of parts) {
		if (mod === "ctrl") key.ctrl = true;
		else if (mod === "alt") key.alt = true;
		else if (mod === "shift") key.shift = true;
		else return undefined;
	}
	if (base === "space") {
		key.ch = " ";
	} else if (base === "tab" && key.shift) {
		key.code = "backtab";
	} else if (NAMED[base]) {
		key.code = NAMED[base];
	} else if (/^f\d{1,2}$/.test(base)) {
		key.code = base;
	} else if ([...base].length === 1) {
		key.ch = base;
	} else {
		return undefined;
	}
	return key;
}
