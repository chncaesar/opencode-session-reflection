# OpenCode Session Reflection Promotion Readiness Design

## Goal

Prepare `opencode-session-reflection` for a public promotion push without directing new users to known security, compatibility, privacy, or usability defects.

## Scope

The release will become version `0.3.0` and retain compatibility with OpenCode `1.17.11` and later. The existing local README commit remains part of the release.

The work covers the plugin repository, its package and CI metadata, and the existing `jczhu.com` pages that describe installation or use. Publishing, pushing, and directory submission remain separate user-confirmed actions.

## Session Retrieval

All implicit session discovery will use OpenCode's cross-project experimental session endpoint. This endpoint already exists in OpenCode `1.17.11` and supports cursor pagination.

The plugin will:

- Page with the response cursor instead of treating the start timestamp as an offset.
- Reject repeated cursors and stop at a fixed maximum page count.
- Deduplicate sessions by ID.
- Use the current nested time fields while accepting the older flattened fields already returned by previous package versions and SQLite-derived fixtures.
- Remove direct SQLite access and the external `sqlite3` dependency.
- Exclude the currently running reflection session from implicit recent or name-based selection.
- Preserve explicit `sessionID` selection, including selection of the current session when the user intentionally requests it.

An unavailable or malformed session endpoint will produce a clear failure rather than silently reading private storage.

## Report Save Security

Saving a report requires a valid run identifier created by a prior collect action.

Before writing a report, the plugin will:

- Validate the run identifier against the generated identifier format.
- Resolve the manifest path and verify that it remains under the run directory.
- Require the manifest to exist and contain the same run identifier.
- Read and validate one immutable manifest snapshot.
- Invoke report construction with that exact snapshot so the rendered report and reviewed-session count cannot diverge.

Invalid, unknown, absolute, traversal, or mismatched identifiers will be rejected without writing a report or changing another file.

Collect manifests become immutable once created. New manifests will not contain report paths, completion timestamps, or report-history fields. Readers will continue accepting existing `0.2` manifests, but saving will not update either legacy or new manifests.

Each successful save will exclusively publish a globally unique owner-only Markdown report and a same-base-name owner-only JSON sidecar. Names include the run ID, timestamp, and random entropy. The sidecar records the run ID, report path, save time, reviewed-session count, and a hash of the exact manifest snapshot used by the report builder. This immutable sidecar, rather than a mutable manifest update, owns report-to-run linkage.

Report and sidecar contents will be fully written to private temporary files before publication. Publication will revalidate canonical child paths and use an exclusive operation that never overwrites an existing target. Published files will not be chmodded through a pathname. A crash may leave a dot-prefixed temporary file, but every published report is complete and identifies its run without depending on a later manifest update. Concurrent saves in separate processes remain independent and all survive with distinct artifact pairs; no process-local run lock is required.

Event-log appends will reject existing symbolic-link, non-regular, or hard-linked targets, compare the inspected and opened file identities, and apply permissions through the open file handle. If event append fails after report publication, saving still succeeds and returns a stable warning without internal error details.

## Evidence Budget

Session evidence in the generated prompt has a global budget of 48,000 characters. The static analysis instructions are outside this evidence budget.

The evidence budget will be divided fairly across selected sessions. Each included session retains its identifier and basic heading. Transcript items are added in chronological order within the session's allocation. Omitted transcript items are represented by an explicit omission marker.

Transcript extraction will include normal text parts and tool-call labels. It will exclude ignored, synthetic, and reasoning content. Existing per-item and per-session limits remain defense-in-depth controls.

## Privacy And Local Files

Metadata audit logging remains enabled by default.

Run manifests will retain session IDs, counts, hashed directories, prompt hashes, and skip reasons. They will no longer store session titles or mutable report linkage. Immutable report sidecars will hold report linkage and the manifest-snapshot hash. Documentation will avoid claiming that metadata can never contain secrets.

The session-reflection root, run, and report directories will use owner-only permissions. Manifest, event, and report files will use owner read/write permissions. The root path will respect `XDG_CONFIG_HOME` and otherwise use the standard home configuration directory.

The README will state separately that:

- Selected transcript evidence is returned to the current OpenCode session and may be sent to its configured model provider.
- The analysis prompt can ask the model to perform external prior-art research.
- Audit manifests contain redacted metadata.
- Saved Markdown reports contain the supplied analysis and may contain sensitive excerpts.
- Users are responsible for report retention and deletion.

## Report Metadata

Saved reports will show the run ID and real number of reviewed sessions from the exact validated manifest snapshot supplied to the report builder. The header will identify the active agent, because the tool context does not provide the current model identifier.

## Package And CI

Package and lockfile versions will be synchronized at `0.3.0`. The package remains plain Node-compatible ESM with no build step and no new runtime dependencies.

GitHub Actions will test Node.js 20 and 22 with both the minimum supported plugin dependency (`1.17.11`) and the latest plugin dependency. CI will run tests, import validation, package-content inspection, and the production dependency audit.

The README will use plugin configuration as the only normal installation path. It will not recommend global npm installation as a fallback. It will include a short illustrative, anonymized output excerpt without claiming user adoption or measured impact.

## Public Surface Alignment

The OpenCode toolkit page will show `session_reflection` rather than `/session-review` as the normal interface.

The existing English and Chinese articles will distinguish SDK transcript retrieval from the removed SQLite implementation. The Chinese article will present the registered tool first and label the slash command as an optional local-development helper.

## Verification And Release Gates

Local completion requires:

- Full unit and integration tests.
- Plugin import validation.
- Production dependency audit.
- npm package dry-run inspection.
- Packed-tarball installation and import verification.
- Minimum and latest plugin dependency checks.
- Isolated OpenCode configuration and tool smoke testing where the local environment permits it.
- Blog build and site-output verification.

After local verification, work stops for explicit confirmation before each public action: Git push, npm publication, and directory submission.

## Promotion Target

After release verification, the first directory target is AI Boost's Awesome Harness Engineering under `Debugging & Developer Experience`. The entry will position the project as an OpenCode-native retrospective that turns repeated session failures into durable harness improvements.

No duplicate directory submission, unsolicited email campaign, or repeated Discord post is part of this scope.
