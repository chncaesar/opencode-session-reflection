// Tests for prompt dump analysis functions:
//   readPromptDumps, readSessionTokenStats, buildPromptAnalysis
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"

import {
  buildPromptAnalysis,
  readPromptDumps,
  readSessionTokenStats,
} from "../src/core.js"

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReflectionDb() {
  const db = new DatabaseSync(":memory:")
  db.exec(`
    CREATE TABLE prompt_dump (
      session_id         TEXT    NOT NULL,
      seq                INTEGER NOT NULL,
      created_at         INTEGER NOT NULL,
      model              TEXT    NOT NULL,
      system_total_chars INTEGER NOT NULL,
      system_full        TEXT    NOT NULL,
      PRIMARY KEY (session_id, seq)
    )
  `)
  return db
}

function insertDump(db, { sessionId, seq, model, systemFull, createdAt = Date.now() }) {
  db.prepare(
    "INSERT INTO prompt_dump (session_id, seq, created_at, model, system_total_chars, system_full) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    sessionId,
    seq,
    createdAt,
    model,
    systemFull.join("").length,
    JSON.stringify(systemFull),
  )
}

function makeOpenCodeDb() {
  const db = new DatabaseSync(":memory:")
  db.exec(`
    CREATE TABLE message (
      id         TEXT NOT NULL,
      session_id TEXT NOT NULL,
      data       TEXT NOT NULL
    );
    CREATE TABLE part (
      id         TEXT NOT NULL,
      message_id TEXT NOT NULL,
      data       TEXT NOT NULL
    )
  `)
  return db
}

function insertMessage(db, { id, sessionId, role = "assistant", tokens = {} }) {
  const data = JSON.stringify({ role, tokens })
  db.prepare("INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)").run(id, sessionId, data)
}

function insertPart(db, { id, messageId, type = "tool", tool = "bash", status = "completed", output = null }) {
  const state = output !== null ? { status, output } : { status }
  const data = JSON.stringify({ type, tool, state })
  db.prepare("INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)").run(id, messageId, data)
}

const EMPTY_TOKEN_STATS = {
  total_input: 0,
  total_output: 0,
  cache_read: 0,
  cache_write: 0,
  top_tool_outputs: [],
}

// ─── readPromptDumps ─────────────────────────────────────────────────────────

test("readPromptDumps returns [] when session has no dumps", () => {
  const db = makeReflectionDb()
  const result = readPromptDumps(db, "ses_missing")
  assert.deepEqual(result, [])
})

test("readPromptDumps latest mode returns the highest-seq row", () => {
  const db = makeReflectionDb()
  insertDump(db, { sessionId: "ses_1", seq: 1, model: "m1", systemFull: ["hello"] })
  insertDump(db, { sessionId: "ses_1", seq: 2, model: "m2", systemFull: ["hello", " world"] })

  const result = readPromptDumps(db, "ses_1", "latest")
  assert.equal(result.length, 1)
  assert.equal(result[0].seq, 2)
  assert.equal(result[0].model, "m2")
  assert.deepEqual(result[0].system_full, ["hello", " world"])
})

test("readPromptDumps latest mode parses system_full from JSON string", () => {
  const db = makeReflectionDb()
  insertDump(db, { sessionId: "ses_2", seq: 1, model: "m", systemFull: ["seg1", "seg2"] })

  const [row] = readPromptDumps(db, "ses_2", "latest")
  assert.ok(Array.isArray(row.system_full))
  assert.deepEqual(row.system_full, ["seg1", "seg2"])
})

test("readPromptDumps trend mode returns all rows in ascending seq order", () => {
  const db = makeReflectionDb()
  insertDump(db, { sessionId: "ses_3", seq: 3, model: "m3", systemFull: ["c"] })
  insertDump(db, { sessionId: "ses_3", seq: 1, model: "m1", systemFull: ["a"] })
  insertDump(db, { sessionId: "ses_3", seq: 2, model: "m2", systemFull: ["b"] })

  const result = readPromptDumps(db, "ses_3", "trend")
  assert.equal(result.length, 3)
  assert.deepEqual(result.map((r) => r.seq), [1, 2, 3])
})

