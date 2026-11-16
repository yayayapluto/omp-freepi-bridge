# pi-freepi-bridge

Free OpenAI-compatible model provider for pi via the [freepi-bridge](https://github.com/ihsan-ramadhan/freepi-bridge) local daemon.

Registers your FreePi account as the `freepi` provider, so any pi/OMP session can use your FreePi account without an API key.

## Quick Start

### 1. Install (once)

```bash
omp plugin install /path/to/pi-freepi-bridge
```

### 2. Ensure your FreePi token is set (one-time)

The extension checks these sources in order:

| Source | How |
|---|---|
| `FREEPI_TOKEN` env var | `set FREEPI_TOKEN=eyJ... && omp launch` |
| `~/.free-pi/agent/credentials.json` | Run `npx free-pi-cli@latest` once (GitHub login, then quit) |
| `~/.freepi-bridge/config.env` | Edit this file and set `FREEPI_TOKEN=...` |

If no token is found, the extension warns on startup: `/freepi token`.

### 3. Start the daemon (auto on first use)

The extension auto-spawns a `freepi-bridge` instance on `127.0.0.1:8787` the first time you use it, or you can pre-start:

```bash
/freepi start
```

### 4. Use a model

```bash
omp launch --model freepi/particle -p "say hi"
```

Available model ids: `particle`, `deepseek-v4.1-flash`, `glm-5.3-flash`, `deepseek-v4-flash`, `abliterated-large-flash`, `abliterated-large-v2`, `mimo-v2.6-flash`, `kimi-k3.1-pro`, `solar-pro-4`, `uncensored-1.2`, plus any models your FreePi account serves.

### 5. Commands

| Command | Does |
|---|---|
| `/freepi status` | daemon & provider status + model count |
| `/freepi token` | show token source + sign-in guide |
| `/freepi doctor` | bridge health + token check |
| `/freepi models` | list registered model ids |
| `/freepi refresh-models` | re-fetch `/v1/models` and re-register |
| `/freepi start` | start / restart the daemon |
| `/freepi stop` | stop the daemon |
| `/freepi restart` | stop + start the daemon |
| `/freepi ads` | print the FreePi ad page URL |
| `/freepi logs` | tail bridge.log |
| `/freepi install` | ensure freepi-bridge binary is installed |

Run any of: `/freepi help` or `/freepi <command>`.

### 6. Manual freepi-bridge binary install (optional)

If the extension cannot find `freepi-bridge` on PATH, run:

```bash
/freepi install
```

This downloads the matching release from GitHub (`ihsan-ramadhan/freepi-bridge`) and places it in `~/.pi-freepi-bridge/bin/` with checksum verification.

### 7. Linux/macOS / Windows notes

- **Linux/macOS:** binary is a static ELF; placed in `~/.pi-freepi-bridge/bin/`, made executable, and added to PATH by the `install` command.
- **Windows:** binary is a `.exe` inside a zip. The `install` command extracts it via PowerShell `Expand-Archive`. Place the directory in your system PATH if you want to run it outside pi.

### 8. Multi-user / shared installs

The daemon state lives in `~/.freepi-bridge/state.json` — shared across any manually started `freepi-bridge` and this extension. The extension auto-reuses a running daemon if already healthy.

### 9. Troubleshooting

**`401` / token not found** — set `FREEPI_TOKEN` env var or run `npx free-pi-cli@latest`.

**`freepi-bridge binary not found`** — run `/freepi install` or ensure the binary is on PATH.

**Daemon port conflict** — the extension auto-picks a free port; change with `FREEPI_BRIDGE_PORT` env var.

**`403 ads_required`** — the bridge reports one ad every 10 minutes by default. Set `FREEPI_AUTO_AD=0` in `~/.freepi-bridge/config.env` to disable (open the printed `/ads` page in a browser instead).

### 10. License

MIT. See LICENSE.

---

## Architecture

The extension:

1. Finds or downloads `freepi-bridge` (cross-platform: Windows `.exe` via zip, Linux/macOS tar.gz).
2. Spawns it as a background daemon (`freepi-bridge start --bg`).
3. Probes `/health` and `/v1/models` to build the model list.
4. Registers the provider `freepi` with `baseUrl: http://127.0.0.1:8787/v1` and the fetched models.
5. Exposes `/freepi` commands for daemon control, token management, and model inspection.
6. Keeps the daemon alive across pi/OMP sessions; reuses a running daemon if already healthy.

Model data flows: `freepi-bridge /v1/models` → extension cache (`~/.freepi-bridge/pi-models.json`) → `pi.registerProvider("freepi", ...)` → any pi/OMP session can route requests to `freepi/<model_id>`.

## Environment Variables

| Variable | Default | Effect |
|---|---|---|
| `FREEPI_TOKEN` | unset | FreePi JWT; env wins over `config.env` |
| `FREEPI_BRIDGE_BIN` | unset | Explicit path to `freepi-bridge` binary |
| `FREEPI_BRIDGE_PORT` | `8787` | Override daemon listen port |
| `FREEPI_AUTO_AD` | `1` | Auto-report ads (`0` = disable, open `/ads` in browser) |
| `FREEPI_BRIDGE_DOWNLOAD_BASE` | `https://github.com/ihsan-ramadhan/freepi-bridge/releases` | Mirror for binary downloads |

## Development

```bash
# Build
npm run build

# Link for local development
omp plugin install /path/to/pi-freepi-bridge

# Run the pi/OMP session with this model:
omp launch --model freepi/particle -p "hello"
```

## Extending

To add more model features (e.g., `thinkingLevelMap`, `inputLimits`, `promptCache`), modify the `MODEL_BASE` object in `src/index.ts` and bump the version. The extension auto-propagates model metadata to pi/OMP.