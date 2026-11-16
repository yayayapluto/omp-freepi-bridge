/**
 * freepi — pi/OMP extension for the freepi-bridge local daemon.
 *
 * Spawns (or reuses) a freepi-bridge instance on 127.0.0.1:8787 and registers
 * it as the "freepi" OpenAI-completions provider, so any pi/OMP session can use
 * your FreePi account without an API key.
 *
 * Cross-platform: finds freepi-bridge on PATH / known install dirs, else
 * downloads the matching release asset from GitHub into ~/.omp-freepi-bridge/bin.
 *
 * Usage (inside pi/OMP):
 *   /freepi              → daemon & provider status
 *   /freepi token        → show FreePi token source + sign-in guide
 *   /freepi doctor       → bridge health & token check
 *   /freepi models       → list registered model ids
 *   /freepi refresh-models → re-fetch /v1/models and re-register provider
 *   /freepi start|stop|restart   → daemon control
 *   /freepi ads          → print the ad page URL
 *   /freepi logs         → tail bridge.log
 *   /freepi install      → ensure freepi-bridge binary is installed
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";

const EXTENSION_NAME = "freepi";
const EXTENSION_VERSION = "0.1.0";
const HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const REPO = "ihsan-ramadhan/freepi-bridge";
const RELEASE_TAG = "v0.2.1";

// Daemon state lives here (shared with any manually installed freepi-bridge).
const STATE_DIR = path.join(os.homedir(), ".freepi-bridge");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const CONFIG_ENV = path.join(STATE_DIR, "config.env");
const MODELS_CACHE_FILE = path.join(STATE_DIR, "pi-models.json");
const FREE_IDS_CACHE_FILE = path.join(STATE_DIR, "free-models.json");

// Upstream catalog (carries the per-model "free" flag the bridge drops).
const FREEPI_BASE_URL = (process.env.FREEPI_BASE_URL || "https://api.freepi.ai").replace(/\/+$/, "");
// Only expose models that don't require premium credits. Set FREEPI_FREE_ONLY=0 to disable.
const FREE_ONLY = process.env.FREEPI_FREE_ONLY !== "0";

// Extension-managed binary (only used if freepi-bridge isn't already available).
const BIN_DIR = path.join(os.homedir(), ".omp-freepi-bridge", "bin");

// OMP reads providers from models.yml; if `freepi` points at the bridge directly,
// discovery and chat bypass the proxy and paid ids slip through.
const MODELS_YML = path.join(os.homedir(), ".omp", "agent", "models.yml");

function syncModelsYml(baseUrl: string): boolean {
	if (!FREE_ONLY) return false;
	let text: string;
	try {
		text = fs.readFileSync(MODELS_YML, "utf8");
	} catch {
		return false;
	}
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((l) => /^\s{2}freepi:\s*$/.test(l));
	if (start === -1) return false;
	let end = start + 1;
	while (end < lines.length && /^\s{4}\S/.test(lines[end])) end++;
	const at = lines.findIndex((l, i) => i > start && i < end && /^\s+baseUrl:/.test(l));
	if (at === -1) return false;
	if (lines[at].trim() === `baseUrl: ${baseUrl}`) return false;
	lines[at] = `    baseUrl: ${baseUrl}`;
	try {
		fs.writeFileSync(MODELS_YML, lines.join("\n"));
		return true;
	} catch {
		return false;
	}
}

// FreePi CLI credential file (written once by `npx free-pi-cli@latest`).
const CREDENTIALS_FILE = path.join(os.homedir(), ".free-pi", "agent", "credentials.json");

type Endpoint = { host: string; port: number };
type DaemonInfo = Endpoint & { pid?: number; startedByUs: boolean };

const MODEL_BASE: Omit<ProviderModelConfig, "id" | "name"> = {
	api: "openai-completions",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 16_384,
	compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
};

function isWindows(): boolean {
	return process.platform === "win32";
}
function exeName(): string {
	return isWindows() ? "freepi-bridge.exe" : "freepi-bridge";
}
function maskToken(tok: string): string {
	if (!tok) return null;
	if (tok.length <= 12) return "****";
	return tok.slice(0, 6) + "…" + tok.slice(-6);
}
function signInGuide(): string {
	return `FreePi token not found. Sign in once:
  npx free-pi-cli@latest   # GitHub login, then quit. Token saved to ~/.free-pi/agent/credentials.json
or set:  FREEPI_TOKEN=eyJ...  freepi-bridge start --bg
On headless hosts, copy ~/.free-pi/agent/credentials.json from a machine where you signed in.`;
}

// ── FreePi token detection --------------------------------------------------
export function readToken(): { token: string | null; source: string; masked: string | null } {
	// Environment wins.
	const env = process.env.FREEPI_TOKEN;
	if (env && env.trim()) {
		return { token: env.trim(), source: "env FREEPI_TOKEN", masked: maskToken(env.trim()) };
	}
	// Credentials file written by `npx free-pi-cli@latest`.
	try {
		if (fs.existsSync(CREDENTIALS_FILE)) {
			const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
			const tok = data?.token || data?.access_token || null;
			if (tok) return { token: tok, source: "~/.free-pi/agent/credentials.json", masked: maskToken(tok) };
		}
	} catch {
		// ignore — file may be partial/invalid
	}
	// config.env fallback.
	try {
		if (fs.existsSync(CONFIG_ENV)) {
			const text = fs.readFileSync(CONFIG_ENV, "utf8");
			const m = text.match(/^\s*FREEPI_TOKEN\s*=\s*(.+?)\s*$/m);
			if (m?.[1]) return { token: m[1], source: "~/.freepi-bridge/config.env", masked: maskToken(m[1]) };
		}
	} catch {
		// ignore
	}
	return { token: null, source: "none", masked: null };
}

export function tokenSource(): { has: boolean; source: string; masked: string | null } {
	const { token, source, masked } = readToken();
	return { has: Boolean(token), source, masked };
}

// ── Binary resolution / download ------------------------------------------
function which(name: string): string | null {
	const pathEnv = process.env.PATH || "";
	const dirs = pathEnv.split(path.delimiter).filter(Boolean);
	const exts = isWindows() ? ["", ".exe", ".cmd", ".bat"] : [""];
	for (const dir of dirs) {
		for (const ext of exts) {
			const cand = path.join(dir, name + ext);
			try {
				if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
			} catch {
				// ignore
			}
		}
	}
	return null;
}

function knownInstallLocations(): string[] {
	const name = exeName();
	const cands: string[] = [];
	if (isWindows()) {
		const localAppData = process.env.LOCALAPPDATA || "";
		cands.push(path.join(localAppData, "Programs", "freepi-bridge", name));
	} else {
		cands.push(path.join(os.homedir(), ".local", "bin", name));
	}
	cands.push(path.join(BIN_DIR, name));
	return cands;
}

export function resolveBinaryPath(): string | null {
	if (process.env.FREEPI_BRIDGE_BIN) return process.env.FREEPI_BRIDGE_BIN;
	const fromPath = which(exeName());
	if (fromPath) return fromPath;
	for (const c of knownInstallLocations()) {
		try {
			if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
		} catch {
			// ignore
		}
	}
	return null;
}

function assetName(): string {
	if (isWindows()) return "freepi-bridge-windows-x86_64.zip";
	const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
	return `freepi-bridge-${process.platform}-${arch}.tar.gz`;
}

function sha256OfFile(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const crypto = require("node:crypto");
		const hash = crypto.createHash("sha256");
		const stream = fs.createReadStream(file);
		stream.on("data", (d) => hash.update(d));
		stream.on("end", () => resolve(hash.digest("hex")));
		stream.on("error", reject);
	});
}

function fetchBytes(url: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const mod = u.protocol === "https:" ? require("node:https") : require("node:http");
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
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => resolve(Buffer.concat(chunks)));
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.setTimeout(60_000, () => req.destroy(new Error("timeout")));
	});
}

export async function ensureBinaryInstalled(): Promise<string> {
	const existing = resolveBinaryPath();
	if (existing) return existing;

	const asset = assetName();
	const url = `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${asset}`;
	let sha: string | null = null;
	try {
		const shaText = await fetchBytes(url + ".sha256").catch(() => "");
		const first = shaText.split(/\s+/)[0];
		if (/^[0-9a-f]{64}$/.test(first)) sha = first;
	} catch {
		// sha optional
	}
	const data = await fetchBytes(url);
	fs.mkdirSync(BIN_DIR, { recursive: true });

	if (isWindows()) {
		const zipPath = path.join(BIN_DIR, asset);
		fs.writeFileSync(zipPath, data);
		const { execSync } = require("node:child_process");
		execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${BIN_DIR}' -Force"`, {
			stdio: "ignore",
		});
		const exe = path.join(BIN_DIR, exeName());
		fs.chmodSync(exe, 0o755);
		if (sha) {
			const actual = await sha256OfFile(exe);
			if (actual !== sha) throw new Error(`freepi-bridge checksum mismatch: expected ${sha}, got ${actual}`);
		}
		return exe;
	} else {
		const tarPath = path.join(BIN_DIR, asset);
		fs.writeFileSync(tarPath, data);
		const { execSync } = require("node:child_process");
		execSync(`tar -xzf '${tarPath}' -C '${BIN_DIR}'`, { stdio: "ignore" });
		const bin = path.join(BIN_DIR, exeName());
		fs.chmodSync(bin, 0o755);
		if (sha) {
			const actual = await sha256OfFile(bin);
			if (actual !== sha) throw new Error(`freepi-bridge checksum mismatch: expected ${sha}, got ${actual}`);
		}
		return bin;
	}
}

// ── Daemon lifecycle --------------------------------------------------------
function readState(): { host?: string; port?: number; pid?: number } | null {
	try {
		const raw = fs.readFileSync(STATE_FILE, "utf8");
		const d = JSON.parse(raw);
		return typeof d === "object" && d !== null ? d : null;
	} catch {
		return null;
	}
}


function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function healthz(endpoint: Endpoint): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const req = http.get(
		`http://${endpoint.host}:${endpoint.port}/health`,
		{ timeout: 1_500 },
		(res) => resolve(res.statusCode === 200),
	);
	req.on("error", () => resolve(false));
	req.on("timeout", () => {
		req.destroy();
		resolve(false);
	});
	return promise;
}

function findFreePort(start: number): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
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

function spawnDaemon(binary: string, port: number): Promise<{ port: number; pid?: number }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ port: number; pid?: number }>();
	const child = spawn(binary, ["start", "--bg", "--port", String(port), "--bind", HOST], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	let done = false;
	const timer = setTimeout(() => {
		if (!done) {
			done = true;
			reject(new Error(`freepi-bridge did not answer /health on port ${port}`));
		}
	}, 15_000);
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

export async function ensureDaemonRunning(binary: string): Promise<DaemonInfo> {
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

export async function stopDaemon(): Promise<void> {
	const state = readState();
	if (!state?.pid) return;
	try {
		process.kill(state.pid);
	} catch {
		// ignore
	}
}

// ── Model catalog -----------------------------------------------------------
function modelsEndpoint(endpoint: Endpoint): string {
	return `http://${endpoint.host}:${endpoint.port}/v1/models`;
}

function fetchModelsJson(endpoint: Endpoint): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const req = http.get(
		modelsEndpoint(endpoint),
		{ signal: AbortSignal.timeout(5_000), headers: { Accept: "application/json" } },
		(res) => {
			if (res.statusCode !== 200) {
				resolve(null);
				return;
			}
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString()));
				} catch {
					resolve(null);
				}
			});
			res.on("error", () => resolve(null));
		},
	);
	req.on("error", () => resolve(null));
	req.on("timeout", () => {
		req.destroy();
		resolve(null);
	});
	return promise;
}

function toProviderModel(m: { id?: string; object?: string; owned_by?: string }): ProviderModelConfig {
	const id = String(m.id || "unknown");
	return { ...MODEL_BASE, id, name: id };
}

function saveFreeIds(ids: string[]): void {
	try {
		fs.mkdirSync(path.dirname(FREE_IDS_CACHE_FILE), { recursive: true });
		fs.writeFileSync(FREE_IDS_CACHE_FILE, JSON.stringify({ savedAt: Date.now(), ids }));
	} catch {
		// ignore
	}
}

function loadFreeIds(): string[] {
	try {
		const d = JSON.parse(fs.readFileSync(FREE_IDS_CACHE_FILE, "utf8"));
		if (Array.isArray(d?.ids)) return d.ids.filter((id) => typeof id === "string");
	} catch {
		// ignore
	}
	return [];
}

/** Upstream catalog knows which models need premium credits; the bridge drops that flag. */
function fetchFreeModelIds(token: string | null): Promise<string[] | null> {
	if (!token) return Promise.resolve(null);
	const { promise, resolve } = Promise.withResolvers<string[] | null>();
	const u = new URL(`${FREEPI_BASE_URL}/client-version`);
	const mod = u.protocol === "https:" ? require("node:https") : require("node:http");
	const req = mod.get(
		u,
		{
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"User-Agent": `omp-freepi-bridge/${EXTENSION_VERSION}`,
			},
			timeout: 5_000,
		},
		(res) => {
			if (res.statusCode !== 200) {
				res.resume();
				resolve(null);
				return;
			}
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				try {
					const payload = JSON.parse(Buffer.concat(chunks).toString());
					const entries = Array.isArray(payload?.models) ? payload.models : [];
					const ids: string[] = [];
					for (const entry of entries) {
						if (entry && entry.free === true && typeof entry.id === "string" && entry.id) ids.push(entry.id);
					}
					if (ids.length > 0) {
						saveFreeIds(ids);
						resolve(ids);
					} else {
						resolve(null);
					}
				} catch {
					resolve(null);
				}
			});
			res.on("error", () => resolve(null));
		},
	);
	req.on("error", () => resolve(null));
	req.on("timeout", () => {
		req.destroy();
		resolve(null);
	});
	return promise;
}

