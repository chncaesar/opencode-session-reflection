import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import pluginModule from "../src/index.js"
import { resolveLogDir } from "../src/logging.js"

const plugin = pluginModule.server

const pluginSource = new URL("../src/index.js", import.meta.url)

test("session-reflection plugin exposes the expected tool contract", async () => {
  const source = await readFile(pluginSource, "utf8")

  assert.match(source, /session_reflection/)
  assert.match(source, /enum\(\["collect", "save", "analyze_prompts"\]\)/)
  assert.match(source, /id: "opencode-session-reflection"/)
  assert.match(source, /server: plugin/)
  assert.match(source, /runID/)
  assert.match(source, /sessionName/)
  assert.match(source, /period/)
  assert.match(source, /since/)
  assert.match(source, /selectSessionsByName/)
  assert.match(source, /formatSessionCandidatesForConfirmation/)
  assert.match(source, /createRunId/)
  assert.match(source, /writeRunManifest/)
  assert.match(source, /appendRunEvent/)
  assert.match(source, /saveReportForRun/)
  assert.match(source, /listSessionsPaged/)
  assert.match(source, /client\.session\.get/)
  assert.match(source, /client\.session\.messages/)
})

function makeClient(sessions, messagesBySessionId, { pageSize = sessions.length || 1 } = {}) {
  return {
    _client: {
      async get({ url, query, headers }) {
        if (url === "/experimental/session") {
          const search = query?.search?.toLowerCase()
          const all = search
            ? sessions.filter((s) => s.title?.toLowerCase().includes(search))
            : sessions
          const start = query?.cursor ? Number(query.cursor) : 0
          const data = all.slice(start, start + pageSize)
          const nextCursor = start + pageSize < all.length ? String(start + pageSize) : undefined
          return {
            data,
            response: { headers: new Headers(nextCursor ? { "x-next-cursor": nextCursor } : {}) },
          }
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
  const hooks = await plugin({ client: makeClient(sessions, messages) })

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
    { agent: "test-agent", sessionID: "ses_old" },
  )

  assert.ok(result.output?.includes("Run ID:"), "should produce a reflection prompt")
})

test("session_reflection pages through experimental sessions with cursor deduplication", async () => {
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

  const client = makeClient([sessions[0], sessions[1], sessions[1], ...sessions.slice(2)], messages, { pageSize: 2 })

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

test("session_reflection sends sessionName as endpoint search", async () => {
  const searchedSessions = [
    { id: "ses_search_1", title: "data-platform ETL fix", directory: "/work/code/data-platform", time_updated: 100 },
  ]
  const messages = {
    ses_search_1: [
      { info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: "fix the ETL pipeline" }] },
    ],
  }
  const client = makeClient(searchedSessions, messages)

  const hooks = await plugin({ client })
  const result = await hooks.tool.session_reflection.execute(
    { action: "collect", sessionName: "data-platform" },
    { agent: "test-agent" },
  )

  assert.ok(result.output?.includes("Run ID:"), "should produce a reflection prompt via search endpoint")
  assert.match(result.output, /ses_search_1/)
})

test("session_reflection excludes the current session from implicit selection", async () => {
  const sessions = [
    { id: "current", title: "law-agent refactor", time_updated: 6 },
    { id: "previous", title: "law-agent refactor", time_updated: 5 },
  ]
  const messages = {
    current: [{ info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: "current" }] }],
    previous: [
      { info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: "refactor the law agent" }] },
    ],
  }
  const hooks = await plugin({ client: makeClient(sessions, messages) })
  const result = await hooks.tool.session_reflection.execute(
    { action: "collect", limit: 2 },
    { agent: "test-agent", sessionID: "current" },
  )

  assert.match(result.output, /session_id: previous/)
  assert.doesNotMatch(result.output, /session_id: current/)
})

