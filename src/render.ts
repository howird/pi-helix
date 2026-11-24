/**
 * Pure layout + painting for the editor body.
 *
 * Input is the engine state in UTF-16 indices. Output is one string per
 * visual row (without borders/padding) plus a map from rows back to buffer
 * indices for mouse hit-testing.
 */
import { CURSOR_MARKER, renderFakeCursor, visibleWidth } from "@earendil-works/pi-tui";
import type { Mode } from "./native.ts";

export interface Row {
	/** Painted text. */
	text: string;
	/** Visible width of `text`. */
	width: number;
	/** Buffer index of the row's first grapheme. */
	start: number;
	/** Buffer index one past the row's last grapheme (excludes the newline). */
	end: number;
	hasCursor: boolean;
}

export interface PaintOptions {
	buffer: string;
	cursor: number;
	selection?: [number, number];
	mode: Mode;
	width: number;
	/** Emit the hardware cursor marker (focused editor). */
	focused: boolean;
	selectionStyle: (s: string) => string;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface Cell {
	text: string;
	start: number;
	end: number;
	width: number;
}

const TAB_WIDTH = 4;

/**
 * Split one logical line into graphemes with their buffer indices. A tab is
 * one cell of up to `maxWidth` columns, so it always fits on a row.
 */
function cells(line: string, offset: number, maxWidth = TAB_WIDTH): Cell[] {
	const out: Cell[] = [];
	const tab = Math.max(1, Math.min(TAB_WIDTH, maxWidth));
	for (const { segment, index } of segmenter.segment(line)) {
		const isTab = segment === "\t";
		out.push({
			text: isTab ? " ".repeat(tab) : segment,
			start: offset + index,
			end: offset + index + segment.length,
			width: isTab ? tab : visibleWidth(segment),
		});
	}
	return out;
}

/** Hard-wrap cells at `width`, preferring the last space. */
function wrap(line: Cell[], width: number): Cell[][] {
	const rows: Cell[][] = [];
	let row: Cell[] = [];
	let rowWidth = 0;
	let lastSpace = -1;
	for (const cell of line) {
		if (rowWidth + cell.width > width && row.length > 0) {
			const tail = lastSpace >= 0 ? row.slice(lastSpace + 1) : [];
			const tailWidth = tail.reduce((n, c) => n + c.width, 0);
			// Break at the last space only if the carried word still fits with
			// this cell; otherwise break right here.
			if (tail.length > 0 && tailWidth + cell.width <= width) {
				rows.push(row.slice(0, lastSpace + 1));
				row = tail;
				rowWidth = tailWidth;
			} else {
				rows.push(row);
				row = [];
				rowWidth = 0;
			}
			lastSpace = -1;
		}
		row.push(cell);
		rowWidth += cell.width;
		if (cell.text === " ") lastSpace = row.length - 1;
	}
	rows.push(row);
	return rows;
}

export function paint(o: PaintOptions): Row[] {
	const rows: Row[] = [];
	const [selStart, selEnd] = o.selection ?? [-1, -1];
	// The cursor cell is always drawn as a fake (reverse-video) cursor after
	// CURSOR_MARKER. When pi shows the hardware cursor it drops that fake cursor
	// and puts the terminal cursor there instead, shaped bar or block per mode.
	let offset = 0;
	const lines = o.buffer.split("\n");
	lines.forEach((line, lineIndex) => {
		const lineEnd = offset + line.length;
		const wrapWidth = Math.max(1, o.width - 1);
		const wrapped = wrap(cells(line, offset, wrapWidth), wrapWidth);
		wrapped.forEach((row, rowIndex) => {
			const start = row[0]?.start ?? offset;
			const end = row.at(-1)?.end ?? offset;
			const lastRowOfLine = rowIndex === wrapped.length - 1;
			const cursorHere = (o.cursor >= start && o.cursor < end) || (lastRowOfLine && o.cursor === lineEnd);
			let text = "";
			let width = 0;
			let marked = false;
			const mark = () => {
				if (o.focused && !marked) {
					text += CURSOR_MARKER;
					marked = true;
				}
			};
			for (const cell of row) {
				const selected = cell.start >= selStart && cell.end <= selEnd;
				const isCursor = cursorHere && cell.start === o.cursor;
				if (isCursor) mark();
				if (isCursor) text += renderFakeCursor(cell.text);
				else if (selected) text += o.selectionStyle(cell.text);
				else text += cell.text;
				width += cell.width;
			}
			if (cursorHere && o.cursor === lineEnd && lastRowOfLine) {
				// Past the last grapheme: the newline cell (helix) or end of buffer.
				mark();
				text += renderFakeCursor(" ");
				width += 1;
			} else if (selEnd > lineEnd && selStart <= lineEnd && lastRowOfLine && lineIndex < lines.length - 1) {
				// Selection spans this line's newline.
				text += o.selectionStyle(" ");
				width += 1;
			}
			rows.push({ text, width, start, end: lastRowOfLine ? lineEnd : end, hasCursor: cursorHere });
		});
		offset = lineEnd + 1;
	});
	return rows;
}

/** Buffer index for a click at (`row`, `col`) in painted rows. */
export function hitTest(rows: Row[], buffer: string, row: number, col: number, width = Infinity): number {
	const r = rows[Math.max(0, Math.min(row, rows.length - 1))];
	if (!r) return 0;
	let x = 0;
	for (const cell of cells(buffer.slice(r.start, r.end), r.start, Math.max(1, width - 1))) {
		if (col < x + cell.width) return cell.start;
		x += cell.width;
	}
	return r.end;
}
