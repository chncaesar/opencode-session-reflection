# AGENTS.md — opencode-session-reflection

## Project Overview

An OpenCode plugin that provides qualitative review of past coding-agent sessions.
It exposes a `session_reflection` custom tool and a `/session-review` slash command.

## Tech Stack

- Runtime: Node.js (ESM, `"type": "module"`)
- No build step — source files are plain `.js`
- Test runner: `node --test` (built-in)
- Distribution: npm package `opencode-session-reflection`
- Local development deploy: `npm run deploy` copies source to `~/.config/opencode/plugins/`

## Directory Structure

```
src/
  index.js    — plugin entry; registers session_reflection tool
  core.js     — session selection, transcript extraction, prompt building
  logging.js  — run manifest, event log, report writing
commands/
  session-review.md  — slash command definition (loaded by OpenCode)
scripts/
  deploy.js   — copies src/ to ~/.config/opencode/plugins/, rewrites import paths
  undeploy.js — removes deployed files
test/
  core.test.mjs     — unit tests for core.js
  logging.test.mjs  — unit tests for logging.js
  plugin.test.mjs   — integration tests for the tool via mocked client
  scripts.test.mjs  — tests for deploy/undeploy using real functions + tmp dirs
docs/superpowers/
  specs/  — approved design notes for non-trivial changes
  plans/  — implementation plans for non-trivial changes
```

## Commands

```sh
npm install       # install dependencies
npm test          # run all tests
npm run check:import  # verify plugin entrypoint loads correctly
npm run deploy    # deploy to ~/.config/opencode/plugins/ (then restart OpenCode)
npm run undeploy  # remove deployed files
npm pack --dry-run # inspect npm package contents before publish
npm publish       # publish package; prepublishOnly runs tests and import check
```

## npm Package

This repository is packaged as `opencode-session-reflection` for OpenCode's
`plugin` config array:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-session-reflection"]
}
```

The package exports `src/index.js` directly. Do not add a build step unless the
source is migrated away from plain Node-compatible ESM JavaScript.

Published files are controlled by `package.json` `files`. The npm tarball should
include `src/`, `commands/`, `README.md`, `LICENSE`, and `package.json`; it
should not include tests, local deploy scripts, docs, or `node_modules/`.

Before publishing, run:

```sh
npm test
npm run check:import
npm pack --dry-run
npm pack
```

`prepublishOnly` runs `npm test && npm run check:import` automatically during
`npm publish`. The dry-run pack check is still required so the tarball contents
are inspected before release.

Before `npm publish`, also smoke-test the packed tarball from a throwaway app:

```sh
SMOKE=/tmp/opencode-session-reflection-smoke
rm -rf "$SMOKE"
mkdir -p "$SMOKE/app" "$SMOKE/xdg/opencode" "$SMOKE/home"
TARBALL=$(npm pack --silent)
npm install --prefix "$SMOKE/app" "$(pwd)/$TARBALL"
```

Write `$SMOKE/xdg/opencode/opencode.json` with a `file://` plugin entry that
points to `$SMOKE/app/node_modules/opencode-session-reflection/src/index.js`,
then run:

```sh
XDG_CONFIG_HOME="$SMOKE/xdg" HOME="$SMOKE/home" opencode debug config
```

The `plugin_origins` output must point to the throwaway app's installed
`src/index.js`, not this source tree and not `~/.cache/opencode/packages`.

Run one plugin-tool smoke by starting OpenCode with the same `XDG_CONFIG_HOME`
and `HOME`, then ask the agent to call `session_reflection` with
`action=collect` and `limit=1`. The smoke passes when the tool returns without a
plugin import/load error. Empty session evidence is acceptable in the isolated
`HOME`.

Publishing requires explicit human confirmation in the current turn. Do not run
`npm publish` merely because the checklist passed or because the user mentioned
publishing earlier.

After publishing, clear OpenCode's npm plugin cache and test the real npm path:

```sh
rm -rf ~/.cache/opencode/packages/opencode-session-reflection \
  ~/.cache/opencode/packages/opencode-session-reflection@latest
```

Restart OpenCode with `plugin: ["opencode-session-reflection"]` and call
`session_reflection` again. If local development files under
`~/.config/opencode/plugins/session-reflection*.js` or `.mjs` still exist,
remove them before the post-publish smoke to avoid double-loading the plugin.

## Module Boundaries

| File | Responsible for | Not responsible for |
|------|----------------|---------------------|
| `index.js` | Tool registration, arg validation, SDK calls, orchestration | Analysis logic, file I/O details |
| `core.js` | Session selection, transcript extraction, prompt/report formatting | SDK calls, file I/O |
| `logging.js` | Writing manifests, events, reports to disk | SDK calls, analysis |

Keep SDK calls (`client.*`, `_client.*`) in `index.js` only. `core.js` and `logging.js` must be pure functions with no external I/O dependencies so they remain unit-testable without mocks.

## SDK Quirks

### Session list is filtered by workspace directory

The SDK client interceptor automatically injects `?directory=<cwd>` on every
request, so `client.session.list()` only returns sessions from the current
workspace. To search across all workspaces:

- Pass `headers: { "x-opencode-directory": "" }` to `_client.get()`. An empty
  string is falsy in the interceptor's `pick()` function, so injection is skipped
  and the server returns all sessions.
- This is implemented in `listSessionsPaged()` in `src/index.js`.

### SessionListData type is incomplete

`client.session.list()` only exposes `directory` in its TypeScript type, but the
server accepts `limit`, `start`, and `search`. The plugin calls `_client.get()`
directly with these parameters to bypass the type restriction. If the SDK type is
updated in a future version, `listSessionsPaged` can be simplified to use
`client.session.list()`.

### sessionID lookup bypasses the list

Use `client.session.get({ path: { id } })` when a specific session id is known.
This avoids the list entirely and works regardless of session age.

### Response unwrapping

`client.session.list()` and `client.session.messages()` return `{ data: T[] }` wrappers
(SDK `"fields"` response style). Use `unwrapSdkArray(res, label)` in `index.js`
to extract the array and throw a descriptive error on shape mismatch.

## Local Deploy Script Internals

Local deployment is a development helper, not the primary distribution path.
Published npm users should load the plugin through OpenCode's `plugin` config.

- Helper modules (`core.js`, `logging.js`) are deployed as `.mjs` so OpenCode's
  local plugin auto-discovery glob (`*.js`, `*.ts`) does not treat them as
  independent plugin entry points.
- The entry point (`index.js`) is deployed as `.js` — required for auto-discovery.
- Import paths in the deployed entry are rewritten from `./core.js` →
  `./session-reflection-core.mjs` etc. to match the deployed filenames.
- `deploy()` and `undeploy()` are exported functions that accept injectable
  `pluginDir` and `commandDir` parameters so tests can run against a temp dir
  without touching `~/.config/opencode/`.

## Testing

All tests use `node --test` with no external test framework.

- `core.test.mjs` and `logging.test.mjs` test pure functions with no mocks.
- `plugin.test.mjs` tests the tool end-to-end using a `makeClient()` helper
  that mocks `_client.get()` and `session.get()` / `session.messages()`.
- `scripts.test.mjs` imports the real `deploy()` and `undeploy()` functions and
  runs them against a `mkdtemp` directory.

Run `npm test` before every `npm run deploy`. Do not deploy with failing tests.
Before npm publishing, also run `npm run check:import` and `npm pack --dry-run`.