test("session_reflection excludes the current session from implicit name search", async () => {
  const sessions = [
    { id: "current", title: "shared title", time: { updated: 2 } },
    { id: "previous", title: "shared title", time: { updated: 1 } },
  ]
  const messages = {
    previous: [{ info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "previous" }] }],
  }
  const hooks = await plugin({ client: makeClient(sessions, messages) })
  const result = await hooks.tool.session_reflection.execute(
    { action: "collect", sessionName: "shared title", limit: 2 },
    { agent: "test-agent", sessionID: "current" },
  )

  assert.match(result.output, /session_id: previous/)
  assert.doesNotMatch(result.output, /session_id: current/)
})

test("session_reflection rejects repeated pagination cursors", async () => {
  const client = makeClient([], {})
  client._client.get = async () => ({
    data: [{ id: "one", time: { updated: 1 } }],
    response: { headers: new Headers({ "x-next-cursor": "repeat" }) },
  })
  const hooks = await plugin({ client })

  await assert.rejects(
    hooks.tool.session_reflection.execute({ action: "collect", limit: 1 }, { agent: "test-agent" }),
    /repeated cursor/,
  )
})

test("session_reflection save requires a validated run and uses manifest metadata", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "session-reflection-plugin-"))
  const client = makeClient(
    [{ id: "source", title: "source", time: { updated: 1 } }],
    { source: [{ info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "source" }] }] },
  )
  const hooks = await plugin({ client, _logDir: logDir })

  const missingRunResult = await hooks.tool.session_reflection.execute(
    { action: "save", analysis: "analysis" },
    { agent: "review-agent" },
  )
  assert.match(missingRunResult, /runID is required/)
  await assert.rejects(access(join(logDir, "reports")))

  const collected = await hooks.tool.session_reflection.execute(
    { action: "collect", limit: 1 },
    { agent: "review-agent", sessionID: "current" },
  )
  const runID = collected.metadata.runID
  const saved = await hooks.tool.session_reflection.execute(
    { action: "save", runID, analysis: "final analysis" },
    { agent: "review-agent" },
  )
  const reportPath = saved.output.replace("Saved reflection report: ", "")
  const report = await readFile(reportPath, "utf8")
  const sidecar = JSON.parse(await readFile(reportPath.replace(/\.md$/, ".json"), "utf8"))

  assert.match(report, new RegExp(`Run ID: ${runID}`))
  assert.match(report, /Reviewed sessions: 1/)
  assert.match(report, /Agent: review-agent/)
  assert.equal(sidecar.runId, runID)
  assert.equal(sidecar.reviewedSessionCount, 1)
  assert.match(sidecar.manifestHash, /^sha256:/)
  assert.equal((await stat(join(logDir, "reports"))).mode & 0o777, 0o700)
  assert.equal((await stat(reportPath)).mode & 0o777, 0o600)
})

test("session_reflection returns save success with a stable warning when event append fails", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "session-reflection-plugin-event-warning-"))
  const client = makeClient(
    [{ id: "source", title: "source", time: { updated: 1 } }],
    { source: [{ info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "source" }] }] },
  )
  const hooks = await plugin({ client, _logDir: logDir })
  const collected = await hooks.tool.session_reflection.execute(
    { action: "collect", limit: 1 },
    { agent: "review-agent" },
  )
  const eventsPath = join(logDir, "events.jsonl")
  await rm(eventsPath)
  await mkdir(eventsPath)

  const saved = await hooks.tool.session_reflection.execute(
    { action: "save", runID: collected.metadata.runID, analysis: "final analysis" },
    { agent: "review-agent" },
  )
  const reports = await readdir(join(logDir, "reports"))

  assert.equal(saved.title, "Session reflection saved")
  assert.match(saved.output, /^Saved reflection report: .*\.md\nWarning: The report was saved, but its audit event could not be recorded\.$/)
  assert.doesNotMatch(saved.output, /EISDIR|stack|events\.jsonl/)
  assert.equal(saved.metadata.auditWarning, "The report was saved, but its audit event could not be recorded.")
  assert.equal(reports.filter((name) => name.endsWith(".md")).length, 1)
  assert.equal(reports.filter((name) => name.endsWith(".json")).length, 1)
})

