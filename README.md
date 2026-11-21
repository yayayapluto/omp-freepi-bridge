# omp-freepi-bridge

Free OpenAI-compatible model provider for [pi/OMP](https://github.com/oh-my-pi/oh-my-pi), served by
the [freepi-bridge](https://github.com/ihsan-ramadhan/freepi-bridge) local daemon. The extension
finds (or spawns) a healthy daemon on `127.0.0.1`, starts a small local filtering proxy in front of
it, and registers a `freepi` provider — so OMP sessions can chat through your FreePi account without
an API key. Only models that don't need premium credits are exposed, with an ordered fallback chain
for the rest.

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
  - [Step 1 — Get a FreePi token (prerequisite)](#step-1--get-a-freepi-token-prerequisite)
  - [Step 2 — Install the plugin into OMP](#step-2--install-the-plugin-into-omp)
  - [Step 3 — Verify it loaded](#step-3--verify-it-loaded)
- [Usage](#usage)
  - [Daily flow](#daily-flow)
  - [Environment variables](#environment-variables)
  - [`/freepi` commands](#freepi-commands)
  - [Reading the status output](#reading-the-status-output)
  - [Common prompts](#common-prompts)
- [What it reads and touches](#what-it-reads-and-touches)
- [Architecture](#architecture)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [License](#license)

## Features

- **`freepi` provider** — registers an `openai-completions` provider with OMP; all models report zero
  cost, 200k context, 16,384 max output tokens, text+image input.
- **Healthy-daemon reuse** — probes `FREEPI_BRIDGE_PORT`, `~/.freepi-bridge/state.json`, `8787`, and
  `8788`–`8793` via `/health` in parallel (1.5 s per probe) and reuses the first daemon that answers.
- **Self-spawning daemon** — if none is healthy, picks a genuinely free port and runs
  `freepi-bridge start --bg --port <port> --bind 127.0.0.1` (15 s health timeout).
- **Free-only filtering proxy** — a local HTTP proxy in front of the daemon serves only free models
  on `GET /v1/models` and reroutes premium/unknown ids to the best free model on chat.
- **Ordered fallback** — `429`/account-busy retries the same model up to 3 times (1.2 s, 2.4 s,
  3.6 s); `403`/`408`/`409`/`425`/`429`/`500`/`502`/`503`/`504` move to the next free model. The
  model actually used comes back in the `x-freepi-model` response header.
- **Automatic healing** — one in-flight heal per failure burst (shared `Promise`, 5 s back-off after
  a failed heal); the proxy's target endpoint is swapped via `setEndpoint` without a restart, so the
  URL in `~/.omp/agent/models.yml` never changes.
- **`/freepi` command** — status, token, doctor, models, refresh-models, start/stop/restart, ads, logs, install, help.
- **Local diagnostics**: appends structured JSONL events to `~/.freepi-bridge/plugin.log`. Set
  `OMP_PLUGIN_LOG=0` to turn file logging off. Tokens, prompts, model output, and headers are never
  written; URL query strings and userinfo are stripped from any metadata strings.

## Requirements

- OMP (`omp` CLI) with plugin/extension support.
- Node.js 22+ or Bun 1.1+ (OMP's runtime). The code uses `Promise.withResolvers`; there is no
  `engines` field in `package.json`.
- A FreePi account and token (see Step 1).
- Network access to `https://api.freepi.ai` and `https://github.com` (GitHub only needed when no
  `freepi-bridge` binary exists locally yet).
- Windows or Linux/macOS (the download picks the matching release asset per platform/arch).

## Install

### Step 1 — Get a FreePi token (prerequisite)

Sign in once per machine:

```bash
npx free-pi-cli@latest
```

Log in with GitHub, then quit. The token is saved to `~/.free-pi/agent/credentials.json`.

Alternative token sources, in priority order (checked by `/freepi token`):

| Source | How |
| --- | --- |
| `FREEPI_TOKEN` environment variable | `set FREEPI_TOKEN=eyJ...` (Windows) / `export FREEPI_TOKEN=eyJ...` |
| `~/.free-pi/agent/credentials.json` | written by the CLI above |
| `~/.freepi-bridge/config.env` | a line `FREEPI_TOKEN=...` in the daemon config |

### Step 2 — Install the plugin into OMP

Pick one:

**From npm (published as `omp-freepi-bridge@0.2.0`):**

```bash
omp plugin install omp-freepi-bridge
```

**From the OMP marketplace:**

```bash
omp plugin marketplace add yayayapluto/omp-freepi-bridge
omp plugin install omp-freepi-bridge
```

**From a local checkout:**

```bash
git clone https://github.com/yayayapluto/omp-freepi-bridge.git
cd omp-freepi-bridge
npm install && npm run build
omp plugin link .
```

`npm i -g omp-freepi-bridge` only installs the npm package; use `omp plugin install` so the OMP
runtime actually loads the extension.

### Step 3 — Verify it loaded

```bash
omp plugin list | grep freepi
```

Then inside any OMP session type:

```
/freepi status
```

A healthy install reports something like:

```text
freepi 0.2.0: daemon online 127.0.0.1:8787 · models=4 · token=yes (~/.free-pi/agent/credentials.json) · binary=installed
```

## Usage

### Daily flow

1. Load OMP as usual. On startup the extension registers the `freepi` provider immediately from its
   model cache (no network wait), then in the background finds or starts the daemon, starts the
   filtering proxy, and re-registers the provider against the proxy URL.
2. Use any free model directly:

   ```bash
   omp --model freepi/particle -p "hello"
   ```

3. If you ask for a premium id (or an unknown id), the proxy silently starts from the best free
   model instead; check the `x-freepi-model` response header to see which model actually answered.
4. If the daemon dies mid-session, the next request triggers an automatic heal — no manual
   `freepi-bridge start` needed. Run `/freepi refresh-models` or `/freepi start` to force a re-check.
5. List what's registered:

   ```bash
   omp models freepi
   ```

**Free models and the fallback chain.** The extension reads `https://api.freepi.ai/client-version`
with your token to learn which models have `free === true` (the bridge's `/v1/models` carries no
tier flag) and caches the result in `~/.freepi-bridge/free-models.json`. Registration, fallback, and
the proxy's ordering all use one list, built best → least:

1. `particle`
2. `deepseek-v4.1-flash`
3. `glm-5.3-flash`
4. `deepseek-v4-flash`

When the tier lookup succeeds, a default id is kept only if it is marked free, and any other
detected free id is appended after the four defaults. When detection is unavailable (no token, HTTP
error, or empty result), the four defaults are used as-is. With `FREEPI_FREE_ONLY=0` no filtering
happens and the full bridge catalog is registered.

**`models.yml` sync.** OMP also caches provider config in `~/.omp/agent/models.yml`. While
`FREEPI_FREE_ONLY` is not `0`, the extension rewrites the `freepi.baseUrl` entry to the proxy URL
when the proxy starts, so discovery and chat both go through the filter. Healing never changes this
URL — only the proxy's upstream target moves. After upgrading from a version that pointed
`freepi` straight at the daemon, run `omp models refresh freepi` once to clear OMP's cached
discovery.

### Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `FREEPI_TOKEN` | unset | FreePi JWT; highest-priority token source |
| `FREEPI_BRIDGE_BIN` | unset | Explicit path to the `freepi-bridge` binary |
| `FREEPI_BRIDGE_PORT` | `8787` | First candidate port for daemon probe/spawn; the extension picks another free candidate if busy |
| `FREEPI_PROXY_PORT` | daemon port + 1 | Preferred proxy port; falls back to an OS-assigned free port if taken |
| `FREEPI_BASE_URL` | `https://api.freepi.ai` | FreePi API used for the model-tier lookup |
| `FREEPI_FREE_ONLY` | `1` | `1` = register free models only and filter at the proxy; `0` = expose the full bridge catalog, no filtering, no `models.yml` sync |
| `FREEPI_AUTO_AD` | `1` | Consumed by the `freepi-bridge` binary, not the extension; `0` disables automatic ad reporting |
| `OMP_PLUGIN_LOG` | `1` | `0` disables all extension file logging; daemon logs are unaffected |

### `/freepi` commands

| Command | Effect |
| --- | --- |
| `/freepi status` | Daemon liveness, model count, token source, binary version |
| `/freepi token` | Masked token + source, or the sign-in guide |
| `/freepi doctor` | Runs `freepi-bridge doctor --json` |
| `/freepi models` | Lists registered model ids |
| `/freepi refresh-models` | Re-fetches `/v1/models`, refreshes the free-tier cache, re-registers the provider |
| `/freepi start` | Brings the daemon up (reuses a healthy one first) and refreshes models |
| `/freepi stop` | Kills the daemon recorded in `~/.freepi-bridge/state.json` |
| `/freepi restart` | Stop, then start |
| `/freepi ads` | Prints the FreePi ad page URL (via `freepi-bridge ads`) |
| `/freepi logs` | Last 8 lines of `~/.freepi-bridge/bridge.log` |
| `/freepi install` | Downloads/verifies the `freepi-bridge` binary if not already present |
| `/freepi help` | Command overview |

### Reading the status output

`/freepi status` prints one line:

```text
freepi 0.2.0: daemon <online host:port | offline> · models=<N> · token=<yes (source) | missing: /freepi token> · binary=<version | installed | missing>
```

| Field | Meaning | What to do |
| --- | --- | --- |
| `daemon online 127.0.0.1:8787` | `/health` answered 200 | Nothing |
| `daemon offline` | No healthy daemon at the current endpoint | Next request heals automatically; or `/freepi start` |
| `models=4` | Models in the local cache (`~/.freepi-bridge/pi-models.json`) | `0` → `/freepi refresh-models` |
| `token=yes (env FREEPI_TOKEN)` | Which token source was found | `missing` → `/freepi token` for the guide |
| `binary=<version>` | First line of `freepi-bridge version` | `missing` → `/freepi install` |

When a heal fails, the extension status shows `freepi: bridge offline — <error>` including any
daemon stderr.

### Common prompts

| You want | Do |
| --- | --- |
| See everything is alive | `/freepi status` |
| Check token and sign-in options | `/freepi token` |
| List usable models | `/freepi models` or `omp models freepi` |
| Force a daemon re-check | `/freepi start` |
| Diagnose the bridge itself | `/freepi doctor` |
| See why requests fail | `/freepi logs` |

## What it reads and touches

| Path | Read/Write | Purpose |
| --- | --- | --- |
| `~/.free-pi/agent/credentials.json` | Read | FreePi token (written by `npx free-pi-cli@latest`) |
| `~/.freepi-bridge/state.json` | Read | Daemon `port`/`pid` from a previous run |
| `~/.freepi-bridge/config.env` | Read | `FREEPI_TOKEN=...` fallback |
| `~/.freepi-bridge/bridge.log` | Read | Last 8 lines for `/freepi logs` |
| `~/.freepi-bridge/plugin.log` | Append | Structured extension events (JSONL), separate from the daemon's `bridge.log` |
| `~/.freepi-bridge/pi-models.json` | Write | Cached provider model list (survives restarts) |
| `~/.freepi-bridge/free-models.json` | Write | Cached free-model ids from the tier lookup |
| `~/.freepi-bridge/bin/` | Write | Extracted binary when downloaded |
| `~/.omp-freepi-bridge/bin/` | Write | Extension-managed binary install dir |
| `~/.omp/agent/models.yml` | Write | Rewrites `freepi.baseUrl` to the proxy URL (only when `FREEPI_FREE_ONLY` ≠ `0` and a `freepi` block exists) |
| `%LOCALAPPDATA%\Programs\freepi-bridge\` (Windows), `~/.local/bin/` (Unix) | Read | Known binary install locations checked before download |

Network: HTTP to `127.0.0.1` (daemon + proxy), HTTPS to `https://api.freepi.ai/client-version` and
`https://github.com/ihsan-ramadhan/freepi-bridge/releases` (binary download, tag `v0.2.1`). The
extension opens one local listener — the filtering proxy on `127.0.0.1` — and never accepts
connections from other hosts.

## Architecture

```text
omp-freepi-bridge/
├── src/index.ts                # whole extension: token, binary, daemon, proxy, provider, commands
├── dist/index.js               # esbuild bundle loaded by OMP (built by `npm run build`)
├── package.json                # pi.extensions → ./dist/index.js; build/prepublishOnly scripts
├── .omp-plugin/marketplace.json# OMP marketplace entry
├── NOTICE                      # MIT here, GPL-3.0-only for the upstream binary
├── LICENSE                     # MIT
└── README.md
```

Request flow:

```text
OMP session ──▶ provider "freepi" (http://127.0.0.1:<proxyPort>/v1)
                     │
                     ▼
        filtering proxy (this extension)
          ├─ GET /v1/models → free ids only, ordered, from pi-models.json
          ├─ POST /v1/chat/completions
          │    ├─ premium/unknown id → rewrite to best free model
          │    ├─ 429 / "concurrent" → retry same model ≤3× (1.2/2.4/3.6 s)
          │    ├─ 403/408/409/425/429/500/502/503/504 → next free model
          │    └─ bridge failure → healBridge(): re-probe/spawn daemon, setEndpoint()
          └─ success → passthrough + x-freepi-model header
                     │
                     ▼
        freepi-bridge daemon (127.0.0.1:8787) ──▶ https://api.freepi.ai
```

Startup is non-blocking: the provider is registered synchronously from cache, the daemon bring-up
and tier lookup run in the background, and failures surface as `freepi: bridge offline — …` status
instead of stalling `omp models`.

## Development

```bash
npm install
bun test           # JSONL shape, redaction, and token leakage
npm run build      # esbuild → dist/index.js
```

`bun test` is the only scripted check besides the build. A pre-commit hook runs it. Activate the
hook once per clone with `git config core.hooksPath .githooks`. Smoke-test the bundle in OMP:

```bash
omp --no-extensions -e ./dist/index.js -p "Reply with exactly: ok"
```

Or link a local checkout into your OMP install and use `/freepi status` inside a session.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `freepi: bridge offline — …` status | No healthy daemon and spawn failed (stderr is included) | Read the error, check `/freepi logs`, verify `/freepi token` and `/freepi install`, then `/freepi refresh-models` |
| `freepi-bridge binary not available. Run '/freepi install' or install freepi-bridge manually.` | No binary on PATH or in known locations, and download failed | `/freepi install`, or set `FREEPI_BRIDGE_BIN`, or put `freepi-bridge` on PATH |
| `401` / token missing | No FreePi token found | `npx free-pi-cli@latest`, or set `FREEPI_TOKEN` |
| `freepi-bridge: tidak ada port bebas untuk daemon` | All candidate ports (8787–8793) are taken | Free a port or set `FREEPI_BRIDGE_PORT` |
| `403 At capacity for free users` | Requested model needs premium credits | The proxy reroutes to a free model; with `FREEPI_FREE_ONLY=0` pick a free id yourself |
| Catalog still shows paid models | OMP cached discovery from before the proxy was up | `omp models refresh freepi` |
| `freepi: filter proxy gagal - …` status | Proxy could not bind | Usually transient; restart OMP, or set `FREEPI_PROXY_PORT` to a free port |
| Daemon stuck | Daemon hung but process alive | `/freepi restart`, then `/freepi logs` |
| Status URL shows a port other than 8788 | Port fallback picked a free port for daemon/proxy | Update anything pinned to the old URL; the proxy URL in `models.yml` is kept in sync automatically |

## Security notes

- The proxy and the daemon both bind to `127.0.0.1` only; nothing listens on external interfaces.
- The FreePi token is read from the three documented locations, never written by this extension,
  and only ever sent as a Bearer header to `https://api.freepi.ai/client-version`. It is masked
  (first 6 + last 6 chars) in command output.
- Extension logs hold event names, counts, statuses, model ids, and short error messages only.
  Sensitive keys are dropped, URL query strings and userinfo are stripped, inline credential values
  are redacted, long values are cut at 200 characters, stacks are omitted, and file writes are
  disabled by `OMP_PLUGIN_LOG=0`.
- When no binary exists, the extension downloads the upstream `freepi-bridge` v0.2.1 release asset
  and verifies it against the published `.sha256` file when available; a mismatch aborts with
  `freepi-bridge checksum mismatch`.
- The proxy forwards request headers to the local daemon, rewriting only `host` and
  `content-length` when the model id changes.
- The binary is executed as a separate process over local HTTP; it is not bundled, linked, or
  redistributed by this package (see [NOTICE](NOTICE)).

## License

MIT for this extension — see [LICENSE](LICENSE). The upstream `freepi-bridge` binary it downloads
and runs is licensed GPL-3.0-only by ihsan-ramadhan and is not distributed with this package; see
[NOTICE](NOTICE). Not affiliated with FreePi.
