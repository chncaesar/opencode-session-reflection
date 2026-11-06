// Tested by test/plugin.test.mjs; core behavior is covered by test/core.test.mjs.
import { tool } from "@opencode-ai/plugin"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"

import {
  buildReflectionPrompt,
  buildPromptAnalysis,
  extractTranscript,
  formatSessionCandidatesForConfirmation,
  formatReflectionReport,
  MAX_EVIDENCE_CHARS,
  parseSinceDate,
  readPromptDumps,
  readSessionTokenStats,
  resolvePeriodSince,
  selectSessionsByName,
  selectSessionsForReview,
} from "./core.js"
import {
  appendRunEvent,
  buildRunManifest,
  createRunId,
  resolveLogDir,
  resolveReflectionDbPath,
  resolveOpenCodeDbPath,
  openReflectionDb,
  saveReportForRun,
  writeRunManifest,
} from "./logging.js"

const DEFAULT_MAX_SESSION_PAGES = 100
const SAVE_AUDIT_WARNING = "The report was saved, but its audit event could not be recorded."
const EVIDENCE_BUDGET_ENV = "SESSION_REFLECTION_EVIDENCE_BUDGET"

// Close handles for the DB opened by each `plugin()` call, so the V2 `setup`
// cleanup can release it without changing the V1 hooks object shape.
const closers = new WeakMap()