/** Free model ids, ordered best → least. */
export function freeModelIds(): string[] {
	return freeModelList();
}

async function fetchBridgeModels(endpoint: Endpoint): Promise<ProviderModelConfig[]> {
	const first = await fetchModelsJson(endpoint);
	if (first && typeof first === "object" && "data" in first && Array.isArray((first as { data: unknown }).data)) {
		const items = (first as { data: unknown[] }).data;
		if (items.length > 0) {
			const models: ProviderModelConfig[] = [];
			for (const m of items) {
				if (m && typeof m === "object" && "id" in m && typeof (m as { id?: unknown }).id === "string") {
					models.push(toProviderModel(m as { id?: string; object?: string; owned_by?: string }));
				}
			}
			if (models.length > 0) {
				return models;
			}
		}
	}
	const cached = loadModelsCache();
	if (cached.length > 0) return cached;
	return [];
}

export async function fetchModels(endpoint: Endpoint): Promise<ProviderModelConfig[]> {
	const all = await fetchBridgeModels(endpoint);
	if (!FREE_ONLY) {
		saveModelsCache(all);
		return all;
	}
	// Best-effort tier refresh; freeModelList() falls back to the known-free
	// defaults, so the registered list never depends on this call succeeding.
	await fetchFreeModelIds(readToken().token);
	const byId = new Map(all.map((m) => [m.id, m]));
	const result = freeModelList().map((id) => byId.get(id) ?? { ...MODEL_BASE, id, name: id });
	saveModelsCache(result);
	return result;
}