test("session_reflection rejects a traversal runID before creating the reports directory", async () => {
  const logDir = await mkdtemp(join(tmpdir(), "session-reflection-plugin-traversal-"))
  const hooks = await plugin({ client: makeClient([], {}), _logDir: logDir })

  await assert.rejects(
    hooks.tool.session_reflection.execute(
      { action: "save", runID: "../outside", analysis: "must not be written" },
      { agent: "review-agent" },
    ),
    /Invalid run ID/,
  )
  await assert.rejects(access(join(logDir, "reports")), { code: "ENOENT" })
})

test("session_reflection stores audit files under XDG_CONFIG_HOME", async () => {
  const xdgRoot = await mkdtemp(join(tmpdir(), "session-reflection-xdg-"))
  const previousXdgRoot = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = xdgRoot

  try {
    const client = makeClient(
      [{ id: "source", title: "source", time: { updated: 1 } }],
      { source: [{ info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "source" }] }] },
    )
    const hooks = await plugin({ client })
    const collected = await hooks.tool.session_reflection.execute(
      { action: "collect", limit: 1 },
      { agent: "review-agent" },
    )

    await access(join(xdgRoot, "opencode", "session-reflections", "runs", `${collected.metadata.runID}.json`))
  } finally {
    if (previousXdgRoot === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgRoot
  }
})

test("session_reflection ignores empty and relative XDG_CONFIG_HOME values", async () => {
  const previousXdgRoot = process.env.XDG_CONFIG_HOME

  try {
    for (const invalidXdgRoot of ["", "relative-config"]) {
      process.env.XDG_CONFIG_HOME = invalidXdgRoot
      assert.equal(
        resolveLogDir(),
        join(homedir(), ".config", "opencode", "session-reflections"),
      )
    }
  } finally {
    if (previousXdgRoot === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdgRoot
  }
})

test("session_reflection honors an explicit evidenceBudget argument", async () => {
  const sessions = Array.from({ length: 2 }, (_, i) => ({
    id: `ses_budget_${i}`,
    title: `Budget ${i}`,
    time: { updated: i },
  }))
  const messages = Object.fromEntries(
    sessions.map((s) => [
      s.id,
      [{ info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: `${s.id} ${"x".repeat(2000)}` }] }],
    ]),
  )
  const hooks = await plugin({ client: makeClient(sessions, messages) })

  const result = await hooks.tool.session_reflection.execute(
    { action: "collect", limit: 2, evidenceBudget: 3_000 },
    { agent: "test-agent" },
  )

  assert.ok(result.output?.includes("Run ID:"), "should produce a reflection prompt")
  const evidence = result.output.split("Session evidence:\n\n")[1]
  assert.ok(evidence.length <= 3_000, `evidence was ${evidence.length} characters`)
})

test("session_reflection reads evidence budget from SESSION_REFLECTION_EVIDENCE_BUDGET", async () => {
  const previousBudget = process.env.SESSION_REFLECTION_EVIDENCE_BUDGET
  process.env.SESSION_REFLECTION_EVIDENCE_BUDGET = "2500"

  try {
    const sessions = Array.from({ length: 2 }, (_, i) => ({
      id: `ses_env_budget_${i}`,
      title: `Env Budget ${i}`,
      time: { updated: i },
    }))
    const messages = Object.fromEntries(
      sessions.map((s) => [
        s.id,
        [{ info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: `${s.id} ${"x".repeat(2000)}` }] }],
      ]),
    )
    const hooks = await plugin({ client: makeClient(sessions, messages) })

    const result = await hooks.tool.session_reflection.execute(
      { action: "collect", limit: 2 },
      { agent: "test-agent" },
    )

    assert.ok(result.output?.includes("Run ID:"), "should produce a reflection prompt")
    const evidence = result.output.split("Session evidence:\n\n")[1]
    assert.ok(evidence.length <= 2500, `evidence was ${evidence.length} characters`)
  } finally {
    if (previousBudget === undefined) delete process.env.SESSION_REFLECTION_EVIDENCE_BUDGET
    else process.env.SESSION_REFLECTION_EVIDENCE_BUDGET = previousBudget
  }
})

