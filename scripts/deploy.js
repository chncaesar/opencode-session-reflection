#!/usr/bin/env node
// Deploy the plugin and slash command to the local OpenCode global config directory.
//
// What it does:
//   1. Copies src/index.js -> ~/.config/opencode/plugins/session-reflection.js
//      (entry-point; MUST be .js/.ts because OpenCode's local plugin auto-discovery
//       only scans *.ts / *.js — a .mjs entry would never be loaded).
//   2. Copies src/{core,logging}.js -> session-reflection-{core,logging}.mjs
//      (helper modules; kept as .mjs on purpose so they are NOT auto-discovered as
//       standalone plugins — the entry-point imports them by explicit path).
//   3. Copies commands/session-review.md  -> ~/.config/opencode/command/session-review.md
//   4. Removes stale legacy entry-points (.ts / .mjs) so the plugin is not registered twice.
//
// Usage:
//   npm run deploy
//
// After running, restart OpenCode to load the new plugin.

import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const DEFAULT_PLUGIN_DIR = join(homedir(), ".config", "opencode", "plugins")
const DEFAULT_COMMAND_DIR = join(homedir(), ".config", "opencode", "command")

// Deploy into the given directories. Exposed as a function so tests can run the
// real logic against a temporary directory instead of the user's config dir.
export async function deploy({
  root = ROOT,
  pluginDir = DEFAULT_PLUGIN_DIR,
  commandDir = DEFAULT_COMMAND_DIR,
  log = () => {},
} = {}) {
  await mkdir(pluginDir, { recursive: true })
  await mkdir(commandDir, { recursive: true })

  // Helper modules + command are copied verbatim. Helpers stay .mjs so they are
  // not auto-discovered as standalone plugins; their import paths don't reference
  // the entry-point, so no rewriting is needed.
  const plainCopies = [
    { src: join(root, "src", "core.js"),    dst: join(pluginDir, "session-reflection-core.mjs") },
    { src: join(root, "src", "logging.js"), dst: join(pluginDir, "session-reflection-logging.mjs") },
    { src: join(root, "commands", "session-review.md"), dst: join(commandDir, "session-review.md") },
  ]
  for (const { src, dst } of plainCopies) {
    await copyFile(src, dst)
    log(`  copied   ${src.replace(root + "/", "")}  ->  ${dst}`)
  }

  // Entry-point: deployed as .js so OpenCode's local auto-discovery (which only
  // scans *.ts/*.js) picks it up. Rewrite its import paths to the deployed names.
  const entrySrc = join(root, "src", "index.js")
  const entryDst = join(pluginDir, "session-reflection.js")
  const source = await readFile(entrySrc, "utf8")
  const deployed = source
    .replace(/from ["']\.\/core\.js["']/g,    "from \"./session-reflection-core.mjs\"")
    .replace(/from ["']\.\/logging\.js["']/g, "from \"./session-reflection-logging.mjs\"")
  await writeFile(entryDst, deployed, "utf8")
  log(`  patched  src/index.js  ->  ${entryDst}`)

  // Stale entry-points from earlier iterations — remove if present so the plugin
  // is not registered twice. The .mjs entry was never auto-discovered (OpenCode
  // only scans *.ts/*.js); the .ts entry failed to load under the Node runtime.
  const legacyEntries = [
    join(pluginDir, "session-reflection.ts"),
    join(pluginDir, "session-reflection.mjs"),
  ]
  for (const legacy of legacyEntries) {
    if (existsSync(legacy)) {
      await rm(legacy)
      log(`  removed  legacy entry  ${legacy}`)
    }
  }
}

async function main() {
  await deploy({ log: (message) => console.log(message) })
  console.log("")
  console.log("Deploy complete. Restart OpenCode to load the updated plugin.")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Deploy failed:", err.message)
    process.exit(1)
  })
}
