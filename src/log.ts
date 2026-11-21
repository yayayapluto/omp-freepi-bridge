import fs from "node:fs";
import path from "node:path";

export type PluginLogLevel = "info" | "warn" | "error";
export type PluginLogger = (level: PluginLogLevel, event: string, meta?: Record<string, unknown>) => void;

const SENSITIVE_KEY = /token|secret|password|authorization|cookie|api[-_]?key|credential|stack/i;
const MAX_STRING = 200;
const MAX_DEPTH = 4;

export function safeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.split(/\r?\n/)[0].slice(0, MAX_STRING);
}

function safeValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") return value.slice(0, MAX_STRING);
	if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
	if (typeof value === "boolean" || value === null) return value;
	if (value instanceof Error) return safeErrorMessage(value);
	if (depth >= MAX_DEPTH) return undefined;
	if (Array.isArray(value)) return value.map((item) => safeValue(item, depth + 1));
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			if (SENSITIVE_KEY.test(key)) continue;
			const safe = safeValue(child, depth + 1);
			if (safe !== undefined) out[key] = safe;
		}
		return out;
	}
	return undefined;
}

export function redactLogMeta(meta: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(meta)) {
		if (SENSITIVE_KEY.test(key)) continue;
		const safe = safeValue(value, 0);
		if (safe !== undefined) out[key] = safe;
	}
	return out;
}

export function createLogger(options: { dir: string; plugin: string; version: string }): PluginLogger {
	const file = path.join(options.dir, "plugin.log");
	return (level, event, meta = {}) => {
		if (process.env.OMP_PLUGIN_LOG === "0") return;
		try {
			const entry = {
				...redactLogMeta(meta),
				ts: new Date().toISOString(),
				level,
				event,
				plugin: options.plugin,
				version: options.version,
			};
			fs.mkdirSync(options.dir, { recursive: true });
			fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
		} catch {
			// File logging must never interrupt plugin control flow.
		}
	};
}
