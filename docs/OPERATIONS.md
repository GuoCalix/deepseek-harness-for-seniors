# Operations and Maintenance Guide

This is the English maintenance contract for the current application. It documents observable behavior and reproducible checks; it does not replace the original product design or declare unfinished requirements complete.

## Architecture and source ownership

The current desktop implementation uses Electron 44, React and a Node service. The design specifies Tauri/Rust; migration is outstanding.

| Module | Responsibility |
| --- | --- |
| `electron/main.mjs`, `preload.cjs` | Single-instance lifecycle, restricted IPC, official-page opening, system encryption |
| `app/server/account.mjs` | PKCE state, grant lifetime, account/API-key balance and credentials |
| `app/server/storage.mjs` | Atomic writes and injected OS encryption |
| `app/server/network.mjs` | TLS requests, redirect rejection, timeouts and bounded JSON |
| `app/server/usage.mjs` | Serialized UTC-month local token totals and estimate flags |
| `app/server/index.mjs` | Task contracts, metadata indexing, Markdown reports, local transport |
| `app/src/account.tsx` | Account state, login, balance, top-up and API-key UI |

The packaged renderer loads relative assets through `file://` and uses a narrow preload bridge. Main checks both the requesting WebContents and its main frame against the packaged page. No Node APIs or credentials are exposed to the renderer. The HTTP listener uses an ephemeral loopback port only for the authorization callback; packaged HTTP API requests are refused. This removes the old file-origin CORS failure and port 4179 collision.

Development runs Vite at `127.0.0.1:4178` and the API at `127.0.0.1:4179`. The API rejects foreign origins, unexpected Host headers and non-JSON POST requests. The Vite proxy forwards same-origin `/api` requests. Never expose these development services on a public interface.

The source reference is DeepSeek Harness commit `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`. Consult `deepseek-account-platform/src/{index,protocol,details}.ts`, `llm-deepseek/src/{adapter,translate}.ts` and `token-meter/src/estimate.ts`. This application adapts protocol and estimation rules without mounting Cordis or the full plugins. Preserve the MIT notice in `THIRD_PARTY_NOTICES.md` when distributing derivatives.

## Reproduce a checkout

Use Node 22.22.2 or later. CI uses the maintained Node 22 release. Direct dependency versions and transitive dependencies are locked; installers bundle Electron and need no system Node installation.

```bash
git clone --recurse-submodules https://github.com/GuoCalix/deepseek-harness-for-seniors.git
cd deepseek-harness-for-seniors
git checkout v0.1.3
git submodule update --init --recursive
npm ci
npm run check
npm test
npm run build
npm run test:desktop
```

The submodule is a source reference and is not needed for the root build. To develop, run `npm run dev` and open <http://127.0.0.1:4178>. Connect an account/API key in the UI. Web-development credentials are deliberately session-only; desktop credentials persist through the OS store. An environment-provided `DEEPSEEK_API_KEY` is an optional developer fallback and is never copied into a build.

For dependency downloads:

```bash
HTTPS_PROXY=http://127.0.0.1:6268 HTTP_PROXY=http://127.0.0.1:6268 npm ci
```

Provider traffic is direct by default. On a supported Node runtime, `NODE_USE_ENV_PROXY=1` enables its environment proxy support; configure `NO_PROXY=localhost,127.0.0.1` for loopback. Verify the proxy separately: during this investigation, direct Platform authorization succeeded while the proxy route returned HTTP 429. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`, `curl -k` or copied browser cookies as a login workaround.

## Provider and authentication contracts

| Credential | Inference | Balance |
| --- | --- | --- |
| Official account grant | `POST https://api.deepseek.com/anthropic/v1/messages`, `x-dsh-auth-token`, `anthropic-version: 2023-06-01` | Platform `GET /auth-api/v0/users/current` and `GET /api/v0/users/get_user_summary` |
| API key | `POST https://api.deepseek.com/chat/completions`, Bearer authorization, JSON mode | `GET https://api.deepseek.com/user/balance`, Bearer authorization |

The current model defaults to `deepseek-chat` and can be set by the service's `DEEPSEEK_MODEL` environment variable. Account grants take priority; signing out removes only the account grant, retaining a separately configured API key. Removing a saved key does not remove a process environment key.

