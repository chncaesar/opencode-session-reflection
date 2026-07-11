// Tested by test/core.test.mjs.
const DEFAULT_LIMIT = 8
const MAX_TEXT_CHARS = 1800
const MAX_TRANSCRIPT_ITEMS = 80
const MAX_CANDIDATE_PREVIEW_ITEMS = 3
const MAX_CANDIDATE_PREVIEW_CHARS = 160

export function selectSessionsForReview(sessions, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? DEFAULT_LIMIT))
  const since = options.since ? Number(options.since) : undefined

  return [...sessions]
    .filter((session) => !since || Number(session.time_updated ?? 0) >= since)
    .sort((a, b) => Number(b.time_updated ?? 0) - Number(a.time_updated ?? 0))
    .slice(0, limit)
}

export function selectSessionsByName(sessions, sessionName) {
  const query = normalizeSessionTitle(sessionName)
  if (!query) return []

  const exact = sessions.filter((session) => normalizeSessionTitle(session.title) === query)
  if (exact.length > 0) return exact

  return sessions.filter((session) => normalizeSessionTitle(session.title).includes(query))
}

export function formatSessionCandidatesForConfirmation({ sessionName, candidates }) {
  const lines = [
    `Multiple sessions matched "${sessionName}". Please choose one and rerun with sessionID:`,
  ]

  candidates.forEach(({ session, transcript }, index) => {
    lines.push("")
    lines.push(`${index + 1}. sessionID: ${session.id}`)
    lines.push(`   title: ${session.title || "(untitled)"}`)
    lines.push(`   time_updated: ${session.time_updated ?? "(unknown)"}`)

    const preview = buildCandidatePreview(transcript)
    if (preview.length === 0) {
      lines.push("   preview: (no transcript text)")
      return
    }

    lines.push("   preview:")
    for (const item of preview) {
      lines.push(`   - ${item.role}: ${item.text}`)
    }
  })

  return lines.join("\n")
}

export function extractTranscript(messages) {
  return messages
    .map((message) => {
      const info = message.info ?? {}
      const role = String(info.role ?? "unknown")
      const parts = message.parts ?? []
      const text = parts
        .map(extractPartText)
        .map((partText) => filterTranscriptText(partText, role))
        .filter(Boolean)
        .join("\n")
        .trim()
      const tools = parts.map(extractToolLabel).filter(Boolean)

      if (!text && tools.length === 0) return undefined

      return {
        role,
        text: truncate(text, MAX_TEXT_CHARS),
        tools,
        timestamp: info.time_created,
      }
    })
    .filter(Boolean)
    .slice(-MAX_TRANSCRIPT_ITEMS)
}