test("readPromptDumps trend mode returns [] when session has no dumps", () => {
  const db = makeReflectionDb()
  const result = readPromptDumps(db, "ses_empty", "trend")
  assert.deepEqual(result, [])
})

test("readPromptDumps only returns rows for the requested session", () => {
  const db = makeReflectionDb()
  insertDump(db, { sessionId: "ses_a", seq: 1, model: "m", systemFull: ["for a"] })
  insertDump(db, { sessionId: "ses_b", seq: 1, model: "m", systemFull: ["for b"] })

  const result = readPromptDumps(db, "ses_a", "latest")
  assert.equal(result.length, 1)
  assert.deepEqual(result[0].system_full, ["for a"])
})

// ─── readSessionTokenStats ───────────────────────────────────────────────────

test("readSessionTokenStats returns zeros when session has no messages", () => {
  const db = makeOpenCodeDb()
  const stats = readSessionTokenStats(db, "ses_empty")
  assert.deepEqual(stats, EMPTY_TOKEN_STATS)
})

test("readSessionTokenStats sums token fields across all messages in the session", () => {
  const db = makeOpenCodeDb()
  insertMessage(db, {
    id: "msg_1", sessionId: "ses_x", role: "assistant",
    tokens: { input: 100, output: 50, cache: { read: 200, write: 10 } },
  })
  insertMessage(db, {
    id: "msg_2", sessionId: "ses_x", role: "assistant",
    tokens: { input: 80, output: 30, cache: { read: 0, write: 5 } },
  })

  const stats = readSessionTokenStats(db, "ses_x")
  assert.equal(stats.total_input, 180)
  assert.equal(stats.total_output, 80)
  assert.equal(stats.cache_read, 200)
  assert.equal(stats.cache_write, 15)
})

test("readSessionTokenStats does not include messages from other sessions", () => {
  const db = makeOpenCodeDb()
  insertMessage(db, {
    id: "msg_1", sessionId: "ses_target",
    tokens: { input: 100, output: 50, cache: { read: 0, write: 0 } },
  })
  insertMessage(db, {
    id: "msg_2", sessionId: "ses_other",
    tokens: { input: 999, output: 999, cache: { read: 999, write: 999 } },
  })

  const stats = readSessionTokenStats(db, "ses_target")
  assert.equal(stats.total_input, 100)
  assert.equal(stats.total_output, 50)
})

test("readSessionTokenStats returns top tool outputs ordered by char count descending", () => {
  const db = makeOpenCodeDb()
  insertMessage(db, { id: "msg_1", sessionId: "ses_t" })
  insertPart(db, { id: "p1", messageId: "msg_1", tool: "bash",  output: "a".repeat(500) })
  insertPart(db, { id: "p2", messageId: "msg_1", tool: "read",  output: "b".repeat(200) })
  insertPart(db, { id: "p3", messageId: "msg_1", tool: "write", output: "c".repeat(800) })

  const stats = readSessionTokenStats(db, "ses_t")
  assert.equal(stats.top_tool_outputs.length, 3)
  assert.equal(stats.top_tool_outputs[0].tool_name, "write")
  assert.equal(stats.top_tool_outputs[0].output_chars, 800)
  assert.equal(stats.top_tool_outputs[1].tool_name, "bash")
  assert.equal(stats.top_tool_outputs[1].output_chars, 500)
})

test("readSessionTokenStats excludes tool parts with no output", () => {
  const db = makeOpenCodeDb()
  insertMessage(db, { id: "msg_1", sessionId: "ses_u" })
  insertPart(db, { id: "p1", messageId: "msg_1", tool: "bash", output: null })

  const stats = readSessionTokenStats(db, "ses_u")
  assert.equal(stats.top_tool_outputs.length, 0)
})

test("readSessionTokenStats excludes non-completed tool parts", () => {
  const db = makeOpenCodeDb()
  insertMessage(db, { id: "msg_1", sessionId: "ses_v" })
  insertPart(db, { id: "p1", messageId: "msg_1", tool: "bash", status: "running", output: "some output" })

  const stats = readSessionTokenStats(db, "ses_v")
  assert.equal(stats.top_tool_outputs.length, 0)
})

