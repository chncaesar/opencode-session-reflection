# npm Package Design

## Goal

Make `opencode-session-reflection` a regular npm-distributed OpenCode plugin while keeping the existing local development workflow available.

## Scope

- Keep the package name `opencode-session-reflection`.
- Keep the runtime source as plain ESM JavaScript with no build step.
- Make npm installation the primary documented user path.
- Keep `npm run deploy` and `npm run undeploy` as local development helpers.
- Add publish-time verification so the package cannot be published without tests and import validation passing.
- Document the release checks agents and maintainers must run before `npm publish`.
- Require a tarball-installed OpenCode smoke test before publishing.
- Require a real npm package load smoke test after publishing.

## Package Shape

The npm package exports `src/index.js` directly. This is appropriate because the source is already Node-compatible ESM JavaScript. A `dist/` build would add complexity without changing the runtime artifact.

The published file set includes only the plugin source, slash command template, README, and license. Tests, scripts, and local deployment internals remain in the repository but are not part of the npm tarball.

## User Installation

Users install by adding the package name to the OpenCode `plugin` array, then restarting OpenCode. The README should present this path first.

The slash command file remains included in the package, but local command deployment remains a separate development helper unless OpenCode's npm plugin loader auto-registers packaged command files.

## Maintainer Workflow

Before publishing, maintainers run tests, import validation, and an npm dry-run pack check. `prepublishOnly` runs the test and import checks automatically during `npm publish`; `npm pack --dry-run` remains an explicit final packaging inspection.

The release candidate is validated from a packed tarball installed into a throwaway app under `/tmp`. The isolated OpenCode config must point at the installed `node_modules/opencode-session-reflection/src/index.js` entry, and `opencode debug config` must show that path in `plugin_origins`. The smoke test calls `session_reflection` with `action=collect` and `limit=1`; empty session evidence is acceptable, but plugin import/load errors are not.

`npm publish` is a human-confirmed action. Agents must stop after the local release-candidate smoke and wait for an explicit publish confirmation in the current turn.

After publishing, maintainers clear OpenCode's npm plugin cache, load the package by name with `plugin: ["opencode-session-reflection"]`, restart OpenCode, and call `session_reflection` again. Local development plugin files must be removed before this post-publish smoke to avoid double-loading the npm package and the auto-discovered local plugin.
