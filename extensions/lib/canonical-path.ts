import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * The real path of an existing path. The native call (realpath(3)) also corrects the spelling on a
 * case-insensitive file system such as APFS on macOS (`~/.CURSOR` → `~/.cursor`); JS's own
 * realpathSync keeps the spelling it was given. Falls back to it when the native call fails.
 */
function realPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return realpathSync(path);
	}
}

/** The path with symlinks resolved, also for files that do not exist yet. */
export function canonicalPath(path: string): string {
	let current = resolve(path);
	const rest: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return resolve(path);
		rest.unshift(basename(current));
		current = parent;
	}
	try {
		return join(realPath(current), ...rest);
	} catch {
		return resolve(path);
	}
}
