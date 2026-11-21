import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "./log";

const tempDirs: string[] = [];
const savedKillSwitch = process.env.OMP_PLUGIN_LOG;

function freshDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freepi-plugin-log-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	if (savedKillSwitch === undefined) delete process.env.OMP_PLUGIN_LOG;
	else process.env.OMP_PLUGIN_LOG = savedKillSwitch;
});

test("writes one JSONL entry with the required shape and redacted metadata", () => {
	const dir = freshDir();
	const log = createLogger({ dir, plugin: "freepi", version: "0.2.0" });
	log("warn", "token_source", {
		token: "eyJhbGciOi.fake-token-value",
		apiKey: "sk-should-not-appear",
		password: "hunter2-should-not-appear",
		Authorization: "Bearer secret-value",
		nested: { credential: "nested-secret", count: 2 },
		message: "x".repeat(250),
		stack: "Error: stack-leak",
		error: new Error("error-message-leak\nat stack-leak"),
	});

	const raw = fs.readFileSync(path.join(dir, "plugin.log"), "utf8");
	expect(raw.endsWith("\n")).toBe(true);
	const lines = raw.trim().split("\n");
	expect(lines).toHaveLength(1);
	const entry = JSON.parse(lines[0]);
	expect(entry).toMatchObject({
		level: "warn",
		event: "token_source",
		plugin: "freepi",
		version: "0.2.0",
	});
	expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
	expect(entry.message).toHaveLength(200);
	expect(entry.nested).toEqual({ count: 2 });
	expect(entry.error).toBe("error-message-leak");

	for (const needle of [
		"fake-token-value",
		"sk-should-not-appear",
		"hunter2-should-not-appear",
		"secret-value",
		"nested-secret",
		"stack-leak",
	]) {
		expect(raw).not.toContain(needle);
	}
});

test("scrubs URLs, userinfo, and inline credentials", () => {
	const dir = freshDir();
	const log = createLogger({ dir, plugin: "freepi", version: "0.2.0" });
	log("info", "scrub_check", {
		url: "https://user:pass@host/path?token=abc",
		note: "note api_key=inline-secret here",
		error: new Error("failed at https://user:pass@host/path?token=abc\nstack"),
	});

	const raw = fs.readFileSync(path.join(dir, "plugin.log"), "utf8");
	const entry = JSON.parse(raw.trim());
	expect(entry.url).toBe("https://host/path");
	expect(entry.note).toBe("note api_key=[redacted] here");
	expect(entry.error).toBe("failed at https://host/path");
	for (const needle of ["user:pass", "token=abc", "inline-secret", "stack"]) {
		expect(raw).not.toContain(needle);
	}
});

test("OMP_PLUGIN_LOG=0 disables file logging", () => {
	const dir = freshDir();
	process.env.OMP_PLUGIN_LOG = "0";
	const log = createLogger({ dir, plugin: "freepi", version: "0.2.0" });
	log("info", "session_start", { token: "suppressed-token" });
	expect(fs.existsSync(path.join(dir, "plugin.log"))).toBe(false);
});
