# npm Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `opencode-session-reflection` into an npm-first OpenCode plugin package without adding a build step.

**Architecture:** Publish the existing ESM JavaScript plugin entrypoint directly from `src/index.js`. Keep local deployment scripts as development-only helpers and make package metadata plus documentation describe npm install as the default user path.

**Tech Stack:** Node.js ESM, npm package metadata, OpenCode plugin API, `node --test`.

## Global Constraints

- Package name remains `opencode-session-reflection`.
- No TypeScript migration and no build step.
- Published files are limited to plugin source, command template, README, and license.
- Local deploy scripts remain available for development.
- Verification before publish includes `npm test`, `npm run check:import`, `npm pack --dry-run`, `npm pack`, and a tarball-installed OpenCode smoke test.
- `npm publish` requires explicit human confirmation in the current turn.
- Post-publish verification clears OpenCode's npm plugin cache and loads the plugin by package name.

---

### Task 1: Package Metadata

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: existing ESM plugin default export from `src/index.js`.
- Produces: npm package metadata and publish-time checks.

- [ ] **Step 1: Update `package.json` metadata**

Set `exports` to object form, add repository metadata, and add `prepublishOnly`.

- [ ] **Step 2: Refresh lockfile metadata**

Run `npm install --package-lock-only` so the root package metadata in `package-lock.json` matches `package.json`.

- [ ] **Step 3: Verify metadata parses**

Run: `node -e "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')); JSON.parse(require('node:fs').readFileSync('package-lock.json', 'utf8'))"`

Expected: command exits successfully with no output.

### Task 2: npm-First Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: package metadata from Task 1.
- Produces: user and agent instructions for installing, developing, and publishing the package.

- [ ] **Step 1: Update README installation flow**

Move npm installation ahead of local deployment and describe local deploy as a development helper.

- [ ] **Step 2: Update AGENTS project guidance**

Document npm distribution as the primary packaging mode and add publish verification commands.

- [ ] **Step 3: Check docs for stale deploy-first wording**

Search for `Local Deploy (Recommended)` and `must pass before deploy` and update any remaining stale wording.

### Task 3: Publish Verification and Smoke Test

**Files:**
- No source files modified.

**Interfaces:**
- Consumes: package metadata and docs from Tasks 1 and 2.
- Produces: verified npm package tarball contents and isolated OpenCode plugin load evidence.

- [ ] **Step 1: Run tests**

Run: `npm test`

Expected: all `node --test` suites pass.

- [ ] **Step 2: Run import validation**

Run: `npm run check:import`

Expected: prints `plugin import ok`.

- [ ] **Step 3: Inspect npm package contents**

Run: `npm pack --dry-run`

Expected: tarball includes `src/`, `commands/`, `README.md`, `LICENSE`, and `package.json`; it excludes tests, scripts, `docs/`, and `node_modules/`.

- [ ] **Step 4: Create the tarball**

Run: `TARBALL=$(npm pack --silent)`

Expected: creates a tarball and stores its filename in `TARBALL`.

- [ ] **Step 5: Install the tarball into a throwaway app**

Run:

```sh
SMOKE=/tmp/opencode-session-reflection-smoke
rm -rf "$SMOKE"
mkdir -p "$SMOKE/app" "$SMOKE/xdg/opencode" "$SMOKE/home"
npm install --prefix "$SMOKE/app" "$(pwd)/$TARBALL"
```

Expected: the package exists at `$SMOKE/app/node_modules/opencode-session-reflection`.

- [ ] **Step 6: Write isolated OpenCode config**

Create `$SMOKE/xdg/opencode/opencode.json` with a `file://` plugin entry pointing at `$SMOKE/app/node_modules/opencode-session-reflection/src/index.js`.

- [ ] **Step 7: Verify plugin origin**

Run: `XDG_CONFIG_HOME="$SMOKE/xdg" HOME="$SMOKE/home" opencode debug config`

Expected: `plugin_origins` points to the throwaway app's installed `src/index.js` and not to this source tree or `~/.cache/opencode/packages`.

- [ ] **Step 8: Run plugin-tool smoke**

Start OpenCode with the same `XDG_CONFIG_HOME` and `HOME`, then call `session_reflection` with `action=collect` and `limit=1`.

Expected: the tool returns without a plugin import/load error. Empty session evidence is acceptable in the isolated `HOME`.

### Task 4: Publish and Post-Publish Verification

**Files:**
- No source files modified.

**Interfaces:**
- Consumes: verified tarball and smoke-test evidence from Task 3.
- Produces: npm registry release and proof that OpenCode can load the package by npm name.

- [ ] **Step 1: Stop for human confirmation**

Do not run `npm publish` until the user explicitly confirms publishing in the current turn.

- [ ] **Step 2: Publish**

Run: `npm publish`

Expected: npm publishes the package and `prepublishOnly` runs `npm test && npm run check:import`.

- [ ] **Step 3: Clear OpenCode npm plugin cache**

Run:

```sh
rm -rf ~/.cache/opencode/packages/opencode-session-reflection \
  ~/.cache/opencode/packages/opencode-session-reflection@latest
```

Expected: OpenCode cannot reuse a stale cached package.

- [ ] **Step 4: Remove local development plugin files if present**

Run:

```sh
rm -f ~/.config/opencode/plugins/session-reflection.js \
  ~/.config/opencode/plugins/session-reflection-core.mjs \
  ~/.config/opencode/plugins/session-reflection-logging.mjs \
  ~/.config/opencode/plugins/session-reflection.mjs \
  ~/.config/opencode/plugins/session-reflection.ts
```

Expected: OpenCode does not double-load the npm package and local auto-discovered plugin.

- [ ] **Step 5: Test the real npm package path**

Configure OpenCode with `plugin: ["opencode-session-reflection"]`, restart OpenCode, and call `session_reflection` with `action=collect` and `limit=1`.

Expected: the tool returns without a plugin import/load error.

## Self-Review

- Spec coverage: package shape, install docs, local development deploy, tarball smoke, publish gate, and post-publish npm-load verification are covered.
- Placeholder scan: no placeholders remain.
- Type consistency: no new runtime interfaces are introduced.
