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

## Installation

```bash
npm install -g opencode-session-reflection
```

Then add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-session-reflection"]
}
```

Restart OpenCode after changing the config.

This registers the `session_reflection` tool. OpenCode loads slash commands from command directories, so the packaged `commands/session-review.md` file is not assumed to be auto-installed by npm plugin loading.

## Local Development Deploy

For local development, this repository also includes a deploy helper that copies the plugin and slash command into your global OpenCode config directory. No config changes are needed for this path because OpenCode auto-discovers plugins in `~/.config/opencode/plugins/` and commands in `~/.config/opencode/command/`.

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

**Remove the local development deployment:**

```sh
npm run undeploy
```

Then restart OpenCode.

The deploy script:
- Copies `src/core.js` and `src/logging.js` to `~/.config/opencode/plugins/` as `session-reflection-core.mjs` and `session-reflection-logging.mjs` (`.mjs` keeps them from being auto-discovered as independent plugins)
- Copies and patches `src/index.js` to `~/.config/opencode/plugins/session-reflection.js`, rewriting its internal import paths to match the deployed filenames (`.js` is required — OpenCode's local plugin auto-discovery only scans `*.js` and `*.ts`)
- Copies `commands/session-review.md` to `~/.config/opencode/command/session-review.md`
- Removes legacy entry-points (`session-reflection.mjs`, `session-reflection.ts`) if present, to prevent double-loading

## Usage

If you used `npm run deploy`, review the most recent sessions with the slash command:

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

## How Session Retrieval Works

Sessions are fetched through `client._client.get("/session")` because the SDK's `client.session.list()` only exposes `directory` in its TypeScript type. The plugin pages through all sessions in batches of 200, then does all filtering client-side.

**sessionName search** fetches all sessions, then filters client-side via `selectSessionsByName` — exact normalized title match first, then `includes` fallback. To search across all workspaces, the plugin passes `x-opencode-directory: ""` in the request headers, which causes the SDK interceptor's `pick()` function to return `undefined` and skip the directory injection.

**sessionID lookup** calls `client.session.get({ path: { id } })` directly, bypassing the session list entirely.

**Default (limit N)** fetches all sessions with the same directory suppression, then applies `selectSessionsForReview` for recency-based client-side slicing.

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

Inspect the npm package contents before publishing:

```sh
npm pack --dry-run
```

## Release Smoke Test

Before publishing, test the packed artifact instead of the source tree or npm cache.

Create a throwaway app and install the generated tarball:

```sh
SMOKE=/tmp/opencode-session-reflection-smoke
rm -rf "$SMOKE"
mkdir -p "$SMOKE/app" "$SMOKE/xdg/opencode" "$SMOKE/home"
TARBALL=$(npm pack --silent)
npm install --prefix "$SMOKE/app" "$(pwd)/$TARBALL"
node -p "require('$SMOKE/app/node_modules/opencode-session-reflection/package.json').version"
```

Create an isolated OpenCode config at `$SMOKE/xdg/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "file:///tmp/opencode-session-reflection-smoke/app/node_modules/opencode-session-reflection/src/index.js"
  ]
}
```

Verify OpenCode loads only the tarball-installed plugin:

```sh
XDG_CONFIG_HOME="$SMOKE/xdg" HOME="$SMOKE/home" opencode debug config
```

The `plugin_origins` output must point to:

```text
file:///tmp/opencode-session-reflection-smoke/app/node_modules/opencode-session-reflection/src/index.js
```

Run an isolated plugin-tool smoke:

```sh
XDG_CONFIG_HOME="$SMOKE/xdg" HOME="$SMOKE/home" opencode
```

Ask OpenCode to call `session_reflection` with `action=collect` and `limit=1`.
The test passes when the tool returns without a plugin import/load error. The
isolated `HOME` may have no useful historical sessions, so an empty or minimal
collection is not automatically a plugin failure.

The `/session-review` slash command is a separate command-directory feature.
This npm smoke verifies the plugin tool. To test the slash command, use
`npm run deploy` or copy `commands/session-review.md` to
`~/.config/opencode/command/session-review.md`, then restart OpenCode.

## Publishing

Publish checklist:

```sh
npm test
npm run check:import
npm pack --dry-run
npm pack
```

`npm publish` runs `npm test && npm run check:import` automatically through `prepublishOnly`.

Do not publish automatically from an agent run. Stop and wait for an explicit
human confirmation such as `publish`, `发布`, or `发`, then run:

```sh
npm publish
```

After publish, clear OpenCode's npm plugin cache and test the real npm package
path:

```sh
rm -rf ~/.cache/opencode/packages/opencode-session-reflection \
  ~/.cache/opencode/packages/opencode-session-reflection@latest
```

Use the npm package name in OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-session-reflection"]
}
```

Restart OpenCode and call `session_reflection` again. If a local development
deployment is still present at `~/.config/opencode/plugins/session-reflection.js`,
remove the local plugin files or OpenCode will load the package and the local
auto-discovered plugin at the same time:

```sh
rm -f ~/.config/opencode/plugins/session-reflection.js \
  ~/.config/opencode/plugins/session-reflection-core.mjs \
  ~/.config/opencode/plugins/session-reflection-logging.mjs \
  ~/.config/opencode/plugins/session-reflection.mjs \
  ~/.config/opencode/plugins/session-reflection.ts
```

## More OpenCode Tools

| Tool | Description |
|------|-------------|
| [opencode-db-clean](https://github.com/chncaesar/opencode-db-clean) | Reclaim disk space from bloated SQLite databases |
| [opencode-waitfor](https://github.com/chncaesar/opencode-waitfor) | `wait_for` for HTTP/TCP/command readiness checks |
| [opencode-session-reflection](https://github.com/chncaesar/opencode-session-reflection) | Qualitative review of past coding sessions |
| [opencode-fleet](https://github.com/chncaesar/opencode-fleet) | Multi-node remote OpenCode orchestration |

## License

MIT