Account authorization uses these Platform endpoints:

1. Register the loopback listener before `POST /auth-api/v0/dsh/auth_init`. Generate independent random state and S256 verifier/challenge; supply the exact callback URI and UI locale.
2. Open only the returned same-origin `/dsh/authorize` address on the user's computer. The official sign-in page supplies WeChat QR and phone options. Never encode the loopback callback as a phone QR.
3. Accept a unique code/state pair exactly once on `/oauth/callback`. Compare state bytes safely, reject replays and expire attempts after the shorter of ten minutes or provider TTL.
4. Exchange through `POST /auth-api/v0/dsh/auth_exchange` with the original verifier, callback URI and persistent random device ID.
5. Commit the encrypted grant before redirecting to the validated `/dsh/authorized` address. Cancellation and logout prevent late exchange responses from restoring a removed grant.
6. Cancel attempts with `auth_cancel`. Sign-out removes local access first and attempts remote `/auth-api/v0/users/logout`; a remote revocation failure must never restore local access.

Native account requests carry `x-client-platform: desktop-mac` or `desktop-win`. Stored issuer mismatches are discarded without transmitting the foreign token. Loopback or mock grants cannot authenticate the official production inference origin. Provider redirects are rejected. Response bodies and credentials are never copied into diagnostics.

`GET /api/account/status` reads only cached safe state; `?refresh=1` queries provider details with singleflight and lifetime checks. UI polling does not repeatedly request upstream balances. Changes invalidate in-flight details. A refresh failure preserves the last value, sets `balanceError` and retains the original query timestamp. It never fabricates zero.

API-key balance follows the official contract: `is_available` and `balance_infos[]` with currency, total, granted and topped-up decimal strings. Account normal and bonus wallets remain separate. See <https://api-docs.deepseek.com/api/get-user-balance/>.

Top-up and usage always open official `/top_up` and `/usage` pages. The existing system-browser session completes authentication and payment there. The application does not create payment orders itself, accept card data, mark client-side payments successful or implement undocumented payment callbacks. An end-to-end paid transaction requires explicit user action and a confirmed official balance afterward.

## Live model contracts and metering

Production calls never silently fall back. Explicit `AI_OLD_ALLOW_MOCK=true` enables deterministic testing only.

| Stage | Validated response |
| --- | --- |
| Intent | One to three candidates, each with title, description and needed inputs |
| Clarification | Ask one question or return a ready plan, target, output and network explanation |
| Result | Summary, suggestions, feedback choices and Markdown content |
| Revision | One next clarification question |

The app stores successful provider usage even when model-output validation subsequently fails, because the provider may already have charged the call. OpenAI-style prompt tokens include cached tokens; Messages input adds separately reported cache-read/cache-write counts once. Missing usage is estimated at four characters per token with framing overhead and increments `estimatedRequests`. Negative/nonfinite counters are rejected. Writes are serialized and atomic. A storage failure produces a usage warning without repeating a paid inference request.

Usage is local to this application and UTC calendar month, including calls before an account switch. It is not a provider-wide invoice. No hard-coded token price is used to manufacture wallet balances.

## Data and recovery

| Location | Contents |
| --- | --- |
| Electron user-data directory `data/credentials.json` | OS-encrypted account/API-key blob; no cleartext credential |
| `data/device.json` | Stable random device ID |
| `data/tasks.json` | Local task snapshots |
| `data/usage.json` | Aggregate monthly counts, no prompts or credentials |
| Desktop `AI for the old/<task>/` | `input/`, `work/`, `output/`, `logs/` |

Development data defaults to ignored `app/data/`. Tests always use newly created OS temporary directories, blank inherited production keys and explicit fixtures. `AI_OLD_DATA_DIR`, `AI_OLD_WORKSPACE_ROOT` and test-only `AI_OLD_USER_DATA` support isolated verification.

The old experimental cleartext `account.json` is not loaded. Do not migrate it by copying credentials into source; reconnect through the official flow. Secure-storage corruption returns an explicit error instead of showing a signed-in state. Restore task/workspace backups independently of credentials. Encrypted credentials may be bound to the original OS account and should be reauthorized on a new machine.