const plugin = async ({ client, _logDir } = {}) => {
  const logDir = _logDir ?? resolveLogDir()

  // Initialise the reflection DB once at plugin startup (sync, fast).
  // mkdirSync ensures the directory exists before DatabaseSync opens the file.
  mkdirSync(logDir, { recursive: true })
  const dbPath = resolveReflectionDbPath(logDir)
  const db = openReflectionDb(dbPath)

  const insertDump = db.prepare(`
    INSERT OR REPLACE INTO prompt_dump
      (session_id, seq, created_at, model, system_total_chars, system_full)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const nextSeq = db.prepare(`
    SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
    FROM prompt_dump
    WHERE session_id = ?
  `)

  const hooks = {
    // ── Capture the full system prompt on every real LLM request ─────────
    "experimental.chat.system.transform": async (input, output) => {
      // Skip Agent.generate path which has no sessionID
      if (!input.sessionID) return

      const seq = nextSeq.get(input.sessionID).next_seq
      const systemFull = [...output.system]
      const totalChars = systemFull.reduce((sum, s) => sum + s.length, 0)
      const modelId = input.model?.id ?? input.model ?? "unknown"

      try {
        insertDump.run(
          input.sessionID,
          seq,
          Date.now(),
          modelId,
          totalChars,
          JSON.stringify(systemFull),
        )
      } catch (err) {
        // Non-fatal: log and continue. Never block the LLM request.
        console.error("[session-reflection] prompt_dump write failed:", err?.message)
      }
    },

    tool: {
      session_reflection: tool({
        description:
          "Collect OpenCode session conversation content for qualitative reflection, save the final reflection report locally, or analyze the system prompt and context composition for the current session.",
        args: {
          action: tool.schema.enum(["collect", "save", "analyze_prompts"]).default("collect"),
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
          mode: tool.schema.enum(["latest", "trend"]).default("latest"),
        },
        async execute(args, context) {
          if (args.action === "analyze_prompts") {
            const targetSessionId = args.sessionID ?? context.sessionID
            if (!targetSessionId) {
              return "analyze_prompts requires a sessionID. Pass sessionID explicitly or run inside an active session."
            }

            const dumps = readPromptDumps(db, targetSessionId, args.mode)

            if (dumps.length === 0) {
              return `No prompt dump data found for session ${targetSessionId}. The session may not have made any LLM requests yet, or it predates the prompt dump feature.`
            }

            let tokenStats = { total_input: 0, total_output: 0, cache_read: 0, cache_write: 0, top_tool_outputs: [] }
            let ocDb
            try {
              const ocDbPath = resolveOpenCodeDbPath()
              ocDb = new DatabaseSync(ocDbPath, { readonly: true })
              tokenStats = readSessionTokenStats(ocDb, targetSessionId)
            } catch (err) {
              // Non-fatal: token stats unavailable, continue with system prompt only
              console.error("[session-reflection] opencode.db read failed:", err?.message)
            } finally {
              ocDb?.close()
            }

            const analysisPrompt = buildPromptAnalysis({
              dumps,
              tokenStats,
              mode: args.mode,
              directory: context.directory,
            })

            return {
              title: "Context analysis prompt",
              output: analysisPrompt,
              metadata: {
                sessionID: targetSessionId,
                mode: args.mode,
                dumpCount: dumps.length,
              },
            }
          }

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
  closers.set(hooks, () => db.close())
  return hooks
}

// ── V2 (OpenCode >= 2.x) entry point ────────────────────────────────────────
// The V2 loader requires a default export with `id` and `setup(ctx)` and ignores
// `server`. `setup` reuses the V1 `plugin()` logic unchanged by handing it a
// facade `client` built on `ctx.session.*`, then registers its hooks/tool via
// the V2 registration APIs. Nothing in V2 is registered twice with V1: a host
// uses exactly one of `setup` / `server`.

const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["collect", "save", "analyze_prompts"], default: "collect" },
    limit: { type: "integer", minimum: 1, maximum: 30, default: 8 },
    evidenceBudget: { type: "integer", minimum: 1 },
    sessionID: { type: "string" },
    sessionName: { type: "string" },
    period: {
      type: "string",
      enum: [
        "today", "yesterday", "last3days", "last7days", "last30days",
        "thisWeek", "lastWeek", "thisMonth", "lastMonth",
      ],
    },
    since: { type: "string" },
    runID: { type: "string" },
    analysis: { type: "string" },
    mode: { type: "string", enum: ["latest", "trend"], default: "latest" },
  },
}

const V2_LIST_PAGE_SIZE = 50

async function setup(ctx) {
  const client = buildV2Client(ctx)
  const hooks = await plugin({ client, directory: ctx.location?.directory })
  const registrations = []

  try {
    const systemTransform = hooks["experimental.chat.system.transform"]
    registrations.push(
      await ctx.session.hook("context", (input) => {
        // V2 `system` is an array of { type: "text", text } parts; V1 used strings.
        const output = { system: (input.system ?? []).map((part) => (typeof part === "string" ? part : part?.text ?? "")) }
        return systemTransform({ sessionID: input.sessionID, model: input.model }, output)
      }),
    )

    const definition = hooks.tool.session_reflection
    const argsSchema = tool.schema.object(definition.args)
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "session_reflection",
          description: definition.description,
          input: TOOL_INPUT_SCHEMA,
          options: { codemode: false },
          execute: async (rawArgs, context) => {
            const args = argsSchema.parse(rawArgs ?? {})
            const result = await definition.execute(args, {
              sessionID: context.sessionID,
              agent: context.agent,
              directory: ctx.location?.directory,
            })
            if (typeof result === "string") return { content: result }
            const { title, output, metadata } = result
            return { content: output, metadata: { ...(title ? { title } : {}), ...metadata } }
          },
        })
      }),
    )
  } catch (err) {
    await disposeAll(registrations, closers.get(hooks))
    throw err
  }

  return () => disposeAll(registrations, closers.get(hooks))
}

async function disposeAll(registrations, closeDb) {
  for (const registration of registrations.reverse()) {
    try {
      await registration.dispose()
    } catch (err) {
      console.error("[session-reflection] dispose failed:", err?.message)
    }
  }
  try {
    closeDb?.()
  } catch {
    // already closed
  }
}

/**
 * Adapt a V2 plugin context into the V1 `client` surface that `plugin()` uses:
 * `session.get`, `session.messages` and `_client.get("/experimental/session")`.
 * Note: V2 exposes only the model context window (`session.context`), so
 * messages dropped by compaction are not visible to transcript extraction.
 */
function buildV2Client(ctx) {
  return {
    session: {
      get: async ({ path }) => {
        try {
          return { data: toV1Session(await ctx.session.get({ sessionID: path.id })) }
        } catch (error) {
          return { data: undefined, error }
        }
      },
      messages: async ({ path }) => {
        const [entries, session] = await Promise.all([
          ctx.session.context({ sessionID: path.id }),
          ctx.session.get({ sessionID: path.id }),
        ])
        return { data: toV1Messages(entries, session) }
      },
    },
    _client: {
      get: async ({ url, query = {} }) => {
        if (url !== "/experimental/session") throw new Error(`Unsupported request: ${url}`)
        const input = query.cursor
          ? { cursor: query.cursor, limit: V2_LIST_PAGE_SIZE }
          : { limit: V2_LIST_PAGE_SIZE, ...(query.search ? { search: query.search } : {}) }
        const page = await ctx.session.list(input)
        const entries = Array.isArray(page) ? page : page?.data
        if (!Array.isArray(entries)) return { error: new Error("invalid session page") }
        const next = Array.isArray(page) ? undefined : page.cursor?.next
        return {
          data: entries.map(toV1Session),
          response: { headers: new Headers(next ? { "x-next-cursor": String(next) } : {}) },
        }
      },
    },
  }
}

function toV1Session(info) {
  if (!info || typeof info !== "object") return info
  const directory = info.directory ?? info.location?.directory
  return directory === undefined ? info : { ...info, directory }
}

function toV1Messages(entries, session) {
  return entries.flatMap((entry) => {
    const info = {
      id: entry.id,
      role: entry.type === "assistant" ? "assistant" : "user",
      sessionID: session?.id,
      time: { created: entry.time?.created },
    }
    if (entry.type === "assistant") {
      const parts = (entry.content ?? []).map((part) =>
        part.type === "tool"
          ? { type: "tool", tool: part.name, state: part.state }
          : { type: part.type, text: part.text },
      )
      return [{ info, parts }]
    }
    if (entry.type === "user") {
      return [{ info, parts: [{ type: "text", text: entry.text ?? "" }] }]
    }
    // Skill/synthetic/shell/location entries are system-generated, not developer speech.
    return []
  })
}

// OpenCode >= 2.x loads plugins through `setup`; 1.x loads V1 plugin modules
// through `server`. Both need `id`. A legacy default-exported function is still
// supported by 1.x, but it then treats *every* exported function as an
// independent legacy plugin, which would incorrectly invoke `listSessionsPaged`
// below with the plugin input.
export default {
  id: "opencode-session-reflection",
  server: plugin,
  setup,
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
