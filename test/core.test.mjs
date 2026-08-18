import assert from "node:assert/strict"
import test from "node:test"

import {
  buildReflectionPrompt,
  extractTranscript,
  formatSessionCandidatesForConfirmation,
  formatReflectionReport,
  selectSessionsByName,
  selectSessionsForReview,
} from "../src/core.js"

test("extractTranscript keeps user prompts, substantive assistant text, and tool evidence", () => {
  const messages = [
    {
      info: { role: "user", time_created: 10 },
      parts: [{ type: "text", text: "Fix the login failure and also check nearby pages" }],
    },
    {
      info: { role: "assistant", time_created: 20 },
      parts: [
        { type: "text", text: "I need to search the relevant code first." },
        { type: "tool", tool: "grep", state: { status: "completed" } },
      ],
    },
    {
      info: { role: "assistant", time_created: 30 },
      parts: [
        {
          type: "text",
          text: "I am thinking through the final answer.\nDone. Do you want me to run tests?",
        },
      ],
    },
  ]

  const transcript = extractTranscript(messages)

  assert.deepEqual(transcript, [
    {
      role: "user",
      text: "Fix the login failure and also check nearby pages",
      tools: [],
      timestamp: 10,
    },
    {
      role: "assistant",
      text: "",
      tools: ["grep:completed"],
      timestamp: 20,
    },
    {
      role: "assistant",
      text: "Done. Do you want me to run tests?",
      tools: [],
      timestamp: 30,
    },
  ])
})

test("selectSessionsForReview sorts recent sessions and respects limit", () => {
  const sessions = [
    { id: "old", time_updated: 1, title: "old" },
    { id: "new", time_updated: 3, title: "new" },
    { id: "middle", time_updated: 2, title: "middle" },
  ]

  assert.deepEqual(
    selectSessionsForReview(sessions, { limit: 2 }).map((session) => session.id),
    ["new", "middle"],
  )
})

test("session selection accepts nested and flattened updated timestamps", () => {
  const sessions = [
    { id: "flat", time_updated: 2 },
    { id: "nested", time: { updated: 3 } },
    { id: "old", time: { updated: 1 } },
  ]

  assert.deepEqual(
    selectSessionsForReview(sessions, { limit: 2, since: 2 }).map((session) => session.id),
    ["nested", "flat"],
  )
})

test("selectSessionsByName prefers exact title matches before contains fallback", () => {
  const sessions = [
    { id: "contains", title: "npm whoami ENEEDAUTH 排查 follow-up" },
    { id: "exact", title: "npm whoami ENEEDAUTH 排查" },
  ]

  assert.deepEqual(
    selectSessionsByName(sessions, "npm whoami ENEEDAUTH 排查").map((session) => session.id),
    ["exact"],
  )
})

test("selectSessionsByName falls back to case-insensitive contains matches", () => {
  const sessions = [
    { id: "one", title: "Deploy backend" },
    { id: "two", title: "npm whoami ENEEDAUTH 排查" },
  ]

  assert.deepEqual(
    selectSessionsByName(sessions, "eneedauth").map((session) => session.id),
    ["two"],
  )
  assert.deepEqual(selectSessionsByName(sessions, "  "), [])
})

test("formatSessionCandidatesForConfirmation renders short previews for ambiguous names", () => {
  const output = formatSessionCandidatesForConfirmation({
    sessionName: "deploy",
    candidates: [
      {
        session: { id: "ses_1", title: "deploy backend", time_updated: 123 },
        transcript: [
          { role: "user", text: "请帮我部署后端服务", tools: [], timestamp: 1 },
          { role: "assistant", text: "我会先检查本地状态", tools: [], timestamp: 2 },
          { role: "assistant", text: "x".repeat(220), tools: [], timestamp: 3 },
        ],
      },
      {
        session: { id: "ses_2", title: "deploy frontend", time_updated: 456 },
        transcript: [],
      },
    ],
  })

  assert.match(output, /Multiple sessions matched "deploy"/)
  assert.match(output, /sessionID: ses_1/)
  assert.match(output, /title: deploy backend/)
  assert.match(output, /time_updated: 123/)
  assert.match(output, /- user: 请帮我部署后端服务/)
  assert.match(output, /- assistant: 我会先检查本地状态/)
  assert.match(output, /\.\.\./)
  assert.match(output, /sessionID: ses_2/)
  assert.match(output, /preview: \(no transcript text\)/)
})

