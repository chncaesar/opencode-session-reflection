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

test("formatReflectionReport renders stable markdown sections", () => {
  const report = formatReflectionReport({
    reviewedSessionCount: 2,
    model: "openai/gpt-5.5",
    analysis: "### 1. Developer-to-agent communication gaps\n- Missing acceptance criteria",
  })

  assert.doesNotMatch(report, /[\p{Script=Han}]/u)
  assert.match(report, /^# OpenCode Session Reflection/m)
  assert.match(report, /Reviewed sessions: 2/)
  assert.match(report, /Model: openai\/gpt-5\.5/)
  assert.match(report, /Missing acceptance criteria/)
})
