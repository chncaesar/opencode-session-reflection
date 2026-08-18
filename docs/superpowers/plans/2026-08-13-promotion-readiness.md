# OpenCode Session Reflection Promotion Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a locally verified `0.3.0` release candidate that is safe and credible to promote.

**Architecture:** Keep the existing three-module structure. `index.js` owns OpenCode calls and orchestration, `core.js` owns normalized session evidence and bounded prompt generation, and `logging.js` owns validated private local persistence. Public documentation is updated only after behavior is covered by tests.

**Tech Stack:** Node.js 20+, ESM JavaScript, Node test runner, OpenCode plugin SDK, GitHub Actions, Astro.

## Global Constraints

- Support OpenCode plugin API `1.17.11` and later.
- Use `/experimental/session` cursor pagination; do not read OpenCode SQLite storage.
- Limit session evidence to 48,000 characters.
- Keep metadata audit logging enabled, omit session titles, and use owner-only filesystem permissions.
- Preserve the existing local README commit and unrelated worktree changes.
- Do not push, publish npm, or submit a directory entry without a separate explicit confirmation.

---

### Task 1: Secure Run Manifests And Report Saving

**Files:**
- Modify: `src/logging.js`
- Modify: `src/index.js`
- Modify: `test/logging.test.mjs`
- Modify: `test/plugin.test.mjs`

**Interfaces:**
- Produce `readRunManifest(rootDir, runId)` returning a validated manifest.
- Keep new collect manifests immutable while accepting existing `0.2` manifest shapes when reading.
- Make `saveReportForRun` invoke a report-builder callback with one exact validated manifest snapshot.
- Exclusively publish one globally unique owner-only Markdown report and same-base-name JSON sidecar per save; the sidecar owns report-to-run linkage and identifies the manifest snapshot.
- Plugin construction accepts an internal `_logDir` override for isolated integration tests.

- [ ] Add failing tests for traversal IDs, absolute IDs, malformed IDs, unknown runs, mismatched manifest IDs, save without a run ID, immutable manifests, report sidecars, and separate-process concurrent saves.
- [ ] Verify the tests fail because current code joins untrusted IDs directly and mutates manifests to attach reports.
- [ ] Add strict generated-run-ID validation, resolved-path containment, manifest identity checking, and one-snapshot validation before report creation.
- [ ] Build the report inside the save callback, render the run ID and `Agent`, and derive the reviewed-session count from the same snapshot.
- [ ] Fully write private temporary files, revalidate canonical child paths, and publish without overwrite or pathname chmod.
- [ ] Harden event append identity and link checks; preserve save success with a stable warning if event logging fails after publication.
- [ ] Remove the mutable attachment API and process-local run locks.
- [ ] Run `node --test test/logging.test.mjs test/plugin.test.mjs` and confirm all tests pass.

### Task 2: Replace Stale Session Listing And Data Shapes

**Files:**
- Modify: `src/index.js`
- Modify: `src/core.js`
- Modify: `src/logging.js`
- Modify: `test/plugin.test.mjs`
- Modify: `test/core.test.mjs`
- Modify: `test/logging.test.mjs`

**Interfaces:**
- `listSessionsPaged(rawClient, options)` reads `/experimental/session`, follows `x-next-cursor`, deduplicates IDs, and enforces a maximum page count.
- Session time normalization accepts `time.updated` and `time_updated`.
- Message time normalization accepts `time.created` and `time_created`.

- [ ] Replace offset-based mocks with current response-header cursor mocks and add a test with more than one page.
- [ ] Add failing tests for repeated cursors, duplicate IDs, nested time fields, and exclusion of `context.sessionID` from implicit selection.
- [ ] Verify failures against the current offset implementation.
- [ ] Implement the cursor listing path and remove child-process, SQLite, database-path, and search override code.
- [ ] Preserve explicit `sessionID` behavior and use endpoint `search` for name lookup.
- [ ] Run `node --test test/core.test.mjs test/plugin.test.mjs test/logging.test.mjs`.

### Task 3: Bound And Filter Session Evidence

**Files:**
- Modify: `src/core.js`
- Modify: `test/core.test.mjs`