test("buildReflectionPrompt asks for English-only feasibility and value analysis", () => {
  const prompt = buildReflectionPrompt({
    sessions: [
      {
        id: "s1",
        title: "Login fix",
        directory: "/repo",
        transcript: [
          { role: "user", text: "Fix login", tools: [], timestamp: 1 },
          { role: "assistant", text: "Done", tools: [], timestamp: 2 },
        ],
      },
    ],
  })

  assert.doesNotMatch(prompt, /[\p{Script=Han}]/u)
  assert.match(prompt, /Developer-to-agent communication gaps/)
  assert.match(prompt, /Recurring OpenCode mistakes/)
  assert.match(prompt, /Plugin, skill, command, or rule opportunities/)
  assert.match(prompt, /prompt-design issue/)
  assert.match(prompt, /detectable from transcript evidence/)
  assert.match(prompt, /automation boundary/)
  assert.match(prompt, /open-source generality/)
  assert.match(prompt, /prior-art lookup/)
  assert.match(prompt, /official OpenCode repository/)
  assert.match(prompt, /GitHub/)
  assert.match(prompt, /avoid reinventing the wheel/)
  assert.match(prompt, /Feasibility/)
  assert.match(prompt, /Value/)
  assert.match(prompt, /session_id: s1/)
})

test("extractTranscript accepts nested timestamps and filters ignored, synthetic, and reasoning parts", () => {
  const transcript = extractTranscript([
    {
      info: { role: "assistant", time: { created: 42 } },
      parts: [
        { type: "text", text: "kept text" },
        { type: "text", text: "ignored text", ignored: true },
        { type: "text", text: "synthetic text", synthetic: true },
        { type: "reasoning", text: "private reasoning" },
        { type: "tool", tool: "read", state: { status: "completed" }, ignored: true },
        { type: "tool", tool: "grep", state: { status: "completed" } },
      ],
    },
  ])

  assert.deepEqual(transcript, [
    { role: "assistant", text: "kept text", tools: ["grep:completed"], timestamp: 42 },
  ])
})

test("buildReflectionPrompt fairly bounds evidence and marks omitted transcript items", () => {
  const sessions = Array.from({ length: 12 }, (_, sessionIndex) => ({
    id: `session-${sessionIndex}`,
    title: `Title ${sessionIndex}`,
    directory: `/private/repo/${sessionIndex}`,
    transcript: Array.from({ length: 30 }, (_, itemIndex) => ({
      role: itemIndex % 2 === 0 ? "user" : "assistant",
      text: `${sessionIndex}-${itemIndex}-${"x".repeat(1700)}`,
      tools: [],
      timestamp: itemIndex,
    })),
  }))

  const prompt = buildReflectionPrompt({ sessions })
  const evidence = prompt.split("Session evidence:\n\n")[1]

  assert.ok(evidence.length <= 48_000, `evidence was ${evidence.length} characters`)
  for (const session of sessions) assert.match(evidence, new RegExp(`session_id: ${session.id}`))
  assert.match(evidence, /\[omitted \d+ transcript items due to evidence budget\]/)
})

test("buildReflectionPrompt honors a custom maxEvidenceChars budget", () => {
  const sessions = Array.from({ length: 2 }, (_, sessionIndex) => ({
    id: `session-${sessionIndex}`,
    title: `Title ${sessionIndex}`,
    directory: `/repo/${sessionIndex}`,
    transcript: Array.from({ length: 20 }, (_, itemIndex) => ({
      role: itemIndex % 2 === 0 ? "user" : "assistant",
      text: `${sessionIndex}-${itemIndex}-${"x".repeat(500)}`,
      tools: [],
      timestamp: itemIndex,
    })),
  }))

  const prompt = buildReflectionPrompt({ sessions, maxEvidenceChars: 2_000 })
  const evidence = prompt.split("Session evidence:\n\n")[1]

  assert.ok(evidence.length <= 2_000, `evidence was ${evidence.length} characters`)
  for (const session of sessions) assert.match(evidence, new RegExp(`session_id: ${session.id}`))
  assert.match(evidence, /\[omitted \d+ transcript items due to evidence budget\]/)
})

test("buildReflectionPrompt falls back to the default budget when none is provided", () => {
  const sessions = Array.from({ length: 12 }, (_, sessionIndex) => ({
    id: `session-${sessionIndex}`,
    title: `Title ${sessionIndex}`,
    directory: `/repo/${sessionIndex}`,
    transcript: Array.from({ length: 30 }, (_, itemIndex) => ({
      role: itemIndex % 2 === 0 ? "user" : "assistant",
      text: `${sessionIndex}-${itemIndex}-${"x".repeat(1700)}`,
      tools: [],
      timestamp: itemIndex,
    })),
  }))

  const prompt = buildReflectionPrompt({ sessions })
  const evidence = prompt.split("Session evidence:\n\n")[1]

  assert.ok(evidence.length <= 48_000, `evidence was ${evidence.length} characters`)
})

test("formatReflectionReport renders stable markdown sections", () => {
  const report = formatReflectionReport({
    runId: "2026-07-11T00-00-00-000Z-report000001",
    reviewedSessionCount: 2,
    agent: "review-agent",
    analysis: "### 1. Developer-to-agent communication gaps\n- Missing acceptance criteria",
  })

  assert.doesNotMatch(report, /[\p{Script=Han}]/u)
  assert.match(report, /^# OpenCode Session Reflection/m)
  assert.match(report, /Run ID: 2026-07-11T00-00-00-000Z-report000001/)
  assert.match(report, /Reviewed sessions: 2/)
  assert.match(report, /Agent: review-agent/)
  assert.match(report, /Missing acceptance criteria/)
})
