# freepi-bridge OMP extension

Plug your **FreePi** account into pi/OMP as the `freepi` model provider.

The extension spawns (or reuses) the [freepi-bridge](https://github.com/ihsan-ramadhan/freepi-bridge) local daemon and registers it as an OpenAI-compatible provider — no API key required.

---

## Install

```bash
git clone https://github.com/yayayapluto/pi-freepi-bridge.git
omp plugin install ./pi-freepi-bridge
```

Verify it loaded:

```bash
omp plugin list | grep freepi
```

> The plugin is registered as `pi-freepi-bridge` (from `package.json`), not the repo name.

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

1. find `freepi-bridge` on `PATH`, or download the matching release into `~/.pi-freepi-bridge/bin/`
2. start the daemon on `127.0.0.1:8787`
3. fetch `/v1/models` and register the `freepi` provider

List what is available: `/freepi models`

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

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `freepi-bridge binary not found` | `/freepi install`, or put the binary on `PATH` |
| `401` / login errors | run `npx free-pi-cli@latest`, or set `FREEPI_TOKEN` |
| Port already in use | set `FREEPI_BRIDGE_PORT` |
| `403 ads_required` | set `FREEPI_AUTO_AD=0` and open the `/ads` page the bridge prints |
| Daemon stuck | `/freepi restart`, logs via `/freepi logs` |

---

## How it works

```
pi/OMP ──▶ provider "freepi" (http://127.0.0.1:8787/v1)
                 │
                 ▼
          freepi-bridge daemon  ──▶  FreePi account
                 │
                 └─ state: ~/.freepi-bridge/state.json
                    models cache: ~/.freepi-bridge/pi-models.json
```

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
