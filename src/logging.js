// Tested by test/logging.test.mjs.
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-zA-Z0-9]{1,12}$/
const REPORT_CREATE_RETRIES = 10

export function createRunId(date = new Date(), entropy = randomUUID()) {
  const stamp = formatTimestamp(date)
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
    action,
    limit,
    requestedSessionId: requestedSessionId ?? null,
    selectedSessions: selectedSessions.map(summarizeSession),
    skippedSessions,
    promptHash: hashValue(prompt),
    priorArtLookupRequired: true,
    errors,
  }
}

export async function writeRunManifest(rootDir, manifest) {
  validateRunId(manifest.runId)
  const location = await resolveManifestLocation(rootDir, manifest.runId)
  if (await readTargetIdentity(location.file)) {
    throw new Error(`Run manifest already exists: ${manifest.runId}`)
  }

  const temporaryPath = temporaryFilePath(location.parent.path, manifest.runId)
  await writePrivateTemporaryFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`)
  try {
    await publishExclusive(location.parent, temporaryPath, location.file)
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Run manifest already exists: ${manifest.runId}`)
    }
    throw error
  } finally {
    await unlink(temporaryPath).catch(() => {})
  }
  return location.file
}

export async function appendRunEvent(rootDir, event) {
  const root = await ensurePrivateRoot(rootDir)
  const file = join(root.path, "events.jsonl")
  const expected = await readTargetIdentity(file)
  validateEventTarget(expected)

  let handle
  try {
    handle = await open(
      file,
      constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollowFlag(),
      PRIVATE_FILE_MODE,
    )
    const opened = identityFromStat(await handle.stat())
    validateEventTarget(opened)
    const current = await readTargetIdentity(file)
    assertOpenedTarget(expected, opened, current)
    await handle.chmod(PRIVATE_FILE_MODE)
    const entry = { timestamp: new Date().toISOString(), ...event }
    await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8")
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error("Audit event target must not be a symbolic link")
    throw error
  } finally {
    await handle?.close()
  }
  return file
}

export async function saveReportForRun(rootDir, runId, reportBuilder, options = {}) {
  validateRunId(runId)
  if (typeof reportBuilder !== "function") {
    throw new TypeError("Report builder must be a function")
  }

  const record = await readRunManifestRecord(rootDir, runId)
  const manifest = deepFreeze(record.manifest)
  const reviewedSessionCount = manifest.selectedSessions.length
  const report = await reportBuilder(manifest)
  if (typeof report !== "string") throw new TypeError("Report builder must return a string")

  const savedAtDate = options.now ?? new Date()
  const savedAt = savedAtDate.toISOString()
  const manifestHash = hashValue(record.contents)
  return writeReportPair(rootDir, {
    runId,
    report,
    reviewedSessionCount,
    manifestHash,
    savedAt,
    savedAtDate,
  }, options)
}

export async function readRunManifest(rootDir, runId) {
  return (await readRunManifestRecord(rootDir, runId)).manifest
}

export function hashValue(value) {
  return `sha256:${createHash("sha256").update(String(value ?? "")).digest("hex")}`
}

function summarizeSession({ session, messageCount, transcript }) {
  return {
    id: session.id,
    directoryHash: hashValue(session.directory || ""),
    timeUpdated: session.time?.updated ?? session.time_updated ?? null,
    messageCount,
    transcriptItemCount: transcript.length,
    toolCallCount: transcript.reduce((count, item) => count + item.tools.length, 0),
  }
}

function validateRunId(runId) {
  if (typeof runId !== "string" || isAbsolute(runId) || !RUN_ID_PATTERN.test(runId)) {
    throw new Error("Invalid run ID")
  }
}

