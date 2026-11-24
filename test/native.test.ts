import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const loader = new URL("../src/native.ts", import.meta.url).href;
const bundled = fileURLToPath(new URL("../pi_reedline.node", import.meta.url));

function loadFrom(cwd: string, override: string) {
	return Bun.spawnSync([process.execPath, "-e", `
		import { loadNative } from ${JSON.stringify(loader)};
		const engine = new (loadNative().Engine)("helix");
		console.log(engine.state().mode);
	`], { cwd, env: { ...process.env, PI_HELIX_NATIVE: override }, stdout: "pipe", stderr: "pipe" });
}

test("a relative native override resolves from the launch directory", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-helix-native-"));
	try {
		copyFileSync(bundled, join(cwd, "local.node"));
		const result = loadFrom(cwd, "./local.node");
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe("insert");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("a missing or unloadable explicit native override does not fall back", () => {
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-helix-native-")));
	try {
		const missing = loadFrom(cwd, "./missing.node");
		expect(missing.exitCode).not.toBe(0);
		expect(missing.stderr.toString()).toContain(`PI_HELIX_NATIVE not found at ${join(cwd, "missing.node")}`);
		writeFileSync(join(cwd, "bad.node"), "not an addon");
		const malformed = loadFrom(cwd, "./bad.node");
		expect(malformed.exitCode).not.toBe(0);
		expect(malformed.stderr.toString()).toContain(`could not load PI_HELIX_NATIVE at ${join(cwd, "bad.node")}`);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
