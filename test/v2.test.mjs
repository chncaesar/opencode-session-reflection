import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import pluginModule from "../src/index.js"

test("default export has id, server and setup", () => {
  assert.equal(pluginModule.id, "opencode-session-reflection")
  assert.equal(typeof pluginModule.server, "function")
  assert.equal(typeof pluginModule.setup, "function")
})

function makeCtx() {
  const calls = { hooks: [], disposed: [], tools: [] }
  const sessions = [
    { id: "ses_1", title: "One", location: { directory: "/p" }, time: { created: 1, updated: 2 } },
    { id: "ses_2", title: "Two", location: { directory: "/p" }, time: { created: 3, updated: 4 } },
  ]
  const entries = {
    ses_1: [
      { id: "m1", type: "user", text: "please fix the bug", time: { created: 1 } },
      { id: "m2", type: "assistant", time: { created: 2 }, content: [
        { type: "text", text: "Fixed it." },
        { type: "tool", name: "edit", state: { status: "completed" } },
      ] },
    ],
  }
  const registration = (label) => ({ dispose: async () => { calls.disposed.push(label) } })
  const ctx = {
    location: { directory: "/p" },
    options: {},
    session: {
      hook: async (name, cb) => { calls.hooks.push({ name, cb }); return registration(`hook:${name}`) },
      list: async ({ cursor, limit }) => {
        const start = cursor ? Number(cursor) : 0
        const data = sessions.slice(start, start + 1)
        return { data, cursor: start + 1 < sessions.length ? { next: String(start + 1) } : {} }
      },
      get: async ({ sessionID }) => {
        const s = sessions.find((x) => x.id === sessionID)
        if (!s) throw new Error("not found")
        return s
      },
      context: async ({ sessionID }) => entries[sessionID] ?? [],
    },
    tool: {
      transform: async (cb) => {
        cb({ add: (def) => calls.tools.push(def) })
        return registration("tool")
      },
    },
  }
  return { ctx, calls }
}

test("setup registers the context hook and tool, and cleanup disposes both", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sr-v2-"))
  const prev = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = dir
  try {
    const { ctx, calls } = makeCtx()
    const cleanup = await pluginModule.setup(ctx)
    assert.equal(typeof cleanup, "function")
    assert.deepEqual(calls.hooks.map((h) => h.name), ["context"])
    assert.equal(calls.tools.length, 1)
    assert.equal(calls.tools[0].name, "session_reflection")
    assert.equal(calls.tools[0].input.type, "object")
    assert.equal(typeof calls.tools[0].execute, "function")

    // context hook records the system prompt without throwing
    await calls.hooks[0].cb({ sessionID: "ses_x", model: { id: "m", providerID: "p" }, system: [{ type: "text", text: "hello" }] })

    // collect: pages through list (2 pages), fetches context messages
    const result = await calls.tools[0].execute({}, { sessionID: "ses_cur", agent: "build" })
    assert.match(result.content, /Run ID:/)
    assert.match(result.content, /please fix the bug/)
    assert.deepEqual(result.metadata.sessionIDs, ["ses_1"])

    // analyze_prompts sees the captured system prompt
    const analysis = await calls.tools[0].execute({ action: "analyze_prompts", sessionID: "ses_x" }, { sessionID: "ses_cur", agent: "build" })
    assert.doesNotMatch(analysis.content, /No prompt dump data/)

    // missing session by id
    const missing = await calls.tools[0].execute({ sessionID: "nope" }, { sessionID: "ses_cur", agent: "build" })
    assert.equal(missing.content, "No session found: nope")

    await cleanup()
    assert.deepEqual(calls.disposed.sort(), ["hook:context", "tool"])
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
    await rm(dir, { recursive: true, force: true })
  }
})
