#!/usr/bin/env node
/**
 * Bundles the CLI into one self-contained, dependency-free file.
 *
 * Everything is bundled, including @bitagent/sdk, for a specific reason:
 * `npm install -g github:unibaseio/bitagent-cli` installs no devDependencies and
 * runs transitive lifecycle scripts. @bitagent/sdk pulls in aws-sdk v2, whose
 * `postinstall` npm tries to run in a directory that does not exist in the global
 * install layout — which fails the entire install and leaves dangling bin links.
 * With zero runtime dependencies there is nothing for npm to install and nothing
 * to break. (esbuild tree-shakes aws-sdk out entirely; the CLI never reaches it.)
 *
 * Two build-time fixups make that bundle actually runnable:
 *
 *   - a `createRequire` banner, because CJS dependencies (dotenv) call
 *     `require("fs")`, which an ESM bundle cannot otherwise resolve;
 *   - the version is injected, because the bundle has no package.json beside it.
 */

import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const outfile = resolve(root, "dist", "bin", "bitagent.js");

rmSync(resolve(root, "dist"), { recursive: true, force: true });

const result = await build({
  entryPoints: [resolve(root, "bin", "bitagent.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: {
    js: "import{createRequire as __nodeCreateRequire}from'node:module';const require=__nodeCreateRequire(import.meta.url);",
  },
  define: {
    __BITAGENT_CLI_VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: "info",
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`bundled ${pkg.name}@${pkg.version} → dist/bin/bitagent.js (${(bytes / 1024 / 1024).toFixed(1)} MB, no runtime deps)`);
