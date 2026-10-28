import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Dirty paths of a git work tree (relative to its root) mapped to a content fingerprint. */
export type WorktreeSnapshot = Map<string, string>;

const MAX_HASHED_FILES = 2000;
const MAX_HASHED_BYTES = 5 * 1024 * 1024;

function git(cwd: string, args: string[]) {
	return spawnSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
}

/** Undefined when `cwd` is not inside a git work tree. */
export function takeSnapshot(cwd: string): WorktreeSnapshot | undefined {
	const root = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (root.status !== 0) return undefined;
	const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	if (status.status !== 0) return undefined;

	const entries = parsePorcelainZ(status.stdout);
	const hashContents = entries.length <= MAX_HASHED_FILES;
	const snapshot: WorktreeSnapshot = new Map();
	for (const { code, path } of entries) {
		snapshot.set(path, hashContents ? `${code}:${fingerprint(join(root.stdout.trim(), path))}` : code);
	}
	return snapshot;
}

/** Parses `git status --porcelain=v1 -z`; renames carry their source path as a second field. */
export function parsePorcelainZ(output: string): { code: string; path: string }[] {
	const fields = output.split("\0");
	const entries: { code: string; path: string }[] = [];
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index];
		if (field.length < 4) continue;
		const code = field.slice(0, 2);
		entries.push({ code, path: field.slice(3) });
		if (code[0] === "R" || code[0] === "C") index++;
	}
	return entries;
}

function fingerprint(path: string): string {
	try {
		const stats = statSync(path);
		if (!stats.isFile()) return "dir";
		if (stats.size > MAX_HASHED_BYTES) return `size:${stats.size}:${stats.mtimeMs}`;
		return createHash("sha1").update(readFileSync(path)).digest("hex");
	} catch {
		return "missing";
	}
}

/** Paths whose state differs between two snapshots. */
export function changedPaths(before: WorktreeSnapshot, after: WorktreeSnapshot): string[] {
	const changed = new Set<string>();
	for (const [path, value] of after) if (before.get(path) !== value) changed.add(path);
	for (const path of before.keys()) if (!after.has(path)) changed.add(path);
	return [...changed].sort();
}

/** A stable key for a snapshot, used to notice repair rounds that changed nothing. */
export function snapshotKey(snapshot: WorktreeSnapshot): string {
	return createHash("sha1")
		.update(JSON.stringify([...snapshot].sort(([a], [b]) => a.localeCompare(b))))
		.digest("hex");
}
