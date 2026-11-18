/**
 * The path policy for one repository, as Pi's safety-gate.ts builds it, plus the parts of the
 * harness only Cursor has (lib/harness.ts). The rules themselves stay in extensions/lib/.
 */

import { canonicalPath } from "../../extensions/lib/canonical-path.ts";
import { CURSOR_HARNESS_FILES, cursorHarnessDirs, cursorHarnessExceptions } from "../../extensions/lib/harness.ts";
import { existingMatches, loadProtectConfig } from "../../extensions/lib/protect-config.ts";
import type { PathPolicy } from "../../extensions/lib/safety-rules.ts";
import type { AdapterContext } from "./context.ts";
import { gitRootAbove, isInside } from "./payload.ts";

/**
 * The repository a path belongs to: the deepest workspace root that contains it, else the nearest
 * git work tree above it (a Cursor worktree under `~/.cursor/worktrees/` that is not a workspace
 * root), else none.
 */
export function repositoryFor(path: string, roots: readonly string[]): string | undefined {
	const target = canonicalPath(path);
	const containing = roots.filter((root) => isInside(target, root)).sort((a, b) => b.length - a.length);
	return containing[0] ?? gitRootAbove(target);
}

export type PolicyResult = { policy: PathPolicy; repo?: string } | { error: string; repo: string };

/** Whether paths are compared without regard to case: on macOS (APFS), unless the context says otherwise. */
export function caseInsensitive(context: AdapterContext): boolean {
	return context.caseInsensitive ?? process.platform === "darwin";
}

/**
 * The policy for `repo`, or the error of an invalid `.pi/protect.json` there. Without a repository
 * only the built-in rules and the harness apply.
 */
export function policyFor(repo: string | undefined, context: AdapterContext): PolicyResult {
	const harness = {
		harnessDirs: cursorHarnessDirs({ nestDir: context.nestDir, home: context.home, env: context.env }),
		harnessExceptions: cursorHarnessExceptions({ home: context.home }),
		harnessFiles: CURSOR_HARNESS_FILES,
		agent: "Cursor",
		canonical: canonicalPath,
		caseInsensitive: caseInsensitive(context),
	};
	if (!repo) return { policy: { cwd: context.home, write: [], read: [], ...harness } };
	let config;
	try {
		config = loadProtectConfig(repo);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error), repo };
	}
	const read = config?.read ?? [];
	return {
		repo,
		policy: {
			cwd: repo,
			write: config?.write ?? [],
			read,
			readFiles: read.length ? existingMatches(repo, read, harness.caseInsensitive) : [],
			commands: config?.commands ?? [],
			...harness,
		},
	};
}