Close the application before backing up task/workspace files. Never delete original input folders as recovery. If a generation fails, inspect the existing output and retry from the task; do not retry provider requests automatically without considering duplicate charges.

Current execution is limited to bounded metadata indexing and Markdown reports. Full Tauri/Rust migration, SQLite events, pause/resume/cancel execution, comprehensive file copying/conversion, document/spreadsheet tools and durable artifact versioning are outstanding design requirements. Do not advertise the complete original design as accepted.

## Quality gates and real-account acceptance

```bash
npm ci
npm run check
npm test
npm run build
npm run test:desktop
git diff --check
```

Protocol tests cover S256 exchange, mismatch/duplicate/multibyte state, callback replay, concurrent starts, expiry, cancellation, late logout, issuer isolation, stale balance and concurrent metering. They start a bounded local provider fixture and never contact production.

Desktop tests launch Electron and verify the actual renderer, relative file assets, preload bridge, task creation POST, clarification, account dialog and OS encryption round-trip. To test a built application:

```bash
AI_OLD_TEST_EXECUTABLE='/absolute/path/AI for the old.app/Contents/MacOS/AI for the old' npm run test:desktop
```

On Windows, set the same variable to `release/win-unpacked/AI for the old.exe`. The test uses an isolated user-data directory and closes its own application. `AI_OLD_SCREENSHOT_DIR` optionally captures the login dialog; do not enable screenshots containing credentials or personal account information.

For an explicitly authorized live API-key test, run `node scripts/live-verify.mjs` and provide a low-budget key on stdin with terminal echo disabled. Never embed the key in shell command arguments, source, environment files or recorded CI logs. The script verifies official balance, candidates, clarification, result and feedback with four or more live calls, then removes its temporary data. Restore terminal echo afterward. Rotate keys previously exposed in chat/transcripts.

Recorded on 2026-09-23:

- Local arm64 packaged app: renderer and IPC smoke passed, system encryption round-trip passed, zero renderer errors.
- Real API-key flow: four calls, 958 input + 527 output = 1,485 exact tokens; official balance read succeeded.
- Real Platform authorization initialization: HTTP 200 with expected fields; official Harness sign-in and WeChat QR page reached.
- Pending: user phone confirmation, real account-grant inference/wallet, and a paid top-up settlement. Fixture results are not evidence for those steps.
- Pending signing authority: no Developer ID identity on the local machine and no signing secrets in the GitHub repository during this investigation.

## Release and signing

Build from the version tag, not an arbitrary current branch:

```bash
npm run desktop:mac -- --arm64
npm run desktop:mac -- --x64
npm run desktop:win -- --x64
```

The scripts disable implicit publishing. The release workflow checks out the requested tag, runs validation, builds on native architecture runners, launches packaged applications, verifies Mac signatures and then publishes DMGs/EXE plus `SHA256SUMS.txt`. Do not publish an installer based solely on a successful compilation. Inspect every job and final asset.

macOS Developer ID distribution requires repository secrets `CSC_LINK` (base64 PKCS#12 certificate), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. Never put their values in this document or git. Once configured, set repository variable `AI_OLD_REQUIRE_NOTARIZATION=true` so missing signing/notarization inputs fail the release. The build config enables hardened runtime and notarization for that mode; verify using:

```bash
codesign --verify --deep --strict 'release/mac-arm64/AI for the old.app'
xcrun stapler validate 'release/mac-arm64/AI for the old.app'
spctl --assess --type execute --verbose 'release/mac-arm64/AI for the old.app'
```

Without those credentials, the configuration explicitly produces an ad-hoc signed Mac build, with hardened runtime disabled for that build to avoid ad-hoc library-validation launch failures. This is not Developer ID signing or notarization and cannot remove the unidentified-developer prompt. Never suppress it by disabling Gatekeeper or stripping quarantine as an installation requirement. Windows code-signing credentials are separate; unsigned NSIS installers may trigger SmartScreen.

Tag and push only reviewed code. After all build jobs pass, inspect release assets and update release notes with the tested platforms, signed/notarized status, remaining live-account acceptance work and any product gaps. Signing or timestamping makes builds functionally reproducible, not necessarily byte-identical. Preserve old releases for rollback and do not embed production credentials in CI.
