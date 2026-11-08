import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `.pi/protect.json`: repository-specific rules for the safety gate, on top of the built-in ones.
 *
 *   {
 *     "write":    ["evals/samples/test*.jsonl"],          // never written by the agent
 *     "read":     ["evals/samples/holdout*.jsonl"],       // never read or written by the agent
 *     "commands": [{ "pattern": "--split[ =]+test\\b", "reason": "the test split runs once, by David" }]
 *   }
 *
 * Paths are relative to the repository root (the directory that holds `.pi/`) and support `*`
 * (within a path segment), `**` (any depth) and `?`. A path without wildcards also covers
 * everything below it. `commands` patterns are regular expressions tested against each bash
 * command with quotes removed.
 *
 * The file only adds restrictions, so it applies in untrusted projects too.
 */

export const PROTECT_CONFIG_PATH = ".pi/protect.json";

export interface CommandRule {
	pattern: RegExp;
	reason: string;
}

export interface ProtectConfig {
	write: string[];
	read: string[];
	commands: CommandRule[];
}

/** Reads `.pi/protect.json`. Returns undefined when absent; throws on invalid content. */
export function loadProtectConfig(cwd: string): ProtectConfig | undefined {
	const path = join(cwd, PROTECT_CONFIG_PATH);
	if (!existsSync(path)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new Error(`${PROTECT_CONFIG_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${PROTECT_CONFIG_PATH} must be a JSON object`);
	const record = raw as Record<string, unknown>;
	const known = new Set(["write", "read", "commands", "$comment"]);
	const unknown = Object.keys(record).filter((key) => !known.has(key));
	if (unknown.length) throw new Error(`${PROTECT_CONFIG_PATH} has unknown keys: ${unknown.join(", ")}`);
	return {
		write: stringList(record.write, "write"),
		read: stringList(record.read, "read"),
		commands: commandList(record.commands),
	};
}

function stringList(value: unknown, key: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
		throw new Error(`${PROTECT_CONFIG_PATH} "${key}" must be a list of non-empty strings`);
	}
	return value.map((item: string) => normalizeGlob(item));
}

function commandList(value: unknown): CommandRule[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${PROTECT_CONFIG_PATH} "commands" must be a list`);
	return value.map((item, index) => {
		const rule = item as { pattern?: unknown; reason?: unknown };
		if (typeof rule?.pattern !== "string" || typeof rule.reason !== "string" || !rule.reason.trim()) {
			throw new Error(`${PROTECT_CONFIG_PATH} "commands"[${index}] needs a "pattern" and a "reason" string`);
		}
		try {
			return { pattern: new RegExp(rule.pattern), reason: rule.reason.trim() };
		} catch (error) {
			throw new Error(`${PROTECT_CONFIG_PATH} "commands"[${index}] pattern is invalid: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
}

function normalizeGlob(glob: string): string {
	return glob.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "/**");
}

const GLOB_CHARS = /[*?]/;

export function hasGlob(text: string): boolean {
	return GLOB_CHARS.test(text);
}

/** A repository-relative glob as a regular expression over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
	const normalized = normalizeGlob(glob);
	let source = "";
	for (let index = 0; index < normalized.length; index++) {
		const char = normalized[index];
		if (char === "*" && normalized[index + 1] === "*") {
			const slash = normalized[index + 2] === "/";
			source += slash ? "(?:.*/)?" : ".*";
			index += slash ? 2 : 1;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	// A plain path also covers everything below it.
	return new RegExp(hasGlob(normalized) ? `^${source}$` : `^${source}(?:/.*)?$`);
}

/** The first glob that matches the repository-relative `path`, or undefined. */
export function matchingGlob(path: string, globs: readonly string[]): string | undefined {
	const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
	return globs.find((glob) => globToRegExp(glob).test(normalized));
}

/** The directory part of a glob before its first wildcard, e.g. `evals/samples` for `evals/samples/test*.jsonl`. */
export function staticPrefix(glob: string): string {
	const normalized = normalizeGlob(glob);
	const segments = normalized.split("/");
	const firstGlob = segments.findIndex((segment) => hasGlob(segment));
	return (firstGlob < 0 ? segments.slice(0, -1) : segments.slice(0, firstGlob)).join("/");
}

const SKIP_DIRS = new Set([".git", "node_modules"]);
const MAX_FILES = 20_000;

/** Existing files under `cwd` that match one of `globs`, repository-relative. Bounded walk. */
export function existingMatches(cwd: string, globs: readonly string[]): string[] {
	const found = new Set<string>();
	let visited = 0;
	const walk = (relDir: string) => {
		if (visited > MAX_FILES) return;
		let entries;
		try {
			entries = readdirSync(join(cwd, relDir), { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			visited++;
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIP_DIRS.has(entry.name)) walk(rel);
			} else if (matchingGlob(rel, globs)) found.add(rel);
		}
	};
	for (const prefix of new Set(globs.map(staticPrefix))) {
		if (!prefix || existsSync(join(cwd, prefix))) walk(prefix);
	}
	return [...found].sort();
}
