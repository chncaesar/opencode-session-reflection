import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import test from "node:test"

import {
  appendRunEvent,
  buildRunManifest,
  createRunId,
  hashValue,
  readRunManifest,
  saveReportForRun,
  writeRunManifest,
} from "../src/logging.js"

function makeRunId(suffix = "abcdef123456") {
  return createRunId(new Date("2026-07-11T00:00:00.000Z"), suffix)
}

test("buildRunManifest records metadata without raw transcript or directory paths", () => {
  const manifest = buildRunManifest({
    runId: makeRunId("manifest0001"),
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

  assert.equal(manifest.runId, makeRunId("manifest0001"))
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
  assert.doesNotMatch(json, /Private project fix/)
  assert.ok(!Object.hasOwn(manifest, "reportPath"))
  assert.ok(!Object.hasOwn(manifest, "completedAt"))
  assert.ok(!Object.hasOwn(manifest, "previousReportPaths"))
})

test("writeRunManifest and appendRunEvent persist audit files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-reflection-"))
  const manifest = buildRunManifest({
    runId: makeRunId("persist00002"),
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
  await appendRunEvent(dir, { type: "collect", runId: manifest.runId, sessionCount: 0 })

  const savedManifest = JSON.parse(await readFile(manifestPath, "utf8"))
  const eventLines = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n")

  assert.equal(savedManifest.runId, manifest.runId)
  assert.equal(savedManifest.skippedSessions[0].reason, "empty transcript")
  assert.equal(JSON.parse(eventLines[0]).type, "collect")
})

test("audit directories and files are owner-only", async () => {
  const parent = await mkdtemp(join(tmpdir(), "session-reflection-"))
  const dir = join(parent, "audit")
  const manifest = buildRunManifest({
    runId: makeRunId("permissions1"),
    startedAt: "2026-07-11T00:00:00.000Z",
    action: "collect",
    limit: 1,
    requestedSessionId: null,
    selectedSessions: [],
    skippedSessions: [],
    prompt: "prompt",
    errors: [],
  })

  const manifestPath = await writeRunManifest(dir, manifest)
  const eventPath = await appendRunEvent(dir, { type: "collect", runId: manifest.runId })

  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  assert.equal((await stat(join(dir, "runs"))).mode & 0o777, 0o700)
  assert.equal((await stat(manifestPath)).mode & 0o777, 0o600)
  assert.equal((await stat(eventPath)).mode & 0o777, 0o600)
})

test("readRunManifest rejects unsafe IDs, unknown runs, and mismatched identities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-reflection-"))
  const validRunId = makeRunId("validation01")

  for (const unsafeId of ["../events", "/tmp/absolute", "run-1", `${validRunId}/child`]) {
    await assert.rejects(readRunManifest(dir, unsafeId), /Invalid run ID/)
  }

  await assert.rejects(readRunManifest(dir, validRunId), /Unknown run ID/)

  const manifest = buildRunManifest({
    runId: validRunId,
    startedAt: "2026-07-11T00:00:00.000Z",
    action: "collect",
    limit: 1,
    requestedSessionId: null,
    selectedSessions: [],
    skippedSessions: [],
    prompt: "prompt",
    errors: [],
  })
  const manifestPath = await writeRunManifest(dir, manifest)
  await chmod(manifestPath, 0o600)
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, runId: makeRunId("different001") })}\n`)

  await assert.rejects(readRunManifest(dir, validRunId), /does not match/)
})

test("readRunManifest accepts legacy 0.2 manifests with mutable report fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "session-reflection-"))
  const runId = makeRunId()
  const manifest = {
    runId,
    startedAt: "2026-07-11T00:00:00.000Z",
    completedAt: "2026-07-11T00:01:00.000Z",
    action: "collect",
    limit: 1,
    requestedSessionId: null,
    selectedSessions: [],
    skippedSessions: [],
    promptHash: hashValue("prompt"),
    priorArtLookupRequired: true,
    reportPath: "reports/legacy.md",
    previousReportPaths: [],
    errors: [],
  }

  await writeRunManifest(dir, manifest)
  const loaded = await readRunManifest(dir, runId)

  assert.equal(loaded.reportPath, "reports/legacy.md")
  assert.equal(loaded.completedAt, "2026-07-11T00:01:00.000Z")
})

test("persistence rejects symlinked runs and reports directories", async () => {
  const parent = await mkdtemp(join(tmpdir(), "session-reflection-symlinks-"))
  const root = join(parent, "audit")
  const outsideRuns = join(parent, "outside-runs")
  const outsideReports = join(parent, "outside-reports")
  await mkdir(root)
  await mkdir(outsideRuns)
  await symlink(outsideRuns, join(root, "runs"), "dir")

  const manifest = buildRunManifest({
    runId: makeRunId("symlinkruns1"),
    startedAt: "2026-07-11T00:00:00.000Z",
    action: "collect",
    limit: 1,
    requestedSessionId: null,
    selectedSessions: [],
    skippedSessions: [],
    prompt: "prompt",
    errors: [],
  })

  await assert.rejects(writeRunManifest(root, manifest), /symbolic link/)
  await assert.rejects(access(join(outsideRuns, `${manifest.runId}.json`)), { code: "ENOENT" })

  await rename(join(root, "runs"), join(root, "runs-link"))
  await writeRunManifest(root, manifest)
  await mkdir(outsideReports)
  await symlink(outsideReports, join(root, "reports"), "dir")

  await assert.rejects(saveReportForRun(root, manifest.runId, () => "private report"), /symbolic link/)
  assert.deepEqual(await readdir(outsideReports), [])
})

test("persistence rejects a symlinked manifest target without creating a report", async () => {
  const parent = await mkdtemp(join(tmpdir(), "session-reflection-manifest-link-"))
  const root = join(parent, "audit")
  const outsideManifest = join(parent, "outside.json")
  const runId = makeRunId("targetlink01")
  await mkdir(join(root, "runs"), { recursive: true })
  await writeFile(outsideManifest, "outside must stay unchanged\n")
  await symlink(outsideManifest, join(root, "runs", `${runId}.json`))

  await assert.rejects(saveReportForRun(root, runId, () => "must not escape"), /symbolic link/)
  assert.equal(await readFile(outsideManifest, "utf8"), "outside must stay unchanged\n")
  await assert.rejects(access(join(root, "reports")), { code: "ENOENT" })
})

test("save builds the report and sidecar from one immutable manifest snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-reflection-snapshot-"))
  const runId = makeRunId("snapshot0001")
  const manifest = buildRunManifest({
    runId,
    startedAt: "2026-07-11T00:00:00.000Z",
    action: "collect",
    limit: 2,
    requestedSessionId: null,
    selectedSessions: [
      { session: { id: "ses_1" }, messageCount: 1, transcript: [{ tools: [] }] },
      { session: { id: "ses_2" }, messageCount: 1, transcript: [{ tools: [] }] },
    ],
    skippedSessions: [],
    prompt: "prompt",
    errors: [],
  })
  const manifestPath = await writeRunManifest(root, manifest)
  const originalManifest = await readFile(manifestPath, "utf8")
  let callbackManifest

  const saved = await saveReportForRun(root, runId, async (snapshot) => {
    callbackManifest = snapshot
    await writeFile(manifestPath, `${JSON.stringify({ ...snapshot, selectedSessions: [] })}\n`)
    return `Run ID: ${snapshot.runId}\nReviewed sessions: ${snapshot.selectedSessions.length}\n`
  }, { now: new Date("2026-07-11T00:01:00.000Z"), reportEntropy: () => "snapshot" })
  const sidecar = JSON.parse(await readFile(saved.sidecarAbsolutePath, "utf8"))

  assert.equal(callbackManifest.runId, runId)
  assert.equal(callbackManifest.selectedSessions.length, 2)
  assert.equal(await readFile(saved.absolutePath, "utf8"), `Run ID: ${runId}\nReviewed sessions: 2\n`)
  assert.equal(sidecar.runId, runId)
  assert.equal(sidecar.reportPath, saved.relativePath)
  assert.equal(sidecar.savedAt, "2026-07-11T00:01:00.000Z")
  assert.equal(sidecar.reviewedSessionCount, 2)
  assert.equal(sidecar.manifestHash, hashValue(originalManifest))
  assert.equal(saved.sidecarAbsolutePath, saved.absolutePath.replace(/\.md$/, ".json"))
  assert.equal((await stat(saved.sidecarAbsolutePath)).mode & 0o777, 0o600)
})

test("concurrent saves create distinct immutable report and sidecar pairs without changing the manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-reflection-concurrent-"))
  const runId = makeRunId("concurrent01")
  const manifest = buildRunManifest({
    runId,
    startedAt: "2026-07-11T00:00:00.000Z",
    action: "collect",
    limit: 1,
    requestedSessionId: null,
    selectedSessions: [],
    skippedSessions: [],
    prompt: "prompt",
    errors: [],
  })
  const manifestPath = await writeRunManifest(root, manifest)
  const manifestBefore = await readFile(manifestPath, "utf8")

  const [first, second] = await Promise.all([
    saveReportForRun(root, runId, () => "first concurrent report"),
    saveReportForRun(root, runId, () => "second concurrent report"),
  ])

  assert.notEqual(first.absolutePath, second.absolutePath)
  assert.match(first.absolutePath, new RegExp(runId))
  assert.match(second.absolutePath, new RegExp(runId))
  assert.equal(await readFile(first.absolutePath, "utf8"), "first concurrent report")
  assert.equal(await readFile(second.absolutePath, "utf8"), "second concurrent report")
  assert.equal((await stat(first.absolutePath)).nlink, 1)
  assert.equal((await stat(second.absolutePath)).nlink, 1)
  await access(first.sidecarAbsolutePath)
  await access(second.sidecarAbsolutePath)
  assert.equal(await readFile(manifestPath, "utf8"), manifestBefore)
})

test("report creation retries collisions without truncating the existing report", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-reflection-collision-"))
  const runId = makeRunId("collision001")
  const manifest = buildRunManifest({
    runId,
    startedAt: "2026-07-11T00:00:00.000Z",
    action: "collect",
    limit: 1,
    requestedSessionId: null,
    selectedSessions: [],
    skippedSessions: [],
    prompt: "prompt",
    errors: [],
  })
  await writeRunManifest(root, manifest)
  await mkdir(join(root, "reports"))

  const stamp = "2026-07-11T00-01-00-000Z"
  const existingPath = join(root, "reports", `${runId}-${stamp}-collision.md`)
  await writeFile(existingPath, "existing report must survive")

  const saved = await saveReportForRun(root, runId, () => "new report", {
    now: new Date("2026-07-11T00:01:00.000Z"),
    reportEntropy: (attempt) => attempt === 0 ? "collision" : "unique",
  })

  assert.equal(await readFile(existingPath, "utf8"), "existing report must survive")
  assert.equal(saved.absolutePath, join(root, "reports", `${runId}-${stamp}-unique.md`))
  assert.equal(await readFile(saved.absolutePath, "utf8"), "new report")
  assert.equal(JSON.parse(await readFile(saved.sidecarAbsolutePath, "utf8")).reportPath, saved.relativePath)
})

test("report creation retries a sidecar collision without leaving an unpaired report", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-reflection-sidecar-collision-"))
  const runId = makeRunId("sidecar00001")
  const manifest = buildRunManifest({
    runId,
    startedAt: "2026-07-11T00:00:00.000Z",
    action: "collect",
    limit: 1,
    requestedSessionId: null,
    selectedSessions: [],
    skippedSessions: [],
    prompt: "prompt",
    errors: [],
  })
  await writeRunManifest(root, manifest)
  await mkdir(join(root, "reports"))

  const stamp = "2026-07-11T00-01-00-000Z"
  const collidedBase = join(root, "reports", `${runId}-${stamp}-collision`)
  await writeFile(`${collidedBase}.json`, "existing sidecar must survive")

  const saved = await saveReportForRun(root, runId, () => "new report", {
    now: new Date("2026-07-11T00:01:00.000Z"),
    reportEntropy: (attempt) => attempt === 0 ? "collision" : "unique",
  })

  await assert.rejects(access(`${collidedBase}.md`), { code: "ENOENT" })
  assert.equal(await readFile(`${collidedBase}.json`, "utf8"), "existing sidecar must survive")
  assert.equal(await readFile(saved.absolutePath, "utf8"), "new report")
})

test("sidecar publication failure removes the report published by the same save", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-reflection-sidecar-failure-"))
  const runId = makeRunId("sidecarfail1")
  const manifest = buildRunManifest({
    runId,
    startedAt: "2026-07-11T00:00:00.000Z",
    action: "collect",
    limit: 1,
    requestedSessionId: null,
    selectedSessions: [],
    skippedSessions: [],
    prompt: "prompt",
    errors: [],
  })
  await writeRunManifest(root, manifest)
  const reportsDir = join(root, "reports")
  await mkdir(reportsDir)

  await assert.rejects(
    saveReportForRun(root, runId, () => "report must be rolled back", {
      now: new Date("2026-07-11T00:01:00.000Z"),
      reportEntropy: () => "sidecarfailure",
      beforeSidecarPublish: async ({ sidecarTemporaryPath }) => {
        await unlink(sidecarTemporaryPath)
      },
    }),
    { code: "ENOENT" },
  )

  assert.deepEqual(await readdir(reportsDir), [])
})

test("appendRunEvent rejects symlinked, non-regular, and hard-linked targets", async () => {
  for (const targetType of ["symlink", "directory", "hard-link"]) {
    const parent = await mkdtemp(join(tmpdir(), `session-reflection-event-${targetType}-`))
    const root = join(parent, "audit")
    const eventPath = join(root, "events.jsonl")
    await mkdir(root)

    if (targetType === "symlink") {
      const outside = join(parent, "outside.jsonl")
      await writeFile(outside, "outside\n")
      await symlink(outside, eventPath)
    } else if (targetType === "directory") {
      await mkdir(eventPath)
    } else {
      const outside = join(parent, "outside.jsonl")
      await writeFile(outside, "outside\n")
      await link(outside, eventPath)
    }

    await assert.rejects(
      appendRunEvent(root, { type: "save", runId: makeRunId() }),
      /symbolic link|regular file|hard links/,
    )
  }
})

test("separate processes saving the same run both preserve distinct report pairs", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-reflection-processes-"))
  const runId = makeRunId("processes001")
  const manifest = buildRunManifest({
    runId,
    startedAt: "2026-07-11T00:00:00.000Z",
    action: "collect",
    limit: 1,
    requestedSessionId: null,
    selectedSessions: [],
    skippedSessions: [],
    prompt: "prompt",
    errors: [],
  })
  const manifestPath = await writeRunManifest(root, manifest)
  const manifestBefore = await readFile(manifestPath, "utf8")
  const childScript = join(import.meta.dirname, "fixtures", "save-report-child.mjs")

  const [first, second] = await Promise.all([
    runSaveChild(childScript, root, runId, "first process report"),
    runSaveChild(childScript, root, runId, "second process report"),
  ])

  assert.notEqual(first.absolutePath, second.absolutePath)
  assert.equal(await readFile(first.absolutePath, "utf8"), "first process report")
  assert.equal(await readFile(second.absolutePath, "utf8"), "second process report")
  await access(first.sidecarAbsolutePath)
  await access(second.sidecarAbsolutePath)
  assert.equal(await readFile(manifestPath, "utf8"), manifestBefore)
})

function runSaveChild(script, root, runId, report) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, [script, root, runId, report], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("error", rejectChild)
    child.on("close", (code) => {
      if (code !== 0) {
        rejectChild(new Error(`save child exited ${code}: ${stderr}`))
        return
      }
      resolveChild(JSON.parse(stdout))
    })
  })
}
