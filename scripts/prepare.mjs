#!/usr/bin/env node
/**
 * `prepare` runs in two situations that need opposite behavior:
 *
 *   1. A development checkout — devDependencies are present, so rebuild the
 *      bundle from source. A stale dist/ then shows up as a git diff, which is
 *      exactly the signal we want.
 *
 *   2. `npm install -g git+ssh://…/bitagent-cli.git` (and `npx <git-url>`) —
 *      npm does NOT install devDependencies for these, not even with
 *      `--include=dev`, so esbuild is absent. Building here is impossible; the
 *      bundle committed at dist/bin/bitagent.js is what gets installed.
 *
 * Exiting non-zero in case 2 is precisely what breaks installing from GitHub,
 * so the only fatal case is: no esbuild *and* no prebuilt bundle.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = resolve(root, "dist", "bin", "bitagent.js");
const require = createRequire(import.meta.url);

const hasEsbuild = (() => {
  try {
    require.resolve("esbuild");
    return true;
  } catch {
    return false;
  }
})();

if (hasEsbuild) {
  const built = spawnSync("npm", ["run", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exit(built.status ?? 1);
}

if (existsSync(bundle)) {
  console.log("prepare: no esbuild (git install) — using the committed bundle at dist/bin/bitagent.js");
  process.exit(0);
}

console.error("prepare: esbuild is not installed and there is no prebuilt bundle at dist/bin/bitagent.js.");
console.error("Clone the repo and run `npm install` to build it.");
process.exit(1);
