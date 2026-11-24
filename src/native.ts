/**
 * Loads the pi-reedline napi addon.
 *
 * Search order: `PI_HELIX_NATIVE`, then `pi_reedline.node` next to the
 * package root (where the Nix build and `npm run build:native` put it).
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Key } from "./keys.ts";

export type EditModeName = "helix" | "vi";
export type Mode = "normal" | "insert" | "select";
export type Action = "none" | "unhandled" | "submit" | "abort";

export interface EngineState {
	buffer: string;
	/** UTF-16 index of the insertion point. */
	cursor: number;
	/** UTF-16 [start, end) of the selection. */
	selection?: [number, number];
	mode: Mode;
	action: Action;
	/** Text yanked by this key. */
	yanked?: string;
	/** The modal parser is waiting for another key. */
	pending: boolean;
	/** Original key events in the unfinished modal sequence. */
	pendingKeys: Key[];
}

export interface Engine {
	feed(key: Key): EngineState;
	state(): EngineState;
	/** Empty buffer and the mode's initial state, as a new engine. */
	reset(): EngineState;
	/** Start a new undo/redo history without changing text, mode or registers. */
	clearUndo(): EngineState;
	setText(text: string): EngineState;
	insertString(text: string): EngineState;
	moveTo(index: number): EngineState;
}

interface Native {
	Engine: new (mode: string) => Engine;
}

let cached: Native | undefined;

export function loadNative(): Native {
	if (cached) return cached;
	const override = process.env.PI_HELIX_NATIVE;
	if (override === "") throw new Error("pi-helix: PI_HELIX_NATIVE is empty; unset it to use the bundled addon");
	const path = override === undefined
		? join(dirname(fileURLToPath(import.meta.url)), "..", "pi_reedline.node")
		: resolve(override);
	const source = override === undefined ? "native addon" : "PI_HELIX_NATIVE";
	if (!existsSync(path)) throw new Error(`pi-helix: ${source} not found at ${path}`);
	try {
		cached = createRequire(import.meta.url)(path) as Native;
	} catch (cause) {
		throw new Error(`pi-helix: could not load ${source} at ${path}`, { cause });
	}
	return cached;
}

const engines = new Map<EditModeName, Engine>();

/**
 * The engine for `mode`, reset to its initial state.
 *
 * A native engine is never freed (dropping reedline would restore the
 * terminal under pi), so one is kept per mode and reused. Only one editor is
 * live at a time: pi replaces it on each session start.
 */
export function createEngine(mode: EditModeName): Engine {
	let engine = engines.get(mode);
	if (engine) {
		engine.reset();
	} else {
		engine = new (loadNative().Engine)(mode);
		engines.set(mode, engine);
	}
	return engine;
}
