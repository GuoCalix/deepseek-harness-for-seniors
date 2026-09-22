# Operations and Maintenance Guide

This document describes the supported local deployment, data model, recovery procedure, test gates, and release process for AI for the old. It is intentionally independent of a developer's machine so that another maintainer can reproduce a release from a clean checkout.

## Scope and architecture

The root application has two processes during development:

1. Vite serves the React client on `127.0.0.1:5173` (or the next available Vite port) and proxies `/api` requests.
2. `app/server/index.mjs` serves the loopback-only API on `127.0.0.1:4179`.

The API is the owner of task state, workspace creation, file metadata scanning, report generation, and the optional DeepSeek adapter. The browser never receives an API key. The service writes an append-style execution record to `logs/execution.jsonl` and an atomic JSON task snapshot to `app/data/tasks.json` (ignored by git).

The included `deepseek-harness/` directory is the upstream DeepSeek Harness source tree. It is kept as a source reference and integration base; the root product does not modify its upstream git metadata.

## Reproducible setup

Prerequisites:

- Node.js 22 or later (Node 24 is recommended for this repository).
- npm 10 or later.
- A macOS or Windows account with a Desktop and Downloads directory for a real file-indexing run.

From a clean checkout:

```bash
npm ci
npm run check
npm test
npm run build
npm run dev
```

`npm ci` uses the committed `package-lock.json` and therefore does not silently update dependency ranges. When outbound package access requires the configured proxy, set `HTTP_PROXY` and `HTTPS_PROXY` to `http://127.0.0.1:6268` for the install command only. The app itself does not require a proxy to serve local files.

To enable the official provider for a local run, export the key in the shell that starts the API:

```bash
DEEPSEEK_API_KEY='sk-...' npm run dev
```

Never put the key in `.env`, a task snapshot, a screenshot, a commit, or an issue. The server sends only the explicitly requested DeepSeek chat messages and uses the fixed `deepseek-chat` model in this adapter.

## Local data and workspace contract

Every task creates the following directory under `~/Desktop/AI for the old/<slug>-YYYY-MM-DD/`:

| Directory | Purpose | Safe to remove |
| --- | --- | --- |
| `input/` | copied or linked source material when a future tool uses it | yes, after review |
| `work/` | intermediate files | yes |
| `output/` | user-facing artifacts and `任务说明.md` | only after saving desired results |
| `logs/` | append-only tool summaries | yes, after export |

The current MVP report generator indexes metadata only and does not modify the source file. It limits recursion depth and result count, skips hidden directories and `node_modules`, and records absolute paths in the task report so the user can check the result. Future tools must remain in the explicit allowlist in `app/server/index.mjs`; adding a general shell or delete tool is a security change and requires new tests and a design review.

Task snapshots contain the prompt, clarification turns, status, event labels, artifact paths, and feedback. They do not contain API keys. To back up local history, stop the API and copy `app/data/tasks.json` plus the relevant Desktop workspace folders. Restore by putting the snapshot back before starting the service. The write path uses a temporary file and rename to avoid half-written JSON after a process interruption.

## State and recovery

The supported state sequence is:

`CLARIFYING → READY_TO_RUN → ACCESS_PENDING → RUNNING → COMPLETED`

`REVISION` returns to clarification while preserving the previous artifact version. `FAILED` keeps any workspace files already created and can be retried. The UI does not expose model chain-of-thought; it shows stage labels, counts, elapsed time, and result paths only.

If the browser is closed, restart `npm run dev` and open Task history. If the API is unavailable, the top bar changes to “Local service is offline”; no task is silently discarded. If a task is interrupted while scanning, remove only the unfinished `work/` directory after reviewing `output/`, then retry from the task page. Do not delete the original source files to recover a task.

## Quality gates

Run all gates before a commit or release:

```bash
npm run check       # strict TypeScript client check
npm test            # loopback API integration tests
npm run build       # production Vite bundle
```

The tests intentionally start the real local API in a child process. They verify loopback health, the three-candidate limit, task creation, and the clarification transition. Add tests whenever a new state, tool, persistence field, or provider behavior is introduced. For UI changes, manually check keyboard focus, 18px default text, the 125% text toggle, high contrast, narrow viewport layout, and the bilingual copy.

## Release process

The root repository is the product repository. Release tags use semantic versions such as `v0.1.0`.

1. Run the three quality gates from a clean working tree.
2. Review `git diff --check`, `git status`, and the generated `dist/` bundle.
3. Update `package.json` and `package-lock.json` together, then commit with a concise release message.
4. Push the branch and tag over the configured GitHub SSH remote.
5. Create a GitHub release whose notes include the tested Node version, commit SHA, known limitations, and whether `DEEPSEEK_API_KEY` was used. Do not attach task data or credentials.

The CI workflow runs the same install, type check, test, and build commands on Ubuntu. A future native desktop packaging job can consume the `dist/` bundle and the loopback service; it must preserve the same workspace and credential contracts and must be tested on both macOS and Windows before being marked stable.

## Security checklist

- The API binds to loopback and must not be changed to `0.0.0.0` without authentication and a threat-model update.
- File roots come from the approved task scope; original files are copied or read, not overwritten.
- No model-generated command is passed to a shell.
- DeepSeek uploads are opt-in and should include only the minimum text needed for clarification.
- QR login opens the official `platform.deepseek.com` page; this repository does not store DeepSeek session cookies or payment secrets.
- Payment and top-up cards are deliberately demo-only until a verified server-side payment provider is configured; the client never credits a balance from its own callback.
