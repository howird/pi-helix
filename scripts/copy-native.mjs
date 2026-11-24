// Copy the built pi-reedline library to pi_reedline.node at the package root.
import { copyFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const names = { linux: "libpi_reedline.so", darwin: "libpi_reedline.dylib", win32: "pi_reedline.dll" };
const name = names[process.platform];
if (!name) throw new Error(`pi-helix: no native library name known for ${process.platform}`);

// Write beside the target and rename, so a running pi never loads a partial file.
const tmp = join(root, "pi_reedline.node.tmp");
copyFileSync(join(root, "target", "release", name), tmp);
renameSync(tmp, join(root, "pi_reedline.node"));