async function readRunManifestRecord(rootDir, runId) {
  validateRunId(runId)
  const location = await resolveManifestLocation(rootDir, runId)
  const expected = await readTargetIdentity(location.file)
  if (!expected) throw new Error(`Unknown run ID: ${runId}`)
  if (expected.isSymbolicLink) throw new Error("Run manifest target must not be a symbolic link")
  if (!expected.isFile) throw new Error(`Run manifest is malformed: ${runId}`)

  let contents
  let handle
  try {
    handle = await open(location.file, constants.O_RDONLY | noFollowFlag())
    const opened = identityFromStat(await handle.stat())
    if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error("Run manifest was replaced while being read")
    }
    contents = await handle.readFile("utf8")
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Unknown run ID: ${runId}`)
    if (error?.code === "ELOOP") throw new Error("Run manifest target must not be a symbolic link")
    throw error
  } finally {
    await handle?.close()
  }

  let manifest
  try {
    manifest = JSON.parse(contents)
  } catch {
    throw new Error(`Run manifest is malformed: ${runId}`)
  }
  if (!manifest || typeof manifest !== "object" || manifest.runId !== runId) {
    throw new Error(`Run manifest ID does not match requested run ID: ${runId}`)
  }
  if (!Array.isArray(manifest.selectedSessions)) {
    throw new Error(`Run manifest is malformed: ${runId}`)
  }

  return { contents, manifest }
}

async function resolveManifestLocation(rootDir, runId) {
  const root = await ensurePrivateRoot(rootDir)
  const runs = await ensureSafeChildDirectory(root, "runs")
  const file = resolve(runs.path, `${runId}.json`)
  assertContained(runs.path, file)
  return { file, parent: runs }
}

async function ensurePrivateRoot(rootDir) {
  const path = resolve(rootDir)
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const details = await lstat(path)
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("Audit root must be a directory")
  }
  await chmod(path, PRIVATE_DIRECTORY_MODE)
  return {
    path,
    canonicalPath: await realpath(path),
    dev: details.dev,
    ino: details.ino,
  }
}

async function ensureSafeChildDirectory(root, childName) {
  const path = join(root.path, childName)
  let details = await optionalLstat(path)
  if (details?.isSymbolicLink()) throw new Error(`${childName} must not be a symbolic link`)
  if (!details) {
    try {
      await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE })
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
    }
    details = await lstat(path)
  }
  if (details.isSymbolicLink()) throw new Error(`${childName} must not be a symbolic link`)
  if (!details.isDirectory()) throw new Error(`${childName} must be a directory`)
  await chmod(path, PRIVATE_DIRECTORY_MODE)
  const canonicalPath = await realpath(path)
  assertContained(root.canonicalPath, canonicalPath)
  return { path, canonicalPath, dev: details.dev, ino: details.ino, root, childName }
}

async function writeReportPair(rootDir, reportData, options) {
  const root = await ensurePrivateRoot(rootDir)
  const reports = await ensureSafeChildDirectory(root, "reports")
  const stamp = formatTimestamp(reportData.savedAtDate)

  for (let attempt = 0; attempt < REPORT_CREATE_RETRIES; attempt += 1) {
    const entropy = sanitizeEntropy(
      options.reportEntropy?.(attempt) ?? randomUUID().replaceAll("-", "").slice(0, 16),
    )
    const basename = `${reportData.runId}-${stamp}-${entropy}`
    const filename = `${basename}.md`
    const sidecarFilename = `${basename}.json`
    const absolutePath = join(reports.path, filename)
    const sidecarAbsolutePath = join(reports.path, sidecarFilename)
    const relativePath = join("reports", filename)
    const sidecarRelativePath = join("reports", sidecarFilename)
    assertContained(reports.path, absolutePath)
    assertContained(reports.path, sidecarAbsolutePath)
    if (await readTargetIdentity(absolutePath) || await readTargetIdentity(sidecarAbsolutePath)) {
      continue
    }

    const reportTemporaryPath = temporaryFilePath(reports.path, filename)
    const sidecarTemporaryPath = temporaryFilePath(reports.path, sidecarFilename)
    const sidecar = {
      runId: reportData.runId,
      reportPath: relativePath,
      savedAt: reportData.savedAt,
      reviewedSessionCount: reportData.reviewedSessionCount,
      manifestHash: reportData.manifestHash,
    }
    await writePrivateTemporaryFile(reportTemporaryPath, reportData.report)
    try {
      await writePrivateTemporaryFile(sidecarTemporaryPath, `${JSON.stringify(sidecar, null, 2)}\n`)
      await publishExclusive(reports, reportTemporaryPath, absolutePath)
      try {
        await options.beforeSidecarPublish?.({ sidecarTemporaryPath })
        await publishExclusive(reports, sidecarTemporaryPath, sidecarAbsolutePath)
      } catch (error) {
        await unlinkPublishedLinkIfOwned(reportTemporaryPath, absolutePath)
        if (error?.code === "EEXIST") {
          continue
        }
        throw error
      }
      return {
        absolutePath,
        relativePath,
        sidecarAbsolutePath,
        sidecarRelativePath,
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
    } finally {
      await Promise.all([
        unlink(reportTemporaryPath).catch(() => {}),
        unlink(sidecarTemporaryPath).catch(() => {}),
      ])
    }
  }

  throw new Error("Could not allocate a unique report path")
}

async function publishExclusive(parent, temporaryPath, targetPath) {
  await revalidateChildDirectory(parent)
  assertContained(parent.path, targetPath)
  await link(temporaryPath, targetPath)
}

async function unlinkPublishedLinkIfOwned(temporaryPath, targetPath) {
  const temporary = await readTargetIdentity(temporaryPath)
  const target = await readTargetIdentity(targetPath)
  if (
    temporary?.isFile &&
    target?.isFile &&
    !target.isSymbolicLink &&
    temporary.dev === target.dev &&
    temporary.ino === target.ino
  ) {
    await unlink(targetPath)
  }
}

async function revalidateChildDirectory(child) {
  const details = await lstat(child.path)
  if (details.isSymbolicLink()) throw new Error(`${child.childName} must not be a symbolic link`)
  if (!details.isDirectory()) throw new Error(`${child.childName} must be a directory`)
  if (details.dev !== child.dev || details.ino !== child.ino) {
    throw new Error(`${child.childName} directory was replaced before publication`)
  }
  const canonicalPath = await realpath(child.path)
  if (canonicalPath !== child.canonicalPath) {
    throw new Error(`${child.childName} directory was replaced before publication`)
  }
  assertContained(child.root.canonicalPath, canonicalPath)
}

function validateEventTarget(identity) {
  if (!identity) return
  if (identity.isSymbolicLink) throw new Error("Audit event target must not be a symbolic link")
  if (!identity.isFile) throw new Error("Audit event target must be a regular file")
  if (identity.nlink !== 1) throw new Error("Audit event target must not have hard links")
}

function assertOpenedTarget(expected, opened, current) {
  validateEventTarget(current)
  if (!current || opened.dev !== current.dev || opened.ino !== current.ino) {
    throw new Error("Audit event target was replaced while being opened")
  }
  if (expected && (expected.dev !== opened.dev || expected.ino !== opened.ino)) {
    throw new Error("Audit event target was replaced while being opened")
  }
}

async function readTargetIdentity(path) {
  const details = await optionalLstat(path)
  return details ? identityFromStat(details) : null
}

function identityFromStat(details) {
  return {
    dev: details.dev,
    ino: details.ino,
    nlink: details.nlink,
    isFile: details.isFile(),
    isSymbolicLink: details.isSymbolicLink(),
  }
}

function assertContained(canonicalParent, candidate) {
  const resolvedCandidate = resolve(candidate)
  if (!resolvedCandidate.startsWith(`${canonicalParent}${sep}`)) {
    throw new Error("Persistence path escapes the audit root")
  }
}

async function optionalLstat(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

function noFollowFlag() {
  return constants.O_NOFOLLOW ?? 0
}

function formatTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-")
}

function sanitizeEntropy(value) {
  const entropy = String(value).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32)
  return entropy || randomUUID().replaceAll("-").slice(0, 16)
}

function temporaryFilePath(parentPath, label) {
  return join(parentPath, `.${label}.${randomUUID().replaceAll("-", "")}.tmp`)
}

async function writePrivateTemporaryFile(path, contents) {
  let handle
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      PRIVATE_FILE_MODE,
    )
    await handle.writeFile(contents, "utf8")
    await handle.sync()
    await handle.chmod(PRIVATE_FILE_MODE)
  } catch (error) {
    await unlink(path).catch(() => {})
    throw error
  } finally {
    await handle?.close()
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}
