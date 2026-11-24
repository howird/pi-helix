import { expect, test } from "bun:test";
import { History } from "../src/history.ts";

test("history browse restores draft", () => {
	const h = new History();
	h.add("one");
	h.add("two");
	expect(h.prev("draft")).toBe("two");
	expect(h.prev("two")).toBe("one");
	expect(h.prev("one")).toBeUndefined();
	expect(h.next()).toBe("two");
	expect(h.next()).toBe("draft");
	expect(h.next()).toBeUndefined();
});

test("unsent snapshots keep exact text and don't affect submitted deduplication", () => {
	const h = new History();
	h.add("  prompt  ");
	h.saveUnsent("  prompt  ");
	h.add("prompt");
	h.saveUnsent(" \n\t");
	h.reset();
	expect(h.prev("")).toBe(" \n\t");
	expect(h.prev("")).toBe("  prompt  ");
	expect(h.prev("")).toBe("prompt");
	expect(h.prev("")).toBeUndefined();
	expect(h.next()).toBe("  prompt  ");
	expect(h.next()).toBe(" \n\t");
	expect(h.next()).toBe("");
});

test("repeated unsent snapshots of the same text are stored once", () => {
	const h = new History();
	h.add("sent");
	h.saveUnsent("foo");
	h.saveUnsent("foo");
	h.saveUnsent("foo");
	expect(h.prev("foo")).toBe("foo");
	expect(h.prev("foo")).toBe("sent");
	expect(h.prev("sent")).toBeUndefined();
});
