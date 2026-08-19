---
description: Review recent OpenCode sessions for user communication gaps, recurring OpenCode mistakes, and plugin/skill opportunities.
---

Use the `session_reflection` tool with `action: "collect"` to collect recent session content.

Arguments:
- If the user provides a number, use it as `limit`.
- If the user provides a session id, pass it as `sessionID`.
- If the user provides other text, pass it as `sessionName`.
- If the user asks for a time range, map it to `period` (today, yesterday, last3days, last7days, last30days, thisWeek, lastWeek, thisMonth, lastMonth) or `since` (an ISO date like "2026-08-10"). Pass only one of `period`/`since`.
- Otherwise use `limit: 8`.
- If `sessionName` returns multiple candidates, show the candidate list to the user and ask which `sessionID` to use.

After the tool returns the reflection prompt, answer it directly in English. Focus on:
- Developer-to-agent communication gaps
- Recurring OpenCode mistakes
- Repeated workflows that should become an open-source plugin, skill, command, or AGENTS.md rule

For every recommendation, analyze both:
- Feasibility: SDK/API support, implementation complexity, privacy risk, maintenance burden, and false-positive risk.
- Value: frequency, severity, time saved, error prevention, confidence improvement, and usefulness to other OpenCode users.

Before recommending any new plugin, skill, command, or rule, perform a prior-art lookup against the official OpenCode repository, official OpenCode docs/ecosystem, awesome-opencode/community lists, npm packages, and GitHub search results. Prefer reusing, configuring, extending, or forking existing work when it covers most of the need. Only recommend a new build when prior art is insufficient.

Use concrete evidence from session ids. Do not invent patterns without evidence.

The collect result starts with `Run ID: <id>`. Preserve that run id.

After presenting the report, ask whether to save it. If the user says to save, call `session_reflection` with `action: "save"`, pass the preserved `runID`, and put the final report markdown in `analysis`.

$ARGUMENTS
