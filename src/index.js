// Tested by test/plugin.test.mjs; core behavior is covered by test/core.test.mjs.
import { tool } from "@opencode-ai/plugin"

import {
  buildReflectionPrompt,
  extractTranscript,
  formatSessionCandidatesForConfirmation,
  formatReflectionReport,
  MAX_EVIDENCE_CHARS,
  parseSinceDate,
  resolvePeriodSince,
  selectSessionsByName,
  selectSessionsForReview,
} from "./core.js"
import {
  appendRunEvent,
  buildRunManifest,
  createRunId,
  resolveLogDir,
  saveReportForRun,
  writeRunManifest,
} from "./logging.js"

const DEFAULT_MAX_SESSION_PAGES = 100
const SAVE_AUDIT_WARNING = "The report was saved, but its audit event could not be recorded."
const EVIDENCE_BUDGET_ENV = "SESSION_REFLECTION_EVIDENCE_BUDGET"

const plugin = async ({ client, _logDir } = {}) => {
  const logDir = _logDir ?? resolveLogDir()
  return {
    tool: {
      session_reflection: tool({
        description:
          "Collect OpenCode session conversation content for qualitative reflection, or save the final reflection report locally.",
        args: {
          action: tool.schema.enum(["collect", "save"]).default("collect"),
          limit: tool.schema.number().int().min(1).max(30).default(8),
          evidenceBudget: tool.schema.number().int().min(1).optional(),
          sessionID: tool.schema.string().optional(),
          sessionName: tool.schema.string().optional(),
          period: tool.schema.enum([
            "today",
            "yesterday",
            "last3days",
            "last7days",
            "last30days",
            "thisWeek",
            "lastWeek",
            "thisMonth",
            "lastMonth",
          ]).optional(),
          since: tool.schema.string().optional(),
          runID: tool.schema.string().optional(),
          analysis: tool.schema.string().optional(),
        },
        async execute(args, context) {
          if (args.action === "save") {
            if (!args.analysis?.trim()) {
              return "Save failed: analysis must not be empty."
            }
            if (!args.runID) {
              return "Save failed: runID is required. Collect sessions before saving a report."
            }

            const { absolutePath, relativePath } = await saveReportForRun(
              logDir,
              args.runID,
              (manifest) => formatReflectionReport({
                runId: manifest.runId,
                reviewedSessionCount: manifest.selectedSessions.length,
                agent: context.agent,
                analysis: args.analysis,
              }),
            )
            let auditWarning
            try {
              await appendRunEvent(logDir, {
                type: "save",
                runId: args.runID,
                reportPath: relativePath,
              })
            } catch {
              auditWarning = SAVE_AUDIT_WARNING
            }

            return {
              title: "Session reflection saved",
              output: auditWarning
                ? `Saved reflection report: ${absolutePath}\nWarning: ${auditWarning}`
                : `Saved reflection report: ${absolutePath}`,
              ...(auditWarning ? { metadata: { auditWarning } } : {}),
            }
          }

          const requestedSessionName = args.sessionName?.trim()

          if (args.period && args.since) {
            return "period and since are mutually exclusive. Choose one time filter."
          }

          let since
          if (args.period) {
            since = resolvePeriodSince(args.period)
            if (since === undefined) return `Unknown period: ${args.period}`
          } else if (args.since) {
            try {
              since = parseSinceDate(args.since)
            } catch {
              return `Invalid since value: ${args.since}`
            }
          }

          let selected
          if (args.sessionID) {
            const res = await client.session.get({ path: { id: args.sessionID } })
            const session = res && typeof res === "object" && "data" in res ? res.data : res
            if (!session || session.error) return `No session found: ${args.sessionID}`
            selected = [session]
          } else if (requestedSessionName) {
            const sessions = await listSessionsPaged(client._client, { search: requestedSessionName })
            selected = selectSessionsByName(excludeCurrentSession(sessions, context.sessionID), requestedSessionName)
          } else {
            const sessions = await listSessionsPaged(client._client)
            selected = selectSessionsForReview(excludeCurrentSession(sessions, context.sessionID), {
              limit: args.limit,
              since,
            })
          }

          if (selected.length === 0) {
            if (args.sessionID) return `No session found: ${args.sessionID}`
            if (requestedSessionName) return `No session found by name: ${requestedSessionName}`
            return "No OpenCode sessions found for reflection."
          }

          if (!args.sessionID && requestedSessionName && selected.length > 1) {
            const candidates = []
            for (const session of selected) {
              const messages = unwrapSdkArray(
                await client.session.messages({ path: { id: session.id } }),
                "session.messages",
              )
              candidates.push({ session, transcript: extractTranscript(messages) })
            }

            return {
              title: "Multiple sessions matched",
              output: formatSessionCandidatesForConfirmation({
                sessionName: requestedSessionName,
                candidates,
              }),
            }
          }

          const runId = createRunId()
          const startedAt = new Date().toISOString()
          const enriched = []
          const manifestSessions = []
          const skippedSessions = []
          for (const session of selected) {
            const messages = unwrapSdkArray(
              await client.session.messages({ path: { id: session.id } }),
              "session.messages",
            )
            const transcript = extractTranscript(messages)

            if (transcript.length === 0) {
              skippedSessions.push({ id: session.id, reason: "empty transcript" })
              continue
            }

            manifestSessions.push({ session, messageCount: messages.length, transcript })
            enriched.push({
              id: session.id,
              title: session.title,
              directory: session.directory,
              transcript,
            })
          }

          if (enriched.length === 0) {
            return "No reviewable OpenCode sessions found for reflection."
          }

          const prompt = buildReflectionPrompt({
            sessions: enriched,
            maxEvidenceChars: resolveEvidenceBudget(args.evidenceBudget),
          })
          const manifest = buildRunManifest({
            runId,
            startedAt,
            action: "collect",
            limit: args.limit,
            requestedSessionId: args.sessionID ?? null,
            period: args.period ?? null,
            since: since ?? null,
            selectedSessions: manifestSessions,
            skippedSessions,
            prompt,
            errors: [],
          })

          await writeRunManifest(logDir, manifest)
          await appendRunEvent(logDir, {
            type: "collect",
            runId,
            sessionCount: enriched.length,
            skippedSessionCount: skippedSessions.length,
          })

          return {
            title: "Session reflection prompt",
            output: `Run ID: ${runId}\n\n${prompt}`,
            metadata: {
              runID: runId,
              reviewedSessionCount: enriched.length,
              sessionIDs: enriched.map((session) => session.id),
            },
          }
        },
      }),
    },
  }
}