export function buildReflectionPrompt({ sessions }) {
  const sessionBlocks = sessions.map(formatSessionForPrompt).join("\n\n---\n\n")

  return `You are a strict, pragmatic OpenCode session-review analyst. Analyze only the session evidence below. Do not invent patterns that are not supported by the transcript.

Goal: extract three categories of improvement from developer-to-OpenCode conversations, with deep feasibility and value analysis for each category.

### 1. Developer-to-agent communication gaps
Analyze this as a prompt-design issue, not as generic writing advice. Look for patterns where the developer's message caused avoidable ambiguity, rework, overreach, or verification gaps. Diagnose whether the gap is about task framing, scope boundaries, domain context, success criteria, sequencing, permission level, risk tolerance, or handoff quality.

For each communication gap, answer:
- What recurring prompt-design issue appears in the evidence?
- What agent failure did it make more likely?
- Was the missing information knowable by the developer at request time, or should OpenCode have asked a clarifying question?
- What is the smallest prompt template or checklist that would prevent it?
- Feasibility: can this be improved by a reusable command, prompt template, lint-like reminder, or session-start checklist?
- Value: how much rework, mis-scoping, or verification uncertainty would it prevent?

### 2. Recurring OpenCode mistakes
Analyze only mistakes detectable from transcript evidence. Separate actual mistakes from reasonable tradeoffs under uncertainty. Look for agent-side behaviors such as editing before reading context, not grepping for similar occurrences, claiming completion without verification, stopping prematurely, asking permission for actions it can run, ignoring AGENTS.md or user rules, touching unrelated changes, overbuilding, missing producer/consumer audits, or failing to preserve user changes.

For each recurring OpenCode mistake, answer:
- What observable behavior in the transcript proves the mistake?
- What rule, hook, or checklist could detect it before the final answer?
- Is the fix best implemented as a plugin, a skill, an AGENTS.md rule, a command, or model instruction?
- What are the false-positive cases where the behavior is acceptable?
- Feasibility: can OpenCode detect this from hooks, tool calls, session messages, git state, or command output without brittle transcript parsing?
- Value: how severe is the prevented failure and how often does it appear?

### 3. Plugin, skill, command, or rule opportunities
Find repeated workflows and automation points, then draw the automation boundary carefully. Do not recommend a plugin just because something is annoying; recommend a plugin only when OpenCode can observe a reliable trigger and take a safe action. Recommend skills for reasoning workflows, commands for repeatable user-invoked flows, and AGENTS.md rules for durable behavioral constraints.

For each opportunity, answer:
- What repeated situation or failure pattern creates the opportunity?
- What should be automated, and what must stay under human approval?
- What is the open-source generality: is this useful beyond one user's private workflow?
- What prior-art lookup did you perform to avoid reinventing the wheel?
- What similar projects already exist in the official OpenCode repository, official OpenCode ecosystem/docs, awesome-opencode lists, npm packages, or GitHub search results?
- Should the recommendation reuse, configure, fork, extend, or replace an existing solution instead of creating a new one?
- What OpenCode surface would implement it: plugin hook, custom tool, slash command, skill, MCP, or AGENTS.md rule?
- What data is required, and is it available through the SDK without reading private storage directly?
- What are the failure modes, privacy risks, and maintenance costs?
- Feasibility: implementation complexity, API fit, testability, and brittleness.
- Value: time saved, failure prevention, confidence gained, and community usefulness.

Prior-art lookup requirement:
- Before finalizing plugin, skill, command, or rule opportunities, search the official OpenCode repository, official OpenCode docs/ecosystem, awesome-opencode/community lists, npm, and GitHub for similar existing work.
- For each opportunity, include a "Prior art" line with one of: "none found", "reuse existing", "extend existing", "fork existing", or "new build justified".
- If an existing tool covers at least 70% of the need, prefer reuse or extension over a new build.
- If you cannot perform external lookup in the current environment, explicitly mark prior-art confidence as low and do not present the idea as a confirmed new-build opportunity.
- The goal is to avoid reinventing the wheel while still identifying gaps where an open-source plugin would add real value.

Feasibility and Value rubric:
- Feasibility: score 1-5. Consider availability of OpenCode SDK hooks/tools, required data, implementation complexity, privacy risk, maintenance burden, and false-positive risk.
- Value: score 1-5. Consider frequency, severity, time saved, error prevention, confidence improvement, and usefulness to other open-source users.
- Prioritize items with high value and feasible implementation. Reject attractive ideas that lack evidence or would require brittle transcript parsing.

Output requirements:
- Write in English only.
- Start with the 5 most important conclusions.
- Then provide three detailed sections matching the categories above.
- Every claim must cite session_id evidence.
- If evidence is insufficient, write "Insufficient evidence" instead of guessing.
- For open-source readiness, avoid user-specific names, secrets, private hostnames, or local-only assumptions.

Session evidence:

${sessionBlocks}`
}

export function formatReflectionReport({ reviewedSessionCount, model, analysis }) {
  const now = new Date().toISOString()

  return `# OpenCode Session Reflection

- Generated: ${now}
- Reviewed sessions: ${reviewedSessionCount}
- Model: ${model || "current opencode model"}

${analysis.trim()}
`
}

function formatSessionForPrompt(session) {
  const lines = [
    `session_id: ${session.id}`,
    `title: ${session.title || "(untitled)"}`,
    `directory: ${session.directory || "(unknown)"}`,
  ]

  for (const item of session.transcript ?? []) {
    const tools = item.tools.length ? `\n  tools: ${item.tools.join(", ")}` : ""
    const text = item.text ? `\n  text: ${item.text}` : ""
    lines.push(`- ${item.role}:${text}${tools}`)
  }

  return lines.join("\n")
}

function extractPartText(part) {
  if (!part || typeof part !== "object") return ""
  if (typeof part.text === "string") return part.text
  if (typeof part.content === "string") return part.content
  if (part.type === "text" && typeof part.data?.text === "string") return part.data.text
  if (typeof part.data?.text === "string") return part.data.text
  return ""
}

function filterTranscriptText(text, role) {
  if (role !== "assistant") return text

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !isAssistantMetaNarration(line))
    .join("\n")
}

function isAssistantMetaNarration(line) {
  return /^(?:\*\*)?(?:I\s+(?:need|should|will|am|I'm|think|want|can|could|might)|Let me|Now I|Next I|I’ll|I'll)\b/i.test(
    line,
  )
}

function extractToolLabel(part) {
  if (!part || typeof part !== "object") return ""
  const tool = part.tool || part.name || part.data?.tool || part.data?.name
  if (!tool) return ""

  const status = part.state?.status || part.data?.state?.status || part.status
  return status ? `${tool}:${status}` : String(tool)
}

function truncate(value, maxChars) {
  if (!value || value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}...[truncated]`
}

function normalizeSessionTitle(value) {
  return String(value ?? "").trim().toLowerCase()
}

function buildCandidatePreview(transcript) {
  return (transcript ?? [])
    .filter((item) => item.text?.trim())
    .slice(0, MAX_CANDIDATE_PREVIEW_ITEMS)
    .map((item) => ({
      role: item.role,
      text: truncateSingleLine(item.text.trim(), MAX_CANDIDATE_PREVIEW_CHARS),
    }))
}

function truncateSingleLine(value, maxChars) {
  const singleLine = value.replace(/\s+/g, " ")
  if (singleLine.length <= maxChars) return singleLine
  return `${singleLine.slice(0, maxChars)}...`
}
