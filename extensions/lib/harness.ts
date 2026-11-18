import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { canonicalPath } from "./canonical-path.ts";
import { splitCommands } from "./safety-rules.ts";

/**
 * What counts as the agent harness: the files an agent must never change, because they hold its
 * own gates, settings and protection rules or those of the agent that supervises it. Pi's
 * safety-gate.ts and the Cursor adapter (cursor/lib/) both build their path policy from here.
 */

export interface HarnessOptions {
	/** This checkout of pecker-nest. */
	nestDir: string;
	home?: string;
	env?: NodeJS.ProcessEnv;
	/** Resolves symlinks; defaults to canonicalPath. */
	canonical?: (path: string) => string;
}

/**
 * nest's harness: this package, Pi's agent directory and Claude Code's config directory. Claude
 * Code supervises nest's sessions, and pecker-grove's CLAUDE.md tells agents to write skills to
 * `~/.claude/skills`, so without the third entry nest could change the settings, skills and hooks
 * of the harness that watches it.
 */
export function harnessDirs({ nestDir, home = homedir(), env = process.env, canonical = canonicalPath }: HarnessOptions): string[] {
	return [
		canonical(nestDir),
		canonical(env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent")),
		canonical(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude")),
	];
}

/**
 * The harness as Cursor's agent sees it: nest's, plus Cursor's user directory (user hooks, rules,
 * subagents, skills) and the adapter's own configuration and state (the Node path, the trust list,
 * the turn snapshots and the log), so the agent can neither switch the hooks off nor trust a
 * repository nor move the gate's baseline.
 */
export function cursorHarnessDirs(options: HarnessOptions): string[] {
	const home = options.home ?? homedir();
	const canonical = options.canonical ?? canonicalPath;
	return [
		...harnessDirs(options),
		canonical(join(home, ".cursor")),
		canonical(join(home, ".config", "pecker-nest")),
		canonical(join(home, ".local", "state", "pecker-nest")),
	];
}

/**
 * Directories below the Cursor harness that the agent works in: Cursor puts the checkouts of its
 * worktrees under `~/.cursor/worktrees/<repo>/<branch>`. Files there that configure the harness
 * (CURSOR_HARNESS_FILES) stay protected.
 */
export function cursorHarnessExceptions(options: Pick<HarnessOptions, "home" | "canonical">): string[] {
	const home = options.home ?? homedir();
	const canonical = options.canonical ?? canonicalPath;
	return [canonical(join(home, ".cursor", "worktrees"))];
}

/**
 * Files that configure Cursor's hooks or its ignore rules wherever they are, including the
 * Claude Code settings Cursor also reads hooks from (Third-Party Imports, on by default). A hook
 * there runs with the user's rights outside the sandbox. Globs over absolute paths without the
 * leading `/`, for PathPolicy.harnessFiles.
 */
export const CURSOR_HARNESS_FILES: readonly string[] = [
	"**/.cursorignore",
	"**/.cursor/hooks.json",
	"**/.cursor/hooks/**",
	"**/.claude/settings.json",
	"**/.claude/settings.local.json",
];

/** Scripts of this checkout that install the hooks or change the trust list. */
const HARNESS_SCRIPTS = ["scripts/link.sh", "scripts/cursor-trust.sh"];

/**
 * Reason why a shell command must not run because it calls one of the scripts that install or
 * configure the harness (`scripts/link.sh --cursor-capture` would swap the gate for the capture
 * hook, `scripts/cursor-trust.sh add` would let a repository's gate command run), or undefined.
 * Like the other command rules a tripwire, not a sandbox.
 */
export function harnessScriptReason(command: string, options: { nestDir: string; cwd: string; home?: string; canonical?: (path: string) => string }): string | undefined {
	const home = options.home ?? homedir();
	const canonical = options.canonical ?? canonicalPath;
	const scripts = new Set(HARNESS_SCRIPTS.map((script) => canonical(join(options.nestDir, script))));
	for (const word of splitCommands(command).flat()) {
		if (!/(?:^|\/)(?:link|cursor-trust)\.sh$/.test(word)) continue;
		const expanded = word.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
		const target = canonical(isAbsolute(expanded) ? resolve(expanded) : resolve(options.cwd, expanded));
		if (scripts.has(target) || basename(word) === "cursor-trust.sh") return `${word} installs or configures the agent harness; the user runs it`;
	}
	return undefined;
}
