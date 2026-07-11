// Tested by test/logging.test.mjs.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"

export function createRunId(date = new Date(), entropy = randomUUID()) {
  const stamp = date.toISOString().replace(/[:.]/g, "-")
  const suffix = String(entropy).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)
  return `${stamp}-${suffix}`
}

export function buildRunManifest({
  runId,
  startedAt,
  action,
  limit,
  requestedSessionId,
  selectedSessions,
  skippedSessions,
  prompt,
  errors,
}) {
  return {
    runId,
    startedAt,
    completedAt: null,
    action,
    limit,
    requestedSessionId: requestedSessionId ?? null,
    selectedSessions: selectedSessions.map(summarizeSession),
    skippedSessions,
    promptHash: hashValue(prompt),
    priorArtLookupRequired: true,
    reportPath: null,
    errors,
  }
}

export async function writeRunManifest(rootDir, manifest) {
  const runsDir = join(rootDir, "runs")
  await mkdir(runsDir, { recursive: true })
  const file = join(runsDir, `${manifest.runId}.json`)
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return file
}

export async function appendRunEvent(rootDir, event) {
  await mkdir(rootDir, { recursive: true })
  const file = join(rootDir, "events.jsonl")
  const entry = {
    timestamp: new Date().toISOString(),
    ...event,
  }
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8")
  return file
}

export async function attachReportToRun(rootDir, runId, reportPath, completedAt = new Date().toISOString()) {
  const file = join(rootDir, "runs", `${runId}.json`)
  const manifest = JSON.parse(await readFile(file, "utf8"))
  manifest.completedAt = completedAt
  manifest.reportPath = reportPath
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  return file
}

export function hashValue(value) {
  return `sha256:${createHash("sha256").update(String(value ?? "")).digest("hex")}`
}

function summarizeSession({ session, messageCount, transcript }) {
  return {
    id: session.id,
    title: session.title || "(untitled)",
    directoryHash: hashValue(session.directory || ""),
    timeUpdated: session.time_updated ?? null,
    messageCount,
    transcriptItemCount: transcript.length,
    toolCallCount: transcript.reduce((count, item) => count + item.tools.length, 0),
  }
}
