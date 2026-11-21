import fs from "node:fs";
import path from "node:path";

export type PluginLogLevel = "info" | "warn" | "error";
export type PluginLogger = (level: PluginLogLevel, event: string, meta?: Record<string, unknown>) => void;

const SENSITIVE_KEY = /token|secret|password|authorization|cookie|api[-_]?key|credential|stack|payload|prompt|profile|messages?|output|response|body|headers|text|content|completion|reasoning/i;
const MAX_STRING = 200;
const MAX_DEPTH = 4;
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;
const QUERY_OR_FRAGMENT = /[?#][^\s]*/g;
const INLINE_CREDENTIAL = /\b(token|secret|password|authorization|cookie|api[-_]?key|credential)\s*[:=]\s*(?:Bearer\s+)?[^\s,;"']+/gi;

function sanitizeLogString(value: string): string {
	const firstLine = value.split(/\r?\n/, 1)[0] ?? "";
	return firstLine
		.replace(URL_USERINFO, "$1")
		.replace(QUERY_OR_FRAGMENT, "")
		.replace(INLINE_CREDENTIAL, "$1=[redacted]")
		.slice(0, MAX_STRING);
}

export function safeErrorMessage(error: unknown): string {
	return sanitizeLogString(error instanceof Error ? error.message : String(error));
}

function safeValue(value: unknown, depth: number): unknown {
	if (typeof value === "string") return sanitizeLogString(value);
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
