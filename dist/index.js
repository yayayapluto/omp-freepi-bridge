var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/index.ts
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
var EXTENSION_NAME = "freepi";
var EXTENSION_VERSION = "0.1.0";
var HOST = "127.0.0.1";
var DEFAULT_PORT = 8787;
var REPO = "ihsan-ramadhan/freepi-bridge";
var RELEASE_TAG = "v0.2.1";
var STATE_DIR = path.join(os.homedir(), ".freepi-bridge");
var STATE_FILE = path.join(STATE_DIR, "state.json");
var CONFIG_ENV = path.join(STATE_DIR, "config.env");
var MODELS_CACHE_FILE = path.join(STATE_DIR, "pi-models.json");
var BIN_DIR = path.join(os.homedir(), ".pi-freepi-bridge", "bin");
var CREDENTIALS_FILE = path.join(os.homedir(), ".free-pi", "agent", "credentials.json");
var MODEL_BASE = {
  api: "openai-completions",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 2e5,
  maxTokens: 16384,
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: true }
};
function isWindows() {
  return process.platform === "win32";
}
function exeName() {
  return isWindows() ? "freepi-bridge.exe" : "freepi-bridge";
}
function maskToken(tok) {
  if (!tok) return null;
  if (tok.length <= 12) return "****";
  return tok.slice(0, 6) + "\u2026" + tok.slice(-6);
}
function signInGuide() {
  return `FreePi token not found. Sign in once:
  npx free-pi-cli@latest   # GitHub login, then quit. Token saved to ~/.free-pi/agent/credentials.json
or set:  FREEPI_TOKEN=eyJ...  freepi-bridge start --bg
On headless hosts, copy ~/.free-pi/agent/credentials.json from a machine where you signed in.`;
}
function tokenSource() {
  const env = process.env.FREEPI_TOKEN;
  if (env && env.trim()) {
    return { has: true, source: "env FREEPI_TOKEN", masked: maskToken(env.trim()) };
  }
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
      const tok = data?.token || data?.access_token || null;
      if (tok) return { has: true, source: "~/.free-pi/agent/credentials.json", masked: maskToken(tok) };
    }
  } catch {
  }
  try {
    if (fs.existsSync(CONFIG_ENV)) {
      const text = fs.readFileSync(CONFIG_ENV, "utf8");
      const m = text.match(/^\s*FREEPI_TOKEN\s*=\s*(.+?)\s*$/m);
      if (m?.[1]) return { has: true, source: "~/.freepi-bridge/config.env", masked: maskToken(m[1]) };
    }
  } catch {
  }
  return { has: false, source: "none", masked: null };
}
function which(name) {
  const pathEnv = process.env.PATH || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts = isWindows() ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const cand = path.join(dir, name + ext);
      try {
        if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
      } catch {
      }
    }
  }
  return null;
}
function knownInstallLocations() {
  const name = exeName();
  const cands = [];
  if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA || "";
    cands.push(path.join(localAppData, "Programs", "freepi-bridge", name));
  } else {
    cands.push(path.join(os.homedir(), ".local", "bin", name));
  }
  cands.push(path.join(BIN_DIR, name));
  return cands;
}
function resolveBinaryPath() {
  if (process.env.FREEPI_BRIDGE_BIN) return process.env.FREEPI_BRIDGE_BIN;
  const fromPath = which(exeName());
  if (fromPath) return fromPath;
  for (const c of knownInstallLocations()) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
    }
  }
  return null;
}
function assetName() {
  if (isWindows()) return "freepi-bridge-windows-x86_64.zip";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `freepi-bridge-${process.platform}-${arch}.tar.gz`;
}
function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const crypto = __require("node:crypto");
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(file);
    stream.on("data", (d) => hash.update(d));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
