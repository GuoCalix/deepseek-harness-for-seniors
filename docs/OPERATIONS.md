# Operations and Maintenance Guide

This document is the reproducible, English-language maintenance contract for AI for the old. It describes the supported runtime, provider boundary, data layout, recovery procedure, quality gates, and release process. It is written so a maintainer can reproduce a release from a clean checkout without relying on a developer machine.

## Architecture

The development application has two local processes:

1. Vite serves the React client on `127.0.0.1:4178`.
2. `app/server/index.mjs` serves the loopback-only API on `127.0.0.1:4179`.

The API owns task state, workspace creation, file metadata scanning, report generation, provider calls, and persistence. The browser never receives an API key. The Electron main process starts the same API and loads the built `dist/index.html` from a packaged application. Packaged data is stored under Electron's per-user data directory; workspaces remain under the user's Desktop.

All model-facing interactions use the DeepSeek `deepseek-chat` endpoint with JSON mode:

`POST https://api.deepseek.com/chat/completions`

The service validates candidate, plan, result, and revision responses before persisting them. It never executes model-generated commands. `AI_OLD_ALLOW_MOCK=true` is test-only behavior; production must use `DEEPSEEK_API_KEY`.

The included `deepseek-harness/` directory is the upstream source reference and keeps its own license. The root `app/` directory is the product shell described by the design document.

## Reproducible setup

Prerequisites:

- Node.js 22 or later (the CI and release workflows use Node 22).
- npm 10 or later.
- A macOS or Windows account with Desktop and Downloads directories for a real indexing run.
- A DeepSeek API key for non-test task generation.

From a clean checkout:

```bash
npm ci
npm run check
npm test
npm run build
```

For a local provider-backed run:

```bash
DEEPSEEK_API_KEY='sk-...' npm run dev
```

The optional package proxy is `http://127.0.0.1:6268`:

```bash
HTTPS_PROXY=http://127.0.0.1:6268 HTTP_PROXY=http://127.0.0.1:6268 npm ci
```

The Node service does not log authorization headers. Never put a key in `.env`, source files, task snapshots, screenshots, issue comments, or commits. If a key is pasted into a chat or terminal transcript, rotate it after validation.

## Model contract and provider limits

The following calls are required for a complete production flow:

| Flow stage | Server function | Required JSON response |
| --- | --- | --- |
| Intent candidates | `generateCandidates` | `candidates[]` with `title`, `description`, `needs` (1-3 items) |
| Clarification | `generatePlan` | `next_action`, `question`, `target`, `output`, `network`, `summary` |
| Result | `generateResult` | `summary`, `suggestions[]`, `feedback_options[]`, `markdown` |
| Feedback | `generateRevision` | `question` |

The API key is read from the service process only. The endpoint that accepts chat messages does not accept a key from the request body. The UI's QR entry opens the official web sign-in page, but does not import cookies or convert a web session into an API credential.

DeepSeek's public API documentation does not expose a supported API for web-session transfer, account balance, recharge, or payment. The account screen intentionally reports `balance: null` and links to the official platform. Do not add scraping, cookie extraction, card handling, or locally fabricated credit. Such a change would require an official documented provider API, a threat model, and a separate review.

## Local data and workspace contract

Each task creates `~/Desktop/AI for the old/<slug>-YYYY-MM-DD/` with:

| Directory | Purpose | Safe to remove |
| --- | --- | --- |
| `input/` | copied or linked source material when a future tool uses it | yes, after review |
| `work/` | intermediate files | yes |
| `output/` | user-facing Markdown artifacts | only after saving desired results |
| `logs/` | append-only execution summaries | yes, after export |

The development task snapshot is `app/data/tasks.json`, ignored by Git. Electron sets `AI_OLD_DATA_DIR` to its user-data directory so installed apps do not write into the packaged application. Both locations use atomic temporary-file-then-rename writes.

The current execution path indexes metadata only, limits recursion depth and result count, skips hidden directories and `node_modules`, and does not modify source files. New tools must be explicit entries in `allowedTools` and must have tests. A general shell, delete, or unrestricted network tool is outside this contract.

## State and recovery

The supported state sequence is:

`CLARIFYING → READY_TO_RUN → ACCESS_PENDING → RUNNING → COMPLETED`

`REVISION` returns to clarification while preserving the previous artifact. `FAILED` keeps workspace files already created and can be retried. The UI never displays model chain-of-thought; it displays stages, timing, counts, and result paths.

If the browser or desktop window closes, restart the app and open Task history. If the API is offline, no task is silently discarded. If scanning is interrupted, inspect `output/` first and remove only the unfinished `work/` directory before retrying. Never delete source files as a recovery action.

## Quality gates

Run all gates before every commit and release:

```bash
npm run check       # strict TypeScript client check
npm test            # loopback API integration tests (mock provider enabled in child process)
npm run build       # production Vite bundle
npm run desktop:dir # local Electron packaging smoke check
git diff --check
```

The tests start the real local API in a child process and deliberately set `AI_OLD_ALLOW_MOCK=true`; they never use a production key. Add tests for every new state, persistence field, provider contract, and tool boundary. For UI changes, manually check keyboard focus, large text mode, high contrast, narrow viewport layout, bilingual copy, and packaged file-mode API access.

## Release process

The root repository is the product repository. Semantic tags use the form `vMAJOR.MINOR.PATCH`.

1. Run the quality gates from a clean checkout.
2. Update `package.json` and `package-lock.json` together when dependencies or version change.
3. Commit and push `main`, then push the version tag over the configured SSH remote.
4. The `Desktop release` workflow builds macOS `.dmg` and Windows NSIS `.exe` installers on native GitHub runners and attaches them to the tag release. It can also be started manually with an existing `tag` input.
5. Verify the release assets and checksums from the GitHub release page. Release notes must include the commit SHA, Node version, quality-gate results, known limitations, and whether a provider key was used. Never attach task data or credentials.

Local commands are:

```bash
npm run desktop:mac   # native macOS .dmg
npm run desktop:win   # native Windows .exe
npm run desktop:dir   # unpacked current-platform check
```

Cross-platform installers must be built on their native runner. Do not claim a release is installable until both workflow jobs have uploaded a non-empty artifact.

## Security checklist

- Bind the API to loopback; changing it to `0.0.0.0` requires authentication and a threat-model update.
- Treat file roots as an explicit user-approved scope.
- Never pass model-generated text to a shell.
- Send only minimum necessary metadata and text to DeepSeek after the user approves network access.
- Keep API keys in the service environment and out of renderer state, localStorage, logs, snapshots, and Git.
- Keep QR login as an official-link convenience only; do not read browser cookies.
- Do not implement balance, recharge, or payment callbacks without an official documented provider contract.
