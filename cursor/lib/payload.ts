/**
 * Reading Cursor's hook payloads: the JSON object on stdin, the workspace roots and the paths in a
 * tool's input. Field names follow docs/research/cursor-hooks.md (C1, C7, X2).
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { canonicalPath } from "../../extensions/lib/canonical-path.ts";

export type Payload = Record<string, unknown>;

/** The payload object, or why there is none. Never echoes the payload: it may hold file contents. */
export function parsePayload(raw: string): { payload: Payload } | { error: string } {
	const text = raw.replace(/^﻿/, "");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { error: "the hook payload is not valid JSON" };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { error: "the hook payload is not a JSON object" };
	return { payload: parsed as Payload };
}

/** A non-empty string, or undefined. */
export function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

/** A tool's input as an object; Cursor may send it as a JSON string (beforeMCPExecution does). */
export function toolInput(payload: Payload): Record<string, unknown> {
	const input = payload.tool_input;
	if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
	if (typeof input === "string") {
		try {
			const parsed: unknown = JSON.parse(input);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {
			// not JSON: no fields
		}
	}
	return {};
}

function expandHome(path: string, home: string): string {
	return path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
}

/**
 * The folders a hook call is about, canonical and without duplicates: `extra` (a tool's own `cwd`),
 * a non-empty `cwd` (usually `""`, X2), then `workspace_roots` and `CURSOR_PROJECT_DIR`. An explicit
 * `cwd` comes first because `workspace_roots` can be stale: after `move_agent_to_root` back from a
 * worktree it kept naming the worktree while commands ran in the main checkout (X12). Relative
 * entries are ignored.
 */
export function workspaceRoots(payload: Payload, env: NodeJS.ProcessEnv, extra: (string | undefined)[] = []): string[] {
	const candidates: unknown[] = [...extra, payload.cwd, ...(Array.isArray(payload.workspace_roots) ? payload.workspace_roots : []), env.CURSOR_PROJECT_DIR];
	const roots: string[] = [];
	for (const candidate of candidates) {
		const path = text(candidate)?.trim();
		if (!path || !isAbsolute(path)) continue;
		const root = canonicalPath(path);
		if (!roots.includes(root)) roots.push(root);
	}
	return roots;
}

/** An absolute path for a path from a tool's input: `~` expanded, relative ones against `base`. */
export function absolute(path: string, base: string, home: string): string {
	const expanded = expandHome(path.trim(), home);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

/** Field names that carry the file a tool reads or writes. */
const PATH_FIELDS = ["file_path", "path", "target_file", "filePath", "targetFile"];

/** The first path-like field of a tool input, or undefined. */
export function inputPath(input: Record<string, unknown>, fields: readonly string[] = PATH_FIELDS): string | undefined {
	for (const field of fields) {
		const value = text(input[field]);
		if (value) return value;
	}
	return undefined;
}

/** Paths named in an apply-patch body (`*** Update File: x`, `*** Move to: y`). */
export function patchPaths(body: string): string[] {
	const paths: string[] = [];
	for (const match of body.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm)) paths.push(match[1]);
	return paths;
}

/**
 * Every path a write tool's input names: the usual path fields, a list under `paths`/`files`, and
 * the files of an apply-patch body in any string field. Empty when none is found; the caller then
 * blocks, because it cannot tell what would be written.
 */
export function writePaths(input: Record<string, unknown>): string[] {
	const found = new Set<string>();
	for (const field of PATH_FIELDS) {
		const value = text(input[field]);
		if (value) found.add(value);
	}
	for (const field of ["paths", "files", "file_paths"]) {
		const list = input[field];
		if (Array.isArray(list)) for (const item of list) if (text(item)) found.add(item as string);
	}
	for (const value of Object.values(input)) {
		if (typeof value === "string" && value.includes("*** ")) for (const path of patchPaths(value)) found.add(path);
	}
	return [...found];
}

/** Whether `path` is `root` or lies below it. Both canonical. */
export function isInside(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** The nearest directory at or above `path` that holds `.git` (a directory, or a worktree's file). */
export function gitRootAbove(path: string): string | undefined {
	let current = path;
	for (;;) {
		if (existsSync(resolve(current, ".git"))) return current;
		const parent = resolve(current, "..");
		if (parent === current) return undefined;
		current = parent;
	}
}