function saveModelsCache(models: ProviderModelConfig[]): void {
	try {
		fs.mkdirSync(path.dirname(MODELS_CACHE_FILE), { recursive: true });
		fs.writeFileSync(MODELS_CACHE_FILE, JSON.stringify({ savedAt: Date.now(), models }));
	} catch {
		// ignore
	}
}
export function loadModelsCache(): ProviderModelConfig[] {
	try {
		const d = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, "utf8"));
		if (Array.isArray(d?.models)) return d.models.filter((m) => typeof m?.id === "string");
	} catch {
		// ignore
	}
	return [];
}

// ── Free model order + fallback --------------------------------------------
// Ordered best → least capable. Used as the fallback chain and when upstream
// tier detection is unavailable, so behaviour does not depend on discovery.
const DEFAULT_FREE_MODELS = ["particle", "deepseek-v4.1-flash", "glm-5.3-flash", "deepseek-v4-flash"];
// Transient upstream failures worth retrying with the next free model.
const RETRY_STATUS = new Set([403, 408, 409, 425, 429, 500, 502, 503, 504]);

export function freeModelList(): string[] {
	const detected = loadFreeIds();
	const primary = DEFAULT_FREE_MODELS.filter((id) => detected.length === 0 || detected.includes(id));
	const extra = detected.filter((id) => !DEFAULT_FREE_MODELS.includes(id));
	const merged = [...primary, ...extra];
	return merged.length > 0 ? merged : [...DEFAULT_FREE_MODELS];
}

