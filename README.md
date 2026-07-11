# OpenCode Session Reflection

OpenCode Session Reflection is an OpenCode plugin for qualitative review of past coding-agent sessions. It helps developers identify communication gaps, recurring agent mistakes, and open-source plugin/skill/command opportunities from actual session evidence.

The plugin reads sessions through the OpenCode SDK. It does not read `opencode.db` directly.

## What It Reviews

- Developer-to-agent communication gaps: unclear goals, missing acceptance criteria, scope ambiguity, missing verification instructions, or unclear discuss-vs-implement intent.
- Recurring OpenCode mistakes: premature stopping, verification gaps, missing global search, editing before reading context, ignoring project rules, or overbuilding.
- Plugin, skill, command, or rule opportunities: repeatable workflows that are feasible, valuable, and general enough for open-source users.

Each recommendation is evaluated for:

- Feasibility: SDK/API support, implementation complexity, privacy risk, maintenance burden, false-positive risk, testability, and brittleness.
- Value: frequency, severity, time saved, error prevention, confidence improvement, and usefulness to other OpenCode users.
- Prior art: whether the official OpenCode repository, OpenCode ecosystem/docs, awesome-opencode/community lists, npm, or GitHub already contain a similar solution that should be reused, configured, extended, or forked instead of rebuilt.

## Local Deploy (Recommended)

This plugin is designed to be deployed directly to your local OpenCode global config directory. No config changes needed — OpenCode auto-discovers plugins in `~/.config/opencode/plugins/`.

**First time setup:**

```sh
npm install
npm run deploy
```

Then restart OpenCode.

**After any code change:**

```sh
npm test       # verify all tests pass
npm run deploy # copy updated files to the plugins directory
```

Then restart OpenCode to reload.

**Remove the plugin:**

```sh
npm run undeploy
```

Then restart OpenCode.

The deploy script:
- Copies `src/core.js` and `src/logging.js` to `~/.config/opencode/plugins/` as `session-reflection-core.mjs` and `session-reflection-logging.mjs` (`.mjs` keeps them from being auto-discovered as independent plugins)
- Copies and patches `src/index.js` to `~/.config/opencode/plugins/session-reflection.js`, rewriting its internal import paths to match the deployed filenames (`.js` is required — OpenCode's local plugin auto-discovery only scans `*.js` and `*.ts`)
- Copies `commands/session-review.md` to `~/.config/opencode/command/session-review.md`
- Removes legacy entry-points (`session-reflection.mjs`, `session-reflection.ts`) if present, to prevent double-loading

## npm Installation (Alternative)

You can also load the plugin from npm. Add it to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-session-reflection"]
}
```

Restart OpenCode after changing the config.

## Usage

Review the most recent sessions:

```text
/session-review
```

Review a fixed number of recent sessions:

```text
/session-review 12
```

Review one known session id:

```text
/session-review <session-id>
```

Review by session name:

```text
/session-review npm whoami ENEEDAUTH 排查
```

When matching by name, the plugin first looks for exact title matches. If there are no exact matches, it falls back to titles that contain the provided text. If multiple sessions match, it returns candidate session ids with short transcript previews; rerun the command with the chosen session id.

The command collects session evidence using the `session_reflection` tool, then asks the current OpenCode model to produce an English report. If you ask to save the report, it is written to:

```text
~/.config/opencode/session-reflections/reports/
```

## Logging

Each `collect` run creates a privacy-safe audit manifest and appends an event record:

```text
~/.config/opencode/session-reflections/
├── reports/
│   └── <run-id>.md or <timestamp>.md
├── runs/
│   └── <run-id>.json
└── events.jsonl
```

The manifest records metadata needed to audit a review:

- `runId`
- selected session ids and titles
- hashed session directory paths
- message counts
- transcript item counts
- tool call counts
- skipped sessions and skip reasons
- prompt hash
- whether prior-art lookup was required
- saved report path, if any
- errors, if any

The default logs do not store raw user prompts, assistant responses, tool outputs, full transcripts, full directory paths, secrets, or the full generated prompt. Directory paths and prompts are represented by SHA-256 hashes.

The plugin records that prior-art lookup was required. It does not independently prove the model completed external research; the final report should state what sources were checked.

## Privacy

The plugin reads local OpenCode session content through the OpenCode SDK and returns a prompt inside the current OpenCode session. Whether that prompt is sent to a model depends on the provider configured in your OpenCode session.

The plugin does not upload session content to any external service on its own.

Audit logs are metadata-only by default. They are written locally under `~/.config/opencode/session-reflections/`.

## Known Limitations

### Session history is capped by the SDK

**Background**

The plugin retrieves session lists through the OpenCode SDK (`client.session.list()`). The only supported query parameter is `directory` — there is no `limit`, `page`, or `cursor` argument. The server decides how many sessions to return, and older sessions beyond that window are silently omitted.

In practice this means `/session-review <name>` or `/session-review <id>` will return "no session found" for sessions that exist in the local database but fall outside the API's return window. With 200+ sessions accumulated over time, sessions older than a few weeks may not be reachable.

**Root cause**

`SessionListData` in the OpenCode SDK (as of v1.17.x) is defined as:

```ts
type SessionListData = {
  query?: { directory?: string };
};
```

No pagination controls are exposed.

**Workaround (current)**

Pass the session id directly with `/session-review <session-id>`. The id bypasses name matching but the underlying `session.list()` call still caps the candidate pool, so even a known id may not be found if the session is old enough.

**Proposal**

Two options, in order of preference:

1. **Wait for SDK pagination support.** If a future SDK version adds `limit`/`after` or cursor-based pagination to `session.list()`, the plugin can page through all sessions. This keeps the implementation clean and SDK-compatible.

2. **Direct SQLite fallback.** As a degraded-mode option, the plugin could detect the "not found" case and re-query `~/.local/share/opencode/opencode.db` directly (`SELECT id, title FROM session WHERE ...`). This reaches the full history regardless of API limits, but couples the plugin to the internal database schema and breaks if the schema changes. Should only be used as a last resort.

The recommended path is option 1. The limitation should be surfaced to the user with a clear error message when a session id or name is not found (e.g. "Session not found — it may be outside the SDK's return window. Try `/session-review <session-id>` with a recent session, or wait for SDK pagination support.").

## Development

Install dependencies:

```sh
npm install
```

Run tests:

```sh
npm test
```

Verify the plugin entrypoint imports correctly:

```sh
npm run check:import
```

## License

MIT
