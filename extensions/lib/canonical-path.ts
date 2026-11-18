import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

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
		return join(realpathSync(current), ...rest);
	} catch {
		return resolve(path);
	}
}