// ── Free-only filtering proxy ----------------------------------------------
// pi/OMP discovers models from the provider's `/v1/models` regardless of the
// extension-provided list, and the bridge advertises premium-credit models.
// This proxy is the only place we can enforce "free models only" and apply the
// fallback chain.
export function startFilterProxy(bridge: Endpoint, preferredPort = 0): Promise<{ url: string; close: () => void }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ url: string; close: () => void }>();

	const freeSet = (): Set<string> | null => (FREE_ONLY ? new Set(freeModelList()) : null);

	const server = http.createServer((req, res) => {
		const allowed = freeSet();
		const pathname = (req.url || "/").split("?")[0];

		if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
			const byId = new Map(loadModelsCache().map((m) => [m.id, m]));
			const ids = allowed ? [...allowed] : loadModelsCache().map((m) => m.id);
			const data = ids.map((id) => byId.get(id) ?? { ...MODEL_BASE, id, name: id });
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data, fetchedAt: Date.now() }));
			return;
		}

		// Buffer the body so the model id can be inspected/replaced before forwarding.
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const raw = Buffer.concat(chunks);

			let requested: string | null = null;
			let parsedBody: Record<string, unknown> | null = null;
			if (raw.length > 0) {
				try {
					const parsed = JSON.parse(raw.toString());
					parsedBody = parsed && typeof parsed === "object" ? parsed : null;
					requested = typeof parsed?.model === "string" ? parsed.model : null;
				} catch {
					// not JSON — forward as-is
				}
			}

			const order = freeModelList();
			// Premium/unknown model → start at the best free model.
			const chain = requested && order.includes(requested) ? [requested, ...order.filter((id) => id !== requested)] : order;

			const bodyFor = (model: string): Buffer => {
				if (!requested || model === requested || !parsedBody) return raw;
				return Buffer.from(JSON.stringify({ ...parsedBody, model }));
			};

			// `sameTries` counts retries of the *same* model for account-wide limits
			// (FreePi allows one concurrent request per account), which switching
			// models cannot fix.
			const attempt = (index: number, sameTries: number): void => {
				if (index >= chain.length) {
					res.writeHead(503, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: { message: "all free freepi models failed", type: "api_error" } }));
					return;
				}
				const model = chain[index];
				const payload = bodyFor(model);

				const headers = { ...req.headers, host: `${bridge.host}:${bridge.port}` };
				// The model id may have been rewritten, so the original length is stale.
				if (payload.length > 0) headers["content-length"] = String(payload.length);
				else delete headers["content-length"];

				const upstream = http.request(
					{
						host: bridge.host,
						port: bridge.port,
						method: req.method,
						path: req.url,
						headers,
						timeout: 180_000,
					},
					(up) => {
						const status = up.statusCode || 502;
						if (status >= 200 && status < 300) {
							res.writeHead(status, { ...up.headers, "x-freepi-model": model });
							up.pipe(res);
							return;
						}
						// Errors are small; buffer them to tell "account busy" from "this model".
						const parts: Buffer[] = [];
						up.on("data", (c: Buffer) => parts.push(c));
						up.on("end", () => {
							const text = Buffer.concat(parts).toString();
							const accountBusy = status === 429 || /concurrent|one request at a time/i.test(text);
							if (accountBusy && sameTries < 3) {
								setTimeout(() => attempt(index, sameTries + 1), 1_200 * (sameTries + 1));
								return;
							}
							if (RETRY_STATUS.has(status) && index + 1 < chain.length) {
								attempt(index + 1, 0);
								return;
							}
							res.writeHead(status, { "content-type": "application/json", "x-freepi-model": model });
							res.end(text);
						});
						up.on("error", () => attempt(index + 1, 0));
					},
				);
				upstream.on("timeout", () => upstream.destroy());
				upstream.on("error", () => attempt(index + 1, 0));
				upstream.end(payload);
			};

			attempt(0, 0);
		});
	});

	const onListening = (): void => {
		const addr = server.address();
		const port = typeof addr === "object" && addr !== null ? addr.port : 0;
		resolve({ url: `http://${HOST}:${port}/v1`, close: () => server.close() });
	};

	server.once("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE" && preferredPort !== 0) {
			server.listen(0, HOST, onListening);
			return;
		}
		reject(err);
	});
	server.listen(preferredPort, HOST, onListening);
	return promise;
}

