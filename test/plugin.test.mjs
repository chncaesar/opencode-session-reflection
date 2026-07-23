import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import plugin from "../src/index.js"

const pluginSource = new URL("../src/index.js", import.meta.url)

test("session-reflection plugin exposes the expected tool contract", async () => {
  const source = await readFile(pluginSource, "utf8")

  assert.match(source, /session_reflection/)
  assert.match(source, /enum\(\["collect", "save"\]\)/)
  assert.match(source, /runID/)
  assert.match(source, /sessionName/)
  assert.match(source, /selectSessionsByName/)
  assert.match(source, /formatSessionCandidatesForConfirmation/)
  assert.match(source, /createRunId/)
  assert.match(source, /writeRunManifest/)
  assert.match(source, /appendRunEvent/)
  assert.match(source, /attachReportToRun/)
  assert.match(source, /reports/)
  assert.match(source, /listSessionsPaged/)
  assert.match(source, /client\.session\.get/)
  assert.match(source, /client\.session\.messages/)
  assert.match(source, /writeReport/)
})

function makeClient(sessions, messagesBySessionId) {
  return {
    _client: {
      async get({ url, query }) {
        if (url === "/session") {
          const search = query?.search?.toLowerCase()
          const all = search
            ? sessions.filter((s) => s.title?.toLowerCase().includes(search))
            : sessions
          const start = query?.start ?? 0
          const limit = query?.limit ?? all.length
          return { data: all.slice(start, start + limit) }
        }
        throw new Error(`Unexpected _client.get url: ${url}`)
      },
    },
    session: {
      async get({ path }) {
        const s = sessions.find((s) => s.id === path.id)
        if (!s) throw new Error(`session not found: ${path.id}`)
        return { data: s }
      },
      async messages({ path }) {
        return { data: messagesBySessionId[path.id] ?? [] }
      },
    },
  }
}

test("session_reflection asks for confirmation when sessionName matches multiple sessions", async () => {
  const sessions = [
    { id: "ses_1", title: "npm whoami ENEEDAUTH 排查", time_updated: 2 },
    { id: "ses_2", title: "npm whoami ENEEDAUTH 排查", time_updated: 1 },
  ]
  const messages = {
    ses_1: [{ info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: "message for ses_1" }] }],
    ses_2: [{ info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: "message for ses_2" }] }],
  }
  // Force fallback to API-based search so the mock sessions are used
  const hooks = await plugin({ client: makeClient(sessions, messages), _searchByName: async () => null })

  const result = await hooks.tool.session_reflection.execute(
    { action: "collect", sessionName: "npm whoami ENEEDAUTH 排查", limit: 8 },
    { agent: "test-agent" },
  )

  assert.equal(result.title, "Multiple sessions matched")
  assert.match(result.output, /sessionID: ses_1/)
  assert.match(result.output, /sessionID: ses_2/)
  assert.match(result.output, /- user: message for ses_1/)
  assert.doesNotMatch(result.output, /Run ID:/)
})

test("session_reflection fetches session directly by sessionID (bypasses list)", async () => {
  const sessions = [
    { id: "ses_old", title: "济琛游戏", time_updated: 1 },
  ]
  const messages = {
    ses_old: [{ info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: "old session content" }] }],
  }
  const hooks = await plugin({ client: makeClient(sessions, messages) })

  // Return an empty list from paging to confirm the direct get() path is used
  const emptyListClient = {
    ...makeClient(sessions, messages),
    _client: { async get() { return { data: [] } } },
  }
  const hooksEmpty = await plugin({ client: emptyListClient })
  // Should still find the session via session.get()
  const result = await hooksEmpty.tool.session_reflection.execute(
    { action: "collect", sessionID: "ses_old", limit: 8 },
    { agent: "test-agent" },
  )

  assert.ok(result.output?.includes("Run ID:"), "should produce a reflection prompt")
})

test("session_reflection pages through all sessions when list exceeds one page", async () => {
  // Build 5 sessions; mock _client returns them 2 at a time
  const sessions = Array.from({ length: 5 }, (_, i) => ({
    id: `ses_${i}`,
    title: `Session ${i}`,
    time_updated: i,
  }))
  const messages = Object.fromEntries(
    sessions.map((s) => [
      s.id,
      [{ info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: `content of ${s.id}` }] }],
    ]),
  )

  const PAGE = 2
  const client = {
    _client: {
      async get({ url, query }) {
        const start = query?.start ?? 0
        const limit = query?.limit ?? PAGE
        return { data: sessions.slice(start, start + limit) }
      },
    },
    session: {
      async get({ path }) {
        return { data: sessions.find((s) => s.id === path.id) }
      },
      async messages({ path }) {
        return { data: messages[path.id] ?? [] }
      },
    },
  }

  const hooks = await plugin({ client })
  const result = await hooks.tool.session_reflection.execute(
    { action: "collect", limit: 5 },
    { agent: "test-agent" },
  )

  assert.ok(result.output?.includes("Run ID:"), "should produce a reflection prompt")
  // All 5 sessions should be included in the prompt
  for (const s of sessions) {
    assert.match(result.output, new RegExp(s.id))
  }
})

test("session_reflection uses SQLite results when _searchByName returns sessions", async () => {
  const sqliteSessions = [
    { id: "ses_sqlite_1", title: "data-platform ETL fix", directory: "/work/code/data-platform", time_updated: 100 },
  ]
  const messages = {
    ses_sqlite_1: [
      { info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: "fix the ETL pipeline" }] },
    ],
  }
  // _client list returns nothing (different project), but SQLite mock returns a cross-project hit
  const client = {
    _client: { async get() { return { data: [] } } },
    session: {
      async get({ path }) {
        const s = sqliteSessions.find((s) => s.id === path.id)
        if (!s) throw new Error(`not found: ${path.id}`)
        return { data: s }
      },
      async messages({ path }) {
        return { data: messages[path.id] ?? [] }
      },
    },
  }

  const hooks = await plugin({ client, _searchByName: async () => sqliteSessions })
  const result = await hooks.tool.session_reflection.execute(
    { action: "collect", sessionName: "data-platform" },
    { agent: "test-agent" },
  )

  assert.ok(result.output?.includes("Run ID:"), "should produce a reflection prompt via SQLite path")
  assert.match(result.output, /ses_sqlite_1/)
})

test("session_reflection falls back to API search when _searchByName returns null", async () => {
  const sessions = [
    { id: "ses_api_1", title: "law-agent refactor", time_updated: 5 },
  ]
  const messages = {
    ses_api_1: [
      { info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: "refactor the law agent" }] },
    ],
  }
  const hooks = await plugin({ client: makeClient(sessions, messages), _searchByName: async () => null })
  const result = await hooks.tool.session_reflection.execute(
    { action: "collect", sessionName: "law-agent" },
    { agent: "test-agent" },
  )

  assert.ok(result.output?.includes("Run ID:"), "should produce a reflection prompt via API fallback")
  assert.match(result.output, /ses_api_1/)
})