// OpenCode loads file plugins as V1 plugin modules: the default export must be
// an object exposing `id` (required for path/file plugins) and a `server`
// function. A legacy default-exported function is still supported, but OpenCode
// then treats *every* exported function as an independent legacy plugin, which
// would incorrectly invoke `listSessionsPaged` below with the plugin input.
export default {
  id: "opencode-session-reflection",
  server: plugin,
}

function unwrapSdkArray(response, label) {
  const data = response && typeof response === "object" && "data" in response ? response.data : response
  if (!Array.isArray(data)) {
    throw new TypeError(`${label} did not return an array`)
  }
  return data
}

/**
 * Fetch all sessions by paging through GET /experimental/session.
 *
 * The SDK client interceptor auto-injects `?directory=<cwd>` on every request,
 * which causes the server to filter sessions to the current workspace only.
 * Setting `x-opencode-directory: ""` in the request headers causes the
 * interceptor's pick() function to return undefined (empty string is falsy),
 * so it skips the injection and the server returns sessions from all workspaces.
 *
 * Session name / title search is done client-side via selectSessionsByName.
 *
 * @param {object} rawClient - client._client from the plugin context
 * @param {number} [options.pageSize] - sessions per request (default 200)
 */
async function listSessionsPaged(
  rawClient,
  { pageSize = 200, maxPages = DEFAULT_MAX_SESSION_PAGES, search } = {},
) {
  const headers = { "x-opencode-directory": "" }
  const sessionsById = new Map()
  const seenCursors = new Set()
  let cursor

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const query = { limit: pageSize }
    if (cursor) query.cursor = cursor
    if (search) query.search = search
    const res = await rawClient.get({ url: "/experimental/session", query, headers })
    if (res?.error) throw stableSessionListError()
    if (!Array.isArray(res?.data)) {
      throw stableSessionListError()
    }
    for (const session of res.data) {
      if (session?.id && !sessionsById.has(session.id)) sessionsById.set(session.id, session)
    }

    const nextCursor = readNextCursor(res)
    if (!nextCursor) return [...sessionsById.values()]
    const cursorKey = String(nextCursor)
    if (seenCursors.has(cursorKey)) {
      throw new Error(`GET /experimental/session returned a repeated cursor: ${nextCursor}`)
    }
    seenCursors.add(cursorKey)
    cursor = nextCursor
  }

  throw new Error(`GET /experimental/session exceeded ${maxPages} pages`)
}

function readNextCursor(response) {
  const headers = response?.response?.headers ?? response?.headers
  if (typeof headers?.get === "function") return headers.get("x-next-cursor") || undefined
  return headers?.["x-next-cursor"] ?? headers?.["X-Next-Cursor"]
}

function excludeCurrentSession(sessions, currentSessionId) {
  if (!currentSessionId) return sessions
  return sessions.filter((session) => session.id !== currentSessionId)
}

function stableSessionListError() {
  return new Error("Could not load OpenCode sessions. Please try again.")
}

function resolveEvidenceBudget(argValue) {
  if (Number.isInteger(argValue) && argValue > 0) return argValue

  const envValue = Number.parseInt(process.env[EVIDENCE_BUDGET_ENV], 10)
  if (Number.isInteger(envValue) && envValue > 0) return envValue

  return MAX_EVIDENCE_CHARS
}
