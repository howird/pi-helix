// Materialize the patched Cargo path dependency without touching Cargo's git cache.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const patches = join(root, "patches", "reedline");
const work = join(root, ".reedline");
const destination = join(work, "reedline");
const upstream = join(work, "upstream.git");
const upstreamUrl = "https://github.com/nushell/reedline";

function git(args, cwd = root, env = process.env) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.signal}`);
  }
  return result.stdout.trim();
}

let stage;
try {
  // Invalidate old output even if the current pin or patches cannot be prepared.
  rmSync(destination, { recursive: true, force: true });
  const revision = readFileSync(join(patches, "revision"), "utf8").trim();
  if (revision.length !== 40 || /[^0-9a-f]/.test(revision)) {
    throw new Error("patches/reedline/revision must contain a full lowercase Git commit SHA");
  }

  // Every *.patch in name order, as flake.nix applies them.
  const series = readdirSync(patches).filter((name) => name.endsWith(".patch")).sort();
  if (series.length === 0) throw new Error("no patches in patches/reedline");
  for (const name of series) {
    const info = statSync(join(patches, name), { throwIfNoEntry: false });
    if (!info?.isFile() || info.size === 0) {
      throw new Error(`missing or empty patch: patches/reedline/${name}`);
    }
  }

  mkdirSync(work, { recursive: true });
  git(["init", "--quiet", "--bare", "--object-format=sha1", "--template=", upstream]);
  const repo = ["--no-replace-objects", `--git-dir=${upstream}`];
  const ref = `refs/pi-helix/${revision}`;
  if (!git([...repo, "for-each-ref", "--format=%(objectname)", ref])) {
    git([...repo, "fetch", "--quiet", "--depth=1", "--no-tags", upstreamUrl, `${revision}:${ref}`]);
  }
  if (git([...repo, "rev-parse", "--verify", `${ref}^{commit}`]) !== revision) {
    throw new Error(`Reedline revision mismatch (expected ${revision})`);
  }

  // Use a private index and fresh work tree so local edits and previously applied
  // patches cannot become build inputs. Only publish after the full series applies.
  stage = mkdtempSync(join(work, "prepare-"));
  const source = join(stage, "source");
  mkdirSync(source);
  const tree = [...repo, `--work-tree=${source}`, "-c", "core.autocrlf=false"];
  const env = { ...process.env, GIT_INDEX_FILE: join(stage, "index") };
  git([...tree, "read-tree", revision], source, env);
  git([...tree, "checkout-index", "--all", "--index"], source, env);
  for (const name of series) {
    git([
      ...tree, "-c", "apply.ignoreWhitespace=false", "apply", "--index", "--whitespace=nowarn",
      join(patches, name),
    ], source, env);
  }
  renameSync(source, destination);
  console.log(`Prepared Reedline ${revision} at .reedline/reedline`);
} catch (error) {
  console.error(`pi-helix: could not prepare Reedline: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (stage) rmSync(stage, { recursive: true, force: true });
}
