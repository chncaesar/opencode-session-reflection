import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import {
  appendRunEvent,
  attachReportToRun,
  buildRunManifest,
  createRunId,
  writeRunManifest,
} from "../src/logging.js"

test("buildRunManifest records metadata without raw transcript or directory paths", () => {
  const manifest = buildRunManifest({
    runId: "run-1",
    startedAt: "2026-07-11T00:00:00.000Z",
    action: "collect",
    limit: 8,
    requestedSessionId: null,
    selectedSessions: [
      {
        session: {
          id: "ses_1",
          title: "Private project fix",
          directory: "/Users/alice/secret-client/project",
          time_updated: 123,
        },
        messageCount: 2,
        transcript: [
          { role: "user", text: "secret customer request", tools: [], timestamp: 1 },
          { role: "assistant", text: "private answer", tools: ["grep:completed"], timestamp: 2 },
        ],
      },
    ],
    skippedSessions: [{ id: "ses_2", reason: "empty transcript" }],
    prompt: "prompt with private content",
    errors: [],
  })

  const json = JSON.stringify(manifest)

  assert.equal(manifest.runId, "run-1")
  assert.equal(manifest.selectedSessions[0].id, "ses_1")
  assert.equal(manifest.selectedSessions[0].messageCount, 2)
  assert.equal(manifest.selectedSessions[0].transcriptItemCount, 2)
  assert.equal(manifest.selectedSessions[0].toolCallCount, 1)
  assert.match(manifest.selectedSessions[0].directoryHash, /^sha256:/)
  assert.equal(manifest.priorArtLookupRequired, true)
  assert.match(manifest.promptHash, /^sha256:/)
  assert.doesNotMatch(json, /secret customer request/)
  assert.doesNotMatch(json, /private answer/)
  assert.doesNotMatch(json, /secret-client/)
  assert.doesNotMatch(json, /prompt with private content/)
})

test("writeRunManifest and appendRunEvent persist audit files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-reflection-"))
  const manifest = buildRunManifest({
    runId: "run-2",
    startedAt: "2026-07-11T00:00:00.000Z",
    action: "collect",
    limit: 1,
    requestedSessionId: "ses_1",
    selectedSessions: [],
    skippedSessions: [{ id: "ses_1", reason: "empty transcript" }],
    prompt: "prompt",
    errors: [],
  })

  const manifestPath = await writeRunManifest(dir, manifest)
  await appendRunEvent(dir, { type: "collect", runId: "run-2", sessionCount: 0 })

  const savedManifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const eventLines = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n")

  assert.equal(savedManifest.runId, "run-2")
  assert.equal(savedManifest.skippedSessions[0].reason, "empty transcript")
  assert.equal(JSON.parse(eventLines[0]).type, "collect")
})

test("attachReportToRun records saved report path and completion time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-reflection-"))
  const manifest = buildRunManifest({
    runId: createRunId(new Date("2026-07-11T00:00:00.000Z"), "abcdef123456"),
    startedAt: "2026-07-11T00:00:00.000Z",
    action: "collect",
    limit: 1,
    requestedSessionId: null,
    selectedSessions: [],
    skippedSessions: [],
    prompt: "prompt",
    errors: [],
  })

  await writeRunManifest(dir, manifest)
  const updatedPath = await attachReportToRun(dir, manifest.runId, "reports/report.md", "2026-07-11T00:01:00.000Z")
  const updated = JSON.parse(await readFile(updatedPath, "utf8"))

  assert.equal(updated.reportPath, "reports/report.md")
  assert.equal(updated.completedAt, "2026-07-11T00:01:00.000Z")
})