test("session_reflection filters implicit selection by period", async () => {
  const sessions = [
    { id: "recent", title: "recent", time_updated: Date.now() },
    { id: "old", title: "old", time_updated: 1 },
  ]
  const messages = {
    recent: [{ info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: "recent content" }] }],
    old: [{ info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: "old content" }] }],
  }
  const hooks = await plugin({ client: makeClient(sessions, messages) })

  const result = await hooks.tool.session_reflection.execute(
    { action: "collect", limit: 8, period: "today" },
    { agent: "test-agent" },
  )

  assert.ok(result.output?.includes("Run ID:"), "should produce a reflection prompt")
  assert.match(result.output, /session_id: recent/)
  assert.doesNotMatch(result.output, /session_id: old/)
})

test("session_reflection filters implicit selection by since date", async () => {
  const sessions = [
    { id: "recent", title: "recent", time_updated: Date.now() },
    { id: "old", title: "old", time_updated: new Date("2019-01-01T00:00:00Z").getTime() },
  ]
  const messages = {
    recent: [{ info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: "recent content" }] }],
    old: [{ info: { role: "user", time_created: 1 }, parts: [{ type: "text", text: "old content" }] }],
  }
  const hooks = await plugin({ client: makeClient(sessions, messages) })

  const result = await hooks.tool.session_reflection.execute(
    { action: "collect", limit: 8, since: "2020-01-01" },
    { agent: "test-agent" },
  )

  assert.ok(result.output?.includes("Run ID:"), "should produce a reflection prompt")
  assert.match(result.output, /session_id: recent/)
  assert.doesNotMatch(result.output, /session_id: old/)
})

test("session_reflection rejects period and since together", async () => {
  const hooks = await plugin({ client: makeClient([], {}) })

  const result = await hooks.tool.session_reflection.execute(
    { action: "collect", period: "today", since: "2020-01-01" },
    { agent: "test-agent" },
  )

  assert.equal(result, "period and since are mutually exclusive. Choose one time filter.")
})

test("session_reflection rejects an invalid since value", async () => {
  const hooks = await plugin({ client: makeClient([], {}) })

  const result = await hooks.tool.session_reflection.execute(
    { action: "collect", since: "not-a-date" },
    { agent: "test-agent" },
  )

  assert.equal(result, "Invalid since value: not-a-date")
})

test("list endpoint errors are stable and do not expose response internals", async () => {
  const client = makeClient([], {})
  client._client.get = async () => ({
    error: { message: "database password=secret", stack: "private stack" },
  })
  const hooks = await plugin({ client })

  await assert.rejects(
    hooks.tool.session_reflection.execute({ action: "collect", limit: 1 }, { agent: "test-agent" }),
    (error) => {
      assert.equal(error.message, "Could not load OpenCode sessions. Please try again.")
      assert.doesNotMatch(error.message, /password|secret|stack/)
      return true
    },
  )
})

test("malformed list responses use the same stable endpoint error", async () => {
  const client = makeClient([], {})
  client._client.get = async () => ({ data: { unexpected: true } })
  const hooks = await plugin({ client })

  await assert.rejects(
    hooks.tool.session_reflection.execute({ action: "collect", limit: 1 }, { agent: "test-agent" }),
    { message: "Could not load OpenCode sessions. Please try again." },
  )
})
