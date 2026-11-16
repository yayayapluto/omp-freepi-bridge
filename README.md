# freepi-bridge OMP extension

Plug your **FreePi** account into pi/OMP as the `freepi` model provider.

The extension spawns (or reuses) the [freepi-bridge](https://github.com/ihsan-ramadhan/freepi-bridge) local daemon and registers it as an OpenAI-compatible provider — no API key required.

---

## Install

```bash
git clone https://github.com/yayayapluto/omp-freepi-bridge.git
omp plugin install ./omp-freepi-bridge
```

Verify it loaded:

```bash
omp plugin list | grep freepi
```

> The plugin is registered as `omp-freepi-bridge` (from `package.json`), matching the repo name.

---

## 1. Get a FreePi token (once per machine)

```bash
npx free-pi-cli@latest
```

Sign in with GitHub, then quit. The token is saved to `~/.free-pi/agent/credentials.json`.

Alternatives, in priority order:

| Source | How |
|---|---|
| `FREEPI_TOKEN` env var | `set FREEPI_TOKEN=eyJ...` (Windows) / `export FREEPI_TOKEN=eyJ...` |
| Credentials file | `~/.free-pi/agent/credentials.json` (from the CLI above) |
| Daemon config | `FREEPI_TOKEN=...` in `~/.freepi-bridge/config.env` |

Check what was detected: `/freepi token`

---

## 2. Use a model

```bash
omp launch --model freepi/particle -p "hello"
```

On first use the extension will:

1. find `freepi-bridge` on `PATH`, or download the matching release into `~/.omp-freepi-bridge/bin/`
2. start the daemon on `127.0.0.1:8787`
3. start the free-model proxy on `127.0.0.1:8788` and point `freepi` at it

List what is available: `/freepi models`

### Only free models are registered

Some FreePi models are premium-credit only and fail with:

```
403 At capacity for free users. Available with premium credits: /buy-credits
```

`/v1/models` from the bridge does not carry the tier flag, so the extension reads
`https://api.freepi.ai/client-version` (authenticated with your token), keeps only
entries where `free === true`, and caches them in `~/.freepi-bridge/free-models.json`.

pi/OMP re-discovers models from the provider endpoint, so filtering the registered
list is not enough. The extension therefore puts a small local proxy between OMP
and the daemon:

- `GET /v1/models` → only the free models, in priority order
- `POST /v1/chat/completions` → a premium model id is rerouted to the best free model
- upstream `403`/`429`/`5xx` → `429 concurrent` retries the same model with backoff, everything else walks the chain
- the model actually used is returned in the `x-freepi-model` response header

OMP also keeps its own provider config in `~/.omp/agent/models.yml`, which overrides
the runtime registration. The extension rewrites the `freepi.baseUrl` entry to the
proxy URL on startup, so discovery (`omp models`) and chat both go through the filter.
The proxy listens on `8788` (daemon port `+1`).

Run `omp models refresh freepi` once after upgrading from a version that pointed at
the daemon directly; OMP caches the discovered list.

Fallback chain (best → least), also used when tier lookup is unavailable:

1. `particle`
2. `deepseek-v4.1-flash`
3. `glm-5.3-flash`
4. `deepseek-v4-flash`

To expose everything anyway (e.g. you bought credits), set `FREEPI_FREE_ONLY=0`.

---

## Commands

| Command | Does |
|---|---|
| `/freepi status` | daemon + provider + token status |
| `/freepi token` | show token source, or sign-in guide |
| `/freepi doctor` | run `freepi-bridge doctor` |
| `/freepi models` | list registered model ids |
| `/freepi refresh-models` | re-fetch `/v1/models`, re-register provider |
| `/freepi start` | start the daemon |
| `/freepi stop` | stop the daemon |
| `/freepi restart` | stop + start |
| `/freepi ads` | print the FreePi ad page URL |
| `/freepi logs` | tail `~/.freepi-bridge/bridge.log` |
| `/freepi install` | install/verify the `freepi-bridge` binary |

---

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `FREEPI_TOKEN` | unset | FreePi JWT; highest priority |
| `FREEPI_BRIDGE_BIN` | unset | Explicit path to the `freepi-bridge` binary |
| `FREEPI_BRIDGE_PORT` | `8787` | Daemon listen port |
| `FREEPI_AUTO_AD` | `1` | Auto-report ads (`0` disables; open `/ads` manually) |
| `FREEPI_FREE_ONLY` | `1` | Register only credit-free models (`0` shows all, disables the proxy + `models.yml` rewrite) |
| `FREEPI_PROXY_PORT` | daemon port `+1` | Port for the free-model filter proxy |
| `FREEPI_BASE_URL` | `https://api.freepi.ai` | Upstream FreePi API used for tier lookup |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `freepi-bridge binary not found` | `/freepi install`, or put the binary on `PATH` |
| `401` / login errors | run `npx free-pi-cli@latest`, or set `FREEPI_TOKEN` |
| Port already in use | set `FREEPI_BRIDGE_PORT` |
| `403 ads_required` | set `FREEPI_AUTO_AD=0` and open the `/ads` page the bridge prints |
| `403 At capacity for free users` | premium model id; the proxy reroutes it, but `FREEPI_FREE_ONLY=0` bypasses that — use a free id |
| Catalog still lists paid models | `omp models refresh freepi` (OMP caches the discovered list) |
| Daemon stuck | `/freepi restart`, logs via `/freepi logs` |

---

## How it works

```
pi/OMP ──▶ provider "freepi" (http://127.0.0.1:8788/v1, filter proxy)
                 │
                 ▼
          free-model proxy  ──▶  freepi-bridge daemon (127.0.0.1:8787)
                 │                        │
                 │                        └─ state: ~/.freepi-bridge/state.json
                 └─ free tier: ~/.freepi-bridge/free-models.json
                    models cache: ~/.freepi-bridge/pi-models.json
                    OMP provider config: ~/.omp/agent/models.yml
```

Extension load never touches the network: the provider is registered from the cached
model list immediately and refreshed in the background, so `omp models` stays fast.

The extension writes no credentials itself. It only reads the token locations listed above and hands control to the daemon.

---

## Development

```bash
npm install
npm run build          # esbuild → dist/index.js
omp plugin install .   # link local build
```

Source lives in `src/index.ts`; `dist/index.js` is the shipped bundle.

---

## License and attribution

**This extension:** MIT — see [LICENSE](LICENSE).

**Upstream:** [freepi-bridge](https://github.com/ihsan-ramadhan/freepi-bridge) by [ihsan-ramadhan](https://github.com/ihsan-ramadhan), licensed **GPL-3.0-only**. The daemon itself is not modified or redistributed here.

This extension does **not** bundle or link the GPL binary. At runtime it downloads the unmodified upstream release and executes it as a separate process, communicating only over HTTP. The binary remains governed by GPL-3.0-only. See [NOTICE](NOTICE).