function fetchBytes(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? __require("node:https") : __require("node:http");
    const req = mod.get(
      u,
      { headers: { "User-Agent": `freepi-bridge-ext/${EXTENSION_VERSION}` } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchBytes(res.headers.location).then(resolve, reject);
          return;
        }
        if (!res.ok && res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(6e4, () => req.destroy(new Error("timeout")));
  });
}
async function ensureBinaryInstalled() {
  const existing = resolveBinaryPath();
  if (existing) return existing;
  const asset = assetName();
  const url = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${asset}`;
  let sha = null;
  try {
    const shaText = await fetchBytes(url + ".sha256").catch(() => "");
    const first = shaText.split(/\s+/)[0];
    if (/^[0-9a-f]{64}$/.test(first)) sha = first;
  } catch {
  }
  const data = await fetchBytes(url);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (isWindows()) {
    const zipPath = path.join(BIN_DIR, asset);
    fs.writeFileSync(zipPath, data);
    const { execSync } = __require("node:child_process");
    execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${BIN_DIR}' -Force"`, {
      stdio: "ignore"
    });
    const exe = path.join(BIN_DIR, exeName());
    fs.chmodSync(exe, 493);
    if (sha) {
      const actual = await sha256OfFile(exe);
      if (actual !== sha) throw new Error(`freepi-bridge checksum mismatch: expected ${sha}, got ${actual}`);
    }
    return exe;
  } else {
    const tarPath = path.join(BIN_DIR, asset);
    fs.writeFileSync(tarPath, data);
    const { execSync } = __require("node:child_process");
    execSync(`tar -xzf '${tarPath}' -C '${BIN_DIR}'`, { stdio: "ignore" });
    const bin = path.join(BIN_DIR, exeName());
    fs.chmodSync(bin, 493);
    if (sha) {
      const actual = await sha256OfFile(bin);
      if (actual !== sha) throw new Error(`freepi-bridge checksum mismatch: expected ${sha}, got ${actual}`);
    }
    return bin;
  }
}
function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const d = JSON.parse(raw);
    return typeof d === "object" && d !== null ? d : null;
  } catch {
    return null;
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function healthz(endpoint) {
  const { promise, resolve } = Promise.withResolvers();
  const req = http.get(
    `http://${endpoint.host}:${endpoint.port}/health`,
    { timeout: 1500 },
    (res) => resolve(res.statusCode === 200)
  );
  req.on("error", () => resolve(false));
  req.on("timeout", () => {
    req.destroy();
    resolve(false);
  });
  return promise;
}
function findFreePort(start) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const server = net.createServer();
  server.unref();
  server.on("error", reject);
  server.listen(start, HOST, () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : start;
    server.close(() => resolve(port));
  });
  return promise;
}
function spawnDaemon(binary, port) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const child = spawn(binary, ["start", "--bg", "--port", String(port), "--bind", HOST], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  let done = false;
  const timer = setTimeout(() => {
    if (!done) {
      done = true;
      reject(new Error(`freepi-bridge did not answer /health on port ${port}`));
    }
  }, 15e3);
  const check = async () => {
    if (done) return;
    try {
      await new Promise((r) => setTimeout(r, 300));
      const st = readState();
      if (st && st.port) {
        if (await healthz({ host: HOST, port: st.port })) {
          done = true;
          clearTimeout(timer);
          resolve({ port: st.port, pid: st.pid });
        } else {
          check();
        }
      } else {
        check();
      }
    } catch {
      check();
    }
  };
  check();
  child.on("error", (err) => {
    if (!done) {
      done = true;
      clearTimeout(timer);
      reject(err);
    }
  });
  return promise;
}
async function ensureDaemonRunning(binary) {
  const state = readState();
  if (state && state.port && pidAlive(state.pid || -1)) {
    if (await healthz({ host: HOST, port: state.port })) {
      return { host: HOST, port: state.port, pid: state.pid, startedByUs: false };
    }
  }
  let port = DEFAULT_PORT;
  try {
    port = await findFreePort(DEFAULT_PORT).catch(() => DEFAULT_PORT);
  } catch {
    port = DEFAULT_PORT;
  }
  const { port: boundPort, pid } = await spawnDaemon(binary, port);
  return { host: HOST, port: boundPort, pid, startedByUs: true };
}
async function stopDaemon() {
  const state = readState();
  if (!state?.pid) return;
  try {
    process.kill(state.pid);
  } catch {
  }
}
function modelsEndpoint(endpoint) {
  return `http://${endpoint.host}:${endpoint.port}/v1/models`;
}
function fetchModelsJson(endpoint) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const req = http.get(
    modelsEndpoint(endpoint),
    { signal: AbortSignal.timeout(5e3), headers: { Accept: "application/json" } },
    (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          resolve(null);
        }
      });
      res.on("error", () => resolve(null));
    }
  );
  req.on("error", () => resolve(null));
  req.on("timeout", () => {
    req.destroy();
    resolve(null);
  });
  return promise;
}
function toProviderModel(m) {
  const id = String(m.id || "unknown");
  return { ...MODEL_BASE, id, name: id };
}
async function fetchModels(endpoint) {
  const first = await fetchModelsJson(endpoint);
  if (first && typeof first === "object" && "data" in first && Array.isArray(first.data)) {
    const items = first.data;
    if (items.length > 0) {
      const models = [];
      for (const m of items) {
        if (m && typeof m === "object" && "id" in m && typeof m.id === "string") {
          models.push(toProviderModel(m));
        }
      }
      if (models.length > 0) {
        saveModelsCache(models);
        return models;
      }
    }
  }
  const cached = loadModelsCache();
  if (cached.length > 0) return cached;
  return [];
}
function saveModelsCache(models) {
  try {
    fs.mkdirSync(path.dirname(MODELS_CACHE_FILE), { recursive: true });
    fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify({ savedAt: Date.now(), models }));
  } catch {
  }
}
function loadModelsCache() {
  try {
    const d = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, "utf8"));
    if (Array.isArray(d?.models)) return d.models.filter((m) => typeof m?.id === "string");
  } catch {
  }
  return [];
}
async function index_default(pi) {
  let currentEndpoint = { host: HOST, port: DEFAULT_PORT };
  let currentModels = [];
  const binary = resolveBinaryPath();
  const token = tokenSource();
  if (!token.has) {
    pi.ui.notify(`freepi: ${signInGuide().split("\n")[0]}`, "warning");
  }
  const registerProvider = async () => {
    const bin = binary || await ensureBinaryInstalled().catch(() => null);
    if (!bin) throw new Error("freepi-bridge binary not available. Run `/freepi install` or install freepi-bridge manually.");
    const info = await ensureDaemonRunning(bin);
    currentEndpoint = info;
    let models = await fetchModels(currentEndpoint);
    if (models.length === 0) models = loadModelsCache();
    currentModels = models;
    pi.registerProvider(EXTENSION_NAME, {
      baseUrl: `http://${currentEndpoint.host}:${currentEndpoint.port}/v1`,
      apiKey: "freepi",
      api: "openai-completions",
      models
    });
    pi.setStatus(EXTENSION_NAME, `${models.length} models on ${currentEndpoint.host}:${currentEndpoint.port}`);
  };
  try {
    await registerProvider();
  } catch (err) {
  }
  pi.registerCommand(EXTENSION_NAME, {
    description: "freepi-bridge daemon & provider: status | token | doctor | models | refresh-models | start | stop | restart | ads | logs | install | help",
    getArgumentCompletions: (prefix) => [
      "status",
      "token",
      "doctor",
      "models",
      "refresh-models",
      "start",
      "stop",
      "restart",
      "ads",
      "logs",
      "install",
      "help"
    ].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const parts = String(args || "").trim().split(/\s+/);
      const sub = parts[0] || "status";
      switch (sub) {
        case "status": {
          const alive = await healthz(currentEndpoint);
          const models = loadModelsCache().length;
          const tok = tokenSource();
          let binInfo = "unknown";
          try {
            const bin = resolveBinaryPath() || await ensureBinaryInstalled().catch(() => null);
            if (!bin) binInfo = "missing";
            else {
              const ver = await binaryVersion(bin);
              binInfo = ver || "installed";
            }
          } catch {
            binInfo = "installed";
          }
          ctx.ui.notify(
            `freepi ${EXTENSION_VERSION}: daemon ${alive ? `online ${currentEndpoint.host}:${currentEndpoint.port}` : "offline"} \xB7 models=${models} \xB7 token=${tok.has ? "yes (" + tok.source + ")" : "missing: /freepi token"} \xB7 binary=${binInfo}`,
            alive ? "info" : "warning"
          );
          break;
        }
        case "token": {
          const tok = tokenSource();
          ctx.ui.notify(
            tok.has ? `FreePi token: ${tok.masked} (${tok.source})` : signInGuide(),
            tok.has ? "info" : "warning"
          );
          break;
        }
        case "doctor": {
          const bin = resolveBinaryPath() || await ensureBinaryInstalled().catch(() => null);
          if (!bin) {
            ctx.ui.notify("freepi-bridge binary not installed. Run `/freepi install`.", "error");
            break;
          }
          const out = await runCli(bin, ["doctor", "--json"]);
          ctx.ui.notify(`freepi-bridge doctor: ${out || "(no output)"}`, "info");
          break;
        }
        case "models": {
          const models = currentModels.length ? currentModels : loadModelsCache();
          if (models.length === 0) {
            ctx.ui.notify("No models yet \u2014 start the daemon (`/freepi start`) or run `/freepi refresh-models`.", "warning");
          } else {
            ctx.ui.notify(`freepi models: ${models.map((m) => m.id).join(", ")}`, "info");
          }
          break;
        }
        case "refresh-models": {
          const bin = resolveBinaryPath() || await ensureBinaryInstalled().catch(() => null);
          if (!bin) {
            ctx.ui.notify("freepi-bridge binary not installed. Run `/freepi install`.", "error");
            break;
          }
          try {
            await registerProvider();
            ctx.ui.notify(`freepi: re-registered ${currentModels.length} models from ${currentEndpoint.host}:${currentEndpoint.port}`, "info");
          } catch (err) {
            ctx.ui.notify(`freepi: refresh-models failed \u2014 ${String(err)}`, "error");
          }
          break;
        }
        case "start": {
          const bin = resolveBinaryPath() || await ensureBinaryInstalled().catch(() => null);
          if (!bin) {
            ctx.ui.notify("freepi-bridge binary not installed. Run `/freepi install`.", "error");
            break;
          }
          try {
            const info = await ensureDaemonRunning(bin);
            currentEndpoint = info;
            await registerProvider();
            ctx.ui.notify(`freepi daemon started on ${currentEndpoint.host}:${currentEndpoint.port} (pid ${info.pid})`, "info");
          } catch (err) {
            ctx.ui.notify(`freepi: start failed \u2014 ${String(err)}`, "error");
          }
          break;
        }
        case "stop": {
          await stopDaemon();
          pi.setStatus(EXTENSION_NAME, void 0);
          ctx.ui.notify("freepi daemon stopped.", "info");
          break;
        }
        case "restart": {
          await stopDaemon();
          const bin = resolveBinaryPath() || await ensureBinaryInstalled().catch(() => null);
          if (!bin) {
            ctx.ui.notify("freepi-bridge binary not installed. Run `/freepi install`.", "error");
            break;
          }
          try {
            const info = await ensureDaemonRunning(bin);
            currentEndpoint = info;
            await registerProvider();
            ctx.ui.notify(`freepi daemon restarted on ${currentEndpoint.host}:${currentEndpoint.port}`, "info");
          } catch (err) {
            ctx.ui.notify(`freepi: restart failed \u2014 ${String(err)}`, "error");
          }
          break;
        }
        case "ads": {
          const bin = resolveBinaryPath() || await ensureBinaryInstalled().catch(() => null);
          if (!bin) {
            ctx.ui.notify("freepi-bridge binary not installed. Run `/freepi install`.", "error");
            break;
          }
          const out = await runCli(bin, ["ads"]);
          ctx.ui.notify(`freepi ads: ${out || "(no output)"}`, "info");
          break;
        }
        case "logs": {
          const logPath = path.join(STATE_DIR, "bridge.log");
          try {
            const lines = fs.readFileSync(logPath, "utf8").trim().split("\n").slice(-8).join("\n");
            ctx.ui.notify(`freepi-bridge logs:
${lines}`, "info");
          } catch {
            ctx.ui.notify("No bridge.log yet.", "info");
          }
          break;
        }
        case "install": {
          try {
            const bin = await ensureBinaryInstalled();
            const ver = await binaryVersion(bin);
            ctx.ui.notify(`freepi-bridge installed: ${bin} (${ver})`, "info");
          } catch (err) {
            ctx.ui.notify(`freepi: install failed \u2014 ${String(err)}`, "error");
          }
          break;
        }
        default:
          ctx.ui.notify(
            `freepi ${EXTENSION_VERSION}: status | token | doctor | models | refresh-models | start | stop | restart | ads | logs | install | help`,
            "info"
          );
      }
    }
  });
}
async function binaryVersion(bin) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const { execFileSync } = __require("node:child_process");
  try {
    const out = execFileSync(bin, ["version"], { encoding: "utf8", timeout: 5e3 });
    resolve(out.trim().split("\n")[0] || "unknown");
  } catch {
    resolve("unknown");
  }
  return promise;
}
function runCli(bin, argv) {
  const { promise, resolve } = Promise.withResolvers();
  const { execFileSync } = __require("node:child_process");
  try {
    resolve(execFileSync(bin, argv, { encoding: "utf8", timeout: 15e3 }).trim());
  } catch {
    resolve("");
  }
  return promise;
}
export {
  index_default as default,
  ensureBinaryInstalled,
  ensureDaemonRunning,
  fetchModels,
  loadModelsCache,
  resolveBinaryPath,
  stopDaemon,
  tokenSource
};
