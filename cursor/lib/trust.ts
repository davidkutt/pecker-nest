/**
 * The trust list of the quality gate in Cursor: `~/.config/pecker-nest/cursor-trusted`, one
 * absolute repository root per line, written by scripts/cursor-trust.sh. The gate runs a command
 * from the repository with David's rights, so it runs only in listed repositories. The safety
 * hooks apply everywhere.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalPath } from "../../extensions/lib/canonical-path.ts";
import { configDir, TRUST_FILE } from "./context.ts";

export const trustFile = (home: string) => join(configDir(home), TRUST_FILE);

/** The listed roots. Empty when the file is missing; blank lines and `#` comments are skipped. */
export function readTrustList(file: string): string[] {
	let content: string;
	try {
		content = readFileSync(file, "utf-8");
	} catch {
		return [];
	}
	return content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && isAbsolute(line));
}

/**
 * The main checkout of a git worktree: its `.git` is a file `gitdir: <main>/.git/worktrees/<name>`.
 * Undefined for an ordinary checkout or anything unreadable.
 */
export function worktreeMain(root: string): string | undefined {
	const dotGit = join(root, ".git");
	try {
		if (!existsSync(dotGit) || !statSync(dotGit).isFile()) return undefined;
		const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf-8"));
		if (!match) return undefined;
		const gitdir = resolve(root, match[1]);
		const main = /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(gitdir);
		return main ? main[1] : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the gate may run in `root`: it is listed, or it is a worktree (Cursor's `/worktree`)
 * of a listed checkout, which shares that checkout's history and `.pi/` files.
 */
export function isTrusted(root: string, list: readonly string[]): boolean {
	const listed = new Set(list.map((entry) => canonicalPath(entry)));
	if (listed.has(canonicalPath(root))) return true;
	const main = worktreeMain(root);
	return main !== undefined && listed.has(canonicalPath(main));
}
