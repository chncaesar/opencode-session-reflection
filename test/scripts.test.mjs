// Tests for scripts/deploy.js and scripts/undeploy.js
// These tests invoke the real script functions against a temporary directory
// (not the user's config dir), so they exercise the actual deploy/undeploy logic
// rather than a duplicated copy.

import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { deploy } from "../scripts/deploy.js"
import { undeploy } from "../scripts/undeploy.js"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("deploy rewrites import paths in the entry-point", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "session-reflection-deploy-"))
  const pluginDir = join(tmp, "plugins")
  const commandDir = join(tmp, "command")
  const workspaceRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "")

  await deploy({ root: workspaceRoot, pluginDir, commandDir })

  const entry = await readFile(join(pluginDir, "session-reflection.js"), "utf8")

  assert.doesNotMatch(entry, /from ["']\.\/core\.js["']/, "should not contain ./core.js")
  assert.doesNotMatch(entry, /from ["']\.\/logging\.js["']/, "should not contain ./logging.js")
  assert.match(entry, /from "\.\/session-reflection-core\.mjs"/, "should import core via deployed name")
  assert.match(entry, /from "\.\/session-reflection-logging\.mjs"/, "should import logging via deployed name")
})

test("deploy copies core, logging and command files verbatim", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "session-reflection-deploy-"))
  const pluginDir = join(tmp, "plugins")
  const commandDir = join(tmp, "command")
  const workspaceRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "")

  await deploy({ root: workspaceRoot, pluginDir, commandDir })

  assert.ok(existsSync(join(pluginDir, "session-reflection-core.mjs")), "core file deployed")
  assert.ok(existsSync(join(pluginDir, "session-reflection-logging.mjs")), "logging file deployed")
  assert.ok(existsSync(join(commandDir, "session-review.md")), "command file deployed")
})

test("deploy writes entry as .js (not .mjs) so OpenCode auto-discovery picks it up", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "session-reflection-deploy-"))
  const pluginDir = join(tmp, "plugins")
  const commandDir = join(tmp, "command")
  const workspaceRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "")

  await deploy({ root: workspaceRoot, pluginDir, commandDir })

  const entryJs = join(pluginDir, "session-reflection.js")
  const entryMjs = join(pluginDir, "session-reflection.mjs")
  assert.ok(existsSync(entryJs), "entry exists as .js")
  assert.ok(!existsSync(entryMjs), "stale .mjs entry must be removed")
  const entry = await readFile(entryJs, "utf8")
  assert.match(entry, /from "\.\/session-reflection-core\.mjs"/)
})

test("deploy is idempotent when run twice", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "session-reflection-deploy-"))
  const pluginDir = join(tmp, "plugins")
  const commandDir = join(tmp, "command")
  const workspaceRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "")

  await deploy({ root: workspaceRoot, pluginDir, commandDir })
  await deploy({ root: workspaceRoot, pluginDir, commandDir })

  const entry = await readFile(join(pluginDir, "session-reflection.js"), "utf8")
  assert.match(entry, /from "\.\/session-reflection-core\.mjs"/)
})

test("undeploy removes all deployed files (current + legacy names)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "session-reflection-deploy-"))
  const pluginDir = join(tmp, "plugins")
  const commandDir = join(tmp, "command")
  const workspaceRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "")

  await deploy({ root: workspaceRoot, pluginDir, commandDir })
  await undeploy({ pluginDir, commandDir })

  assert.ok(!existsSync(join(pluginDir, "session-reflection.js")), "entry .js removed")
  assert.ok(!existsSync(join(pluginDir, "session-reflection.mjs")), "legacy .mjs removed")
  assert.ok(!existsSync(join(pluginDir, "session-reflection-core.mjs")), "core removed")
  assert.ok(!existsSync(join(pluginDir, "session-reflection-logging.mjs")), "logging removed")
  assert.ok(!existsSync(join(commandDir, "session-review.md")), "command removed")
})

test("undeploy is safe when files are already absent", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "session-reflection-deploy-"))
  const pluginDir = join(tmp, "plugins")
  const commandDir = join(tmp, "command")

  await assert.doesNotReject(() => undeploy({ pluginDir, commandDir }))
})