// ── Extension factory -------------------------------------------------------
export default async function (pi: ExtensionAPI): Promise<void> {
	const state = readState();
	let currentEndpoint: Endpoint = { host: HOST, port: state?.port ?? DEFAULT_PORT };
	let currentModels: ProviderModelConfig[] = [];
	let proxy: { url: string; close: () => void; endpoint: Endpoint } | null = null;

	const binary = resolveBinaryPath();
	const token = tokenSource();

	// Startup token guidance (non-blocking, no crash if missing).
	if (!token.has) {
		pi.ui.notify(`freepi: ${signInGuide().split("\n")[0]}`, "warning");
	}

	const cached = loadModelsCache();
	const initialModels = cached.length > 0 ? cached : freeModelList().map((id) => ({ ...MODEL_BASE, id, name: id }));
	currentModels = initialModels;

	const preferredProxyPort = (endpoint: Endpoint): number =>
		Number(process.env.FREEPI_PROXY_PORT) || endpoint.port + 1;
	let proxyUrl = `http://${HOST}:${preferredProxyPort(currentEndpoint)}/v1`;

	const register = (models: ProviderModelConfig[], baseUrl: string): void => {
		pi.registerProvider(EXTENSION_NAME, {
			baseUrl,
			apiKey: "freepi",
			api: "openai-completions",
			models,
			refreshModels: async () => fetchModels(currentEndpoint),
		});
		// Status is bound after extension load; optional-call keeps load safe.
		pi.setStatus?.(EXTENSION_NAME, `${models.length} free models via ${baseUrl}`);
	};

	// Register synchronously: extension load must never wait on the network,
	// otherwise commands like `omp models` stall.
	register(initialModels, proxyUrl);

	const startProxy = (endpoint: Endpoint): void => {
		startFilterProxy(endpoint, preferredProxyPort(endpoint))
			.then((started) => {
				proxy?.close();
				proxy = { ...started, endpoint };
				proxyUrl = started.url;
				register(currentModels, proxyUrl);
				syncModelsYml(proxyUrl);
			})
			.catch(() => {
				// keep the optimistic URL; failures surface on request
			});
	};

	startProxy(currentEndpoint);

	const refresh = async (): Promise<void> => {
		const bin = binary || (await ensureBinaryInstalled().catch(() => null));
		if (!bin) throw new Error("freepi-bridge binary not available. Run `/freepi install` or install freepi-bridge manually.");
		const info = await ensureDaemonRunning(bin);
		const changed = info.port !== currentEndpoint.port || info.host !== currentEndpoint.host;
		currentEndpoint = info;
		if (changed) startProxy(info);

		let models = await fetchModels(currentEndpoint);
		if (models.length === 0) models = loadModelsCache();
		currentModels = models;
		register(models, proxyUrl);
	};

	// Background bring-up; never blocks extension load.
	void refresh().catch(() => {
		// reported by /freepi status
	});

	pi.registerCommand(EXTENSION_NAME, {
		description:
			"freepi-bridge daemon & provider: status | token | doctor | models | refresh-models | start | stop | restart | ads | logs | install | help",
		getArgumentCompletions: (prefix: string) =>
			[
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
				"help",
			]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s })),
		handler: async (args: string, ctx) => {
			const parts = String(args || "").trim().split(/\s+/);
			const sub = parts[0] || "status";

			switch (sub) {
				case "status": {
					const alive = await healthz(currentEndpoint);
					const models = loadModelsCache().length;
					const tok = tokenSource();
					let binInfo = "unknown";
					try {
						const bin = resolveBinaryPath() || (await ensureBinaryInstalled().catch(() => null));
						if (!bin) binInfo = "missing";
						else {
							const ver = await binaryVersion(bin);
							binInfo = ver || "installed";
						}
					} catch {
						binInfo = "installed";
					}
					ctx.ui.notify(
						`freepi ${EXTENSION_VERSION}: daemon ${alive ? `online ${currentEndpoint.host}:${currentEndpoint.port}` : "offline"} · models=${models} · token=${tok.has ? "yes (" + tok.source + ")" : "missing: /freepi token"} · binary=${binInfo}`,
						alive ? "info" : "warning",
					);
					break;
				}
				case "token": {
					const tok = tokenSource();
					ctx.ui.notify(
						tok.has ? `FreePi token: ${tok.masked} (${tok.source})` : signInGuide(),
						tok.has ? "info" : "warning",
					);
					break;
				}
				case "doctor": {
					const bin = resolveBinaryPath() || (await ensureBinaryInstalled().catch(() => null));
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
						ctx.ui.notify("No models yet — start the daemon (`/freepi start`) or run `/freepi refresh-models`.", "warning");
					} else {
						ctx.ui.notify(`freepi models: ${models.map((m) => m.id).join(", ")}`, "info");
					}
					break;
				}
				case "refresh-models": {
					const bin = resolveBinaryPath() || (await ensureBinaryInstalled().catch(() => null));
					if (!bin) {
						ctx.ui.notify("freepi-bridge binary not installed. Run `/freepi install`.", "error");
						break;
					}
					try {
						await refresh();
						ctx.ui.notify(`freepi: re-registered ${currentModels.length} models from ${currentEndpoint.host}:${currentEndpoint.port}`, "info");
					} catch (err) {
						ctx.ui.notify(`freepi: refresh-models failed — ${String(err)}`, "error");
					}
					break;
				}
				case "start": {
					const bin = resolveBinaryPath() || (await ensureBinaryInstalled().catch(() => null));
					if (!bin) {
						ctx.ui.notify("freepi-bridge binary not installed. Run `/freepi install`.", "error");
						break;
					}
					try {
						const info = await ensureDaemonRunning(bin);
						currentEndpoint = info;
						await refresh();
						ctx.ui.notify(`freepi daemon started on ${currentEndpoint.host}:${currentEndpoint.port} (pid ${info.pid})`, "info");
					} catch (err) {
						ctx.ui.notify(`freepi: start failed — ${String(err)}`, "error");
					}
					break;
				}
				case "stop": {
					await stopDaemon();
					pi.setStatus(EXTENSION_NAME, undefined);
					ctx.ui.notify("freepi daemon stopped.", "info");
					break;
				}
				case "restart": {
					await stopDaemon();
					const bin = resolveBinaryPath() || (await ensureBinaryInstalled().catch(() => null));
					if (!bin) {
						ctx.ui.notify("freepi-bridge binary not installed. Run `/freepi install`.", "error");
						break;
					}
					try {
						const info = await ensureDaemonRunning(bin);
						currentEndpoint = info;
						await refresh();
						ctx.ui.notify(`freepi daemon restarted on ${currentEndpoint.host}:${currentEndpoint.port}`, "info");
					} catch (err) {
						ctx.ui.notify(`freepi: restart failed — ${String(err)}`, "error");
					}
					break;
				}
				case "ads": {
					const bin = resolveBinaryPath() || (await ensureBinaryInstalled().catch(() => null));
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
						ctx.ui.notify(`freepi-bridge logs:\n${lines}`, "info");
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
						ctx.ui.notify(`freepi: install failed — ${String(err)}`, "error");
					}
					break;
				}
				default:
					ctx.ui.notify(
						`freepi ${EXTENSION_VERSION}: status | token | doctor | models | refresh-models | start | stop | restart | ads | logs | install | help`,
						"info",
					);
			}
		},
	});
}

async function binaryVersion(bin: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const { execFileSync } = require("node:child_process");
	try {
		const out = execFileSync(bin, ["version"], { encoding: "utf8", timeout: 5_000 });
		resolve(out.trim().split("\n")[0] || "unknown");
	} catch {
		resolve("unknown");
	}
	return promise;
}

function runCli(bin: string, argv: string[]): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	const { execFileSync } = require("node:child_process");
	try {
		resolve(execFileSync(bin, argv, { encoding: "utf8", timeout: 15_000 }).trim());
	} catch {
		resolve("");
	}
	return promise;
}
