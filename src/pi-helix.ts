/**
 * pi-helix: replace pi's input editor with reedline (helix by default).
 *
 * PI_HELIX_MODE = helix | vi
 * PI_HELIX_CURSOR_BLINK = 1 (default) | 0
 */
import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HelixEditor } from "./editor.ts";
import type { EditModeName, Mode } from "./native.ts";
import { loadNative } from "./native.ts";

function editMode(): EditModeName {
	return (process.env.PI_HELIX_MODE ?? "").toLowerCase() === "vi" ? "vi" : "helix";
}

const BADGE_COLOR: Record<Mode, "accent" | "success" | "warning"> = {
	normal: "accent",
	insert: "success",
	select: "warning",
};

export default function (pi: ExtensionAPI) {
	// Leave the shell with its own cursor shape, not our bar/block.
	process.once("exit", () => {
		try {
			process.stdout.write("\x1b[0 q");
		} catch {}
	});

	pi.on("session_start", (_event, c) => {
		if (!c.hasUI) return;
		try {
			loadNative();
		} catch (error) {
			c.ui.notify(String(error instanceof Error ? error.message : error), "error");
			return;
		}
		const mode = editMode();
		c.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new HelixEditor(tui, theme, keybindings, mode, {
					copy: (text) => void copyToClipboard(text).catch(() => {}),
					selectionStyle: (s) => c.ui.theme.bg("selectedBg", s),
					badgeStyle: (m, s) => c.ui.theme.bold(c.ui.theme.fg(BADGE_COLOR[m], s)),
				}),
		);
	});
}
