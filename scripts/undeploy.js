#!/usr/bin/env node
// Remove the deployed plugin and slash command from the local OpenCode global config directory.
//
// Usage:
//   npm run undeploy
//
// After running, restart OpenCode to unload the plugin.

import { rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_PLUGIN_DIR = join(homedir(), ".config", "opencode", "plugins")
const DEFAULT_COMMAND_DIR = join(homedir(), ".config", "opencode", "command")

// Remove deployed files from the given directories. Exposed as a function so tests
// can run the real logic against a temporary directory. Legacy entry names (.mjs /
// .ts) are included so upgrades from earlier layouts are cleaned up too.
export async function undeploy({
  pluginDir = DEFAULT_PLUGIN_DIR,
  commandDir = DEFAULT_COMMAND_DIR,
  log = () => {},
} = {}) {
  const files = [
    join(pluginDir, "session-reflection.js"),
    join(pluginDir, "session-reflection.mjs"), // legacy entry name
    join(pluginDir, "session-reflection.ts"),  // legacy prototype entry
    join(pluginDir, "session-reflection-core.mjs"),
    join(pluginDir, "session-reflection-logging.mjs"),
    join(commandDir, "session-review.md"),
  ]
  for (const file of files) {
    if (existsSync(file)) {
      await rm(file)
      log(`  removed  ${file}`)
    } else {
      log(`  skip (not found)  ${file}`)
    }
  }
}

async function main() {
  await undeploy({ log: (message) => console.log(message) })
  console.log("")
  console.log("Undeploy complete. Restart OpenCode to unload the plugin.")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Undeploy failed:", err.message)
    process.exit(1)
  })
}