// ─── buildPromptAnalysis ─────────────────────────────────────────────────────

test("buildPromptAnalysis returns early message when dumps is empty", () => {
  const result = buildPromptAnalysis({ dumps: [], tokenStats: EMPTY_TOKEN_STATS, mode: "latest", directory: "/x" })
  assert.match(result, /No prompt dump data found/)
})

test("buildPromptAnalysis latest mode includes system prompt content", () => {
  const dumps = [{
    seq: 1,
    created_at: 1700000000000,
    model: "claude-sonnet-4-6",
    system_total_chars: 11,
    system_full: ["hello world"],
  }]
  const result = buildPromptAnalysis({ dumps, tokenStats: EMPTY_TOKEN_STATS, mode: "latest", directory: "/proj" })
  assert.match(result, /hello world/)
  assert.match(result, /Segment 0/)
  assert.match(result, /11 chars/)
})

test("buildPromptAnalysis trend mode lists seq rows without markdown table syntax", () => {
  const dumps = [
    { seq: 1, created_at: 1700000000000, model: "m1", system_total_chars: 100, system_full: ["x"] },
    { seq: 2, created_at: 1700001000000, model: "m2", system_total_chars: 200, system_full: ["y"] },
  ]
  const result = buildPromptAnalysis({ dumps, tokenStats: EMPTY_TOKEN_STATS, mode: "trend", directory: "/proj" })
  // Must not contain markdown table pipes at start of a content line
  assert.doesNotMatch(result, /^\| seq \|/m)
  assert.match(result, /seq 1/)
  assert.match(result, /seq 2/)
  assert.match(result, /100 chars/)
  assert.match(result, /200 chars/)
})

test("buildPromptAnalysis includes token stats when non-zero", () => {
  const dumps = [{
    seq: 1, created_at: 1700000000000, model: "m", system_total_chars: 5, system_full: ["hello"],
  }]
  const tokenStats = {
    total_input: 1234, total_output: 567, cache_read: 89, cache_write: 10, top_tool_outputs: [],
  }
  const result = buildPromptAnalysis({ dumps, tokenStats, mode: "latest", directory: "/x" })
  assert.match(result, /1234/)
  assert.match(result, /567/)
  assert.match(result, /89/)
})

test("buildPromptAnalysis includes top tool outputs when present", () => {
  const dumps = [{
    seq: 1, created_at: 1700000000000, model: "m", system_total_chars: 5, system_full: ["x"],
  }]
  const tokenStats = {
    total_input: 0, total_output: 0, cache_read: 0, cache_write: 0,
    top_tool_outputs: [
      { tool_name: "bash", output_chars: 4000 },
      { tool_name: "read", output_chars: 1500 },
    ],
  }
  const result = buildPromptAnalysis({ dumps, tokenStats, mode: "latest", directory: "/x" })
  assert.match(result, /bash/)
  assert.match(result, /4000/)
  assert.match(result, /read/)
  assert.match(result, /1500/)
})

test("buildPromptAnalysis uses (unknown) when directory is missing", () => {
  const dumps = [{
    seq: 1, created_at: 1700000000000, model: "m", system_total_chars: 5, system_full: ["x"],
  }]
  const result = buildPromptAnalysis({ dumps, tokenStats: EMPTY_TOKEN_STATS, mode: "latest" })
  assert.match(result, /\(unknown\)/)
})

test("buildPromptAnalysis truncates system_full segments that exceed ANALYZE_MAX_SYSTEM_CHARS", () => {
  const bigSeg = "z".repeat(42_000)
  const dumps = [{
    seq: 1, created_at: 1700000000000, model: "m",
    system_total_chars: bigSeg.length,
    system_full: [bigSeg, "should be truncated away"],
  }]
  const result = buildPromptAnalysis({ dumps, tokenStats: EMPTY_TOKEN_STATS, mode: "latest", directory: "/x" })
  assert.match(result, /\[truncated\]/)
  // Second segment should not appear fully since budget is exhausted
  assert.doesNotMatch(result, /should be truncated away/)
})
