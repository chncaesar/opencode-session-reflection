# AGENTS.md — opencode-session-reflection

## Project Overview

An OpenCode plugin that provides qualitative review of past coding-agent sessions.
It exposes a `session_reflection` custom tool and a `/session-review` slash command.

## Tech Stack

- Runtime: Node.js (ESM, `"type": "module"`)
- No build step — source files are plain `.js`
- Test runner: `node --test` (built-in)
- Deploy: `npm run deploy` copies source to `~/.config/opencode/plugins/`

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
```

## Commands

```sh
npm install       # install dependencies
npm test          # run all tests (must pass before deploy)
npm run check:import  # verify plugin entrypoint loads correctly
npm run deploy    # deploy to ~/.config/opencode/plugins/ (then restart OpenCode)
npm run undeploy  # remove deployed files
```

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

## Deploy Script Internals

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