**Interfaces:**
- `buildReflectionPrompt({ sessions })` keeps the same public signature.
- Evidence formatting applies a global 48,000-character limit and emits omission markers.

- [ ] Add failing tests proving the final evidence stays within budget, each selected session is represented, omitted items are marked, and ignored/synthetic/reasoning parts are excluded.
- [ ] Verify tests fail with the current unconstrained concatenation and permissive part extraction.
- [ ] Implement fair per-session evidence allocation while retaining existing per-item limits.
- [ ] Restrict transcript text extraction to non-ignored, non-synthetic text parts and retain tool labels separately.
- [ ] Run `node --test test/core.test.mjs`.

### Task 4: Harden Local Privacy And Package Metadata

**Files:**
- Modify: `src/index.js`
- Modify: `src/logging.js`
- Modify: `test/logging.test.mjs`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`

**Interfaces:**
- Resolve logs from `XDG_CONFIG_HOME` with home-config fallback.
- Directories use mode `0700`; manifests, events, reports, and report sidecars use `0600`.

- [ ] Add failing filesystem-permission and title-redaction tests.
- [ ] Implement private directory/file creation, remove titles from manifest summaries, and document immutable report sidecars instead of mutable manifest linkage.
- [ ] Set package and lockfile versions to `0.3.0` while retaining `@opencode-ai/plugin` minimum `^1.17.11`.
- [ ] Update README installation, retrieval, privacy, report metadata, troubleshooting, release history, and illustrative output.
- [ ] Run `npm test`, `npm run check:import`, `npm audit --omit=dev`, and `npm pack --dry-run`.

### Task 5: Add Compatibility CI

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `AGENTS.md`

**Interfaces:**
- CI matrix covers Node 20 and 22 with plugin dependency `1.17.11` and `latest`.

- [ ] Add the workflow with checkout, Node setup/cache, `npm ci`, matrix dependency override without lockfile mutation, tests, import check, package dry run, and production audit.
- [ ] Document the cursor endpoint, privacy controls, and release checks in `AGENTS.md`.
- [ ] Validate workflow YAML syntax and rerun the local package quality gate.

### Task 6: Align jczhu.com Usage And Privacy Copy

**Files:**
- Modify: `/Users/zjc/Documents/code/jczhu-blog/src/pages/opencode-tools.astro`
- Modify: `/Users/zjc/Documents/code/jczhu-blog/src/content/blog/agent-session-log-file.md`
- Modify: `/Users/zjc/Documents/code/jczhu-blog/src/content/zhihu/opencode-session-reflection.md`
- Modify: `/Users/zjc/Documents/code/jczhu-blog/tests/verify-site-output.test.mjs`

**Interfaces:**
- Public pages use `session_reflection` as the normal installed interface.
- Public privacy text matches the SDK-only `0.3.0` implementation.

- [ ] Add or update site-output assertions so stale `/session-review` primary usage and direct-database claims fail verification.
- [ ] Verify the focused site test fails before content changes.
- [ ] Update the toolkit page and both articles, preserving `/session-review` only as an optional local helper.
- [ ] Run `npm run build` and `npm run verify:site` in the blog repository.

### Task 7: Run Release-Candidate Verification

**Files:**
- Modify only if verification reveals a defect.

**Interfaces:**
- Produce local evidence only; no push or publication.

- [ ] Run the complete plugin test, import, audit, and package-content gate from a clean dependency install.
- [ ] Install the packed tarball into a temporary application and import its packaged entry point.
- [ ] Repeat tests with `@opencode-ai/plugin@1.17.11` and `@opencode-ai/plugin@latest` without changing committed package metadata.
- [ ] Run an isolated `opencode debug config` smoke against the packed artifact and attempt collect/save tool smoke where local session availability permits.
- [ ] Run `git diff --check` and inspect status/diffs in both repositories.
- [ ] Record completed work, evidence, residual limitations, and the next confirmation gate in `/Users/zjc/Documents/code/zjc-ip/execution/daily-log.md`.
- [ ] Stop and ask for explicit push confirmation.
