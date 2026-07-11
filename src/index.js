// Tested by test/plugin.test.mjs; core behavior is covered by test/core.test.mjs.
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { tool } from "@opencode-ai/plugin"

import {
  buildReflectionPrompt,
  extractTranscript,
  formatSessionCandidatesForConfirmation,
  formatReflectionReport,
  selectSessionsByName,
  selectSessionsForReview,
} from "./core.js"
import {
  appendRunEvent,
  attachReportToRun,
  buildRunManifest,
  createRunId,
  writeRunManifest,
} from "./logging.js"

const LOG_DIR = join(homedir(), ".config", "opencode", "session-reflections")
const REPORT_DIR = join(LOG_DIR, "reports")

const plugin = async ({ client }) => {
  return {
    tool: {
      session_reflection: tool({
        description:
          "Collect OpenCode session conversation content for qualitative reflection, or save the final reflection report locally.",
        args: {
          action: tool.schema.enum(["collect", "save"]).default("collect"),
          limit: tool.schema.number().int().min(1).max(30).default(8),
          sessionID: tool.schema.string().optional(),
          sessionName: tool.schema.string().optional(),
          runID: tool.schema.string().optional(),
          analysis: tool.schema.string().optional(),
        },
        async execute(args, context) {
          if (args.action === "save") {
            if (!args.analysis?.trim()) {
              return "Save failed: analysis must not be empty."
            }

            const report = formatReflectionReport({
              reviewedSessionCount: 0,
              model: context.agent,
              analysis: args.analysis,
            })
            const { absolutePath, relativePath } = await writeReport(report)

            if (args.runID) {
              await attachReportToRun(LOG_DIR, args.runID, relativePath)
              await appendRunEvent(LOG_DIR, {
                type: "save",
                runId: args.runID,
                reportPath: relativePath,
              })
            }

            return {
              title: "Session reflection saved",
              output: `Saved reflection report: ${absolutePath}`,
            }
          }

          const requestedSessionName = args.sessionName?.trim()

          // When a specific session id is requested, fetch it directly instead of
          // paging through the full list — avoids the SDK return-window limitation.
          let selected
          if (args.sessionID) {
            const res = await client.session.get({ path: { id: args.sessionID } })
            const session = res && typeof res === "object" && "data" in res ? res.data : res
            if (!session || session.error) return `No session found: ${args.sessionID}`
            selected = [session]
          } else {
            // client.session.list() only exposes `directory` in its SDK type but
            // the server accepts `limit`, `start`, and `search`. Use _client.get()
            // to pass these params directly and page through the full history.
            const sessions = requestedSessionName
              ? await listSessionsPaged(client._client, { search: requestedSessionName })
              : await listSessionsPaged(client._client, {})
            selected = requestedSessionName
              ? selectSessionsByName(sessions, requestedSessionName)
              : selectSessionsForReview(sessions, { limit: args.limit })
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

          const prompt = buildReflectionPrompt({ sessions: enriched })
          const manifest = buildRunManifest({
            runId,
            startedAt,
            action: "collect",
            limit: args.limit,
            requestedSessionId: args.sessionID ?? null,
            selectedSessions: manifestSessions,
            skippedSessions,
            prompt,
            errors: [],
          })

          await writeRunManifest(LOG_DIR, manifest)
          await appendRunEvent(LOG_DIR, {
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

export default plugin

async function writeReport(report) {
  await mkdir(REPORT_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const filename = `${stamp}.md`
  const absolutePath = join(REPORT_DIR, filename)
  await writeFile(absolutePath, report, "utf8")
  return { absolutePath, relativePath: join("reports", filename) }
}

function unwrapSdkArray(response, label) {
  const data = response && typeof response === "object" && "data" in response ? response.data : response
  if (!Array.isArray(data)) {
    throw new TypeError(`${label} did not return an array`)
  }
  return data
}

/**
 * Fetch all sessions by paging through GET /session.
 *
 * The SDK client interceptor auto-injects `?directory=<cwd>` on every request,
 * which causes the server to filter sessions to the current workspace only.
 * Setting `x-opencode-directory: ""` in the request headers causes the
 * interceptor's pick() function to return undefined (empty string is falsy),
 * so it skips the injection and the server returns sessions from all workspaces.
 *
 * @param {object} rawClient - client._client from the plugin context
 * @param {object} opts
 * @param {string} [opts.search]   - optional server-side title search
 * @param {number} [opts.pageSize] - sessions per request (default 200)
 */
async function listSessionsPaged(rawClient, { search, pageSize = 200 } = {}) {
  // Empty string suppresses the directory interceptor (pick("", dir) → undefined).
  const headers = { "x-opencode-directory": "" }

  const all = []
  let start = 0
  while (true) {
    const query = { limit: pageSize, start }
    if (search) query.search = search
    const res = await rawClient.get({ url: "/session", query, headers })
    if (res?.error) throw new Error(`GET /session failed: ${JSON.stringify(res.error)}`)
    const page = Array.isArray(res?.data) ? res.data : []
    if (page.length === 0) break
    all.push(...page)
    if (page.length < pageSize) break
    start += pageSize
  }
  return all
}
