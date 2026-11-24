/**
 * DECSCUSR cursor shapes. PI_HELIX_CURSOR_BLINK=0 (or false/no/off) makes
 * them steady; anything else, including unset, blinks.
 */
export function cursorShapes(blink = cursorBlink()) {
	return blink
		? { block: "\x1b[1 q", bar: "\x1b[5 q", reset: "\x1b[0 q" }
		: { block: "\x1b[2 q", bar: "\x1b[6 q", reset: "\x1b[0 q" };
}

export function cursorBlink(value = process.env.PI_HELIX_CURSOR_BLINK): boolean {
	return !/^(0|false|no|off)$/i.test((value ?? "").trim());
}

