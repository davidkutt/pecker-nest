/**
 * The adapter's decision log, `~/.local/state/pecker-nest/cursor/log.jsonl`: one line per decision
 * with time, event, repository, decision, rule, and for the gate its result, repair round and the
 * number of weakened-test findings. Counts and paths only: never a command, prompt, file content,
 * check output or reason text.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOG_FILE, stateDir } from "./context.ts";

export interface LogEntry {
	event: string;
	/** allow, deny, continue, start, skip, green, repair, final, error. */
	decision: string;
	/** Which rule decided (ruleOf), or why the gate was skipped. */
	rule?: string;
	tool?: string;
	repo?: string;
	path?: string;
	gate?: "green" | "red";
	round?: number;
	findings?: number;
	code?: number;
	seconds?: number;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * A short, stable name for a block reason from extensions/lib/, for the log. The reason text itself
 * stays out of the log; test/cursor-adapter.test.ts pins the mapping to the real reasons.
 */
export function ruleOf(reason: string): string {
	const rules: [RegExp, string][] = [
		[/installs or configures the agent harness/, "harness-script"],
		[/reaches outside the search root/, "search-outside-root"],
		[/^a search under .* can reach /, "search-reach"],
		[/is part of the agent harness|configures the agent harness/, "harness"],
		[/piping a download into a shell/, "download-into-shell"],
		[/^git .*is blocked; the user pushes$/, "git-push"],
		[/^gh .* is blocked; the user merges, approves, closes and comments$/, "gh-write"],
		[/^git reset --hard/, "git-reset-hard"],
		[/^git clean -f/, "git-clean"],
		[/\(rm -rf\)|^recursive delete/, "rm-recursive"],
		[/\(read(?::|\))|the command would read|the command names .*, a file protected/, "protect-read"],
		[/\(write: /, "protect-write"],
		[/ \(\.pi\/protect\.json\)$/, "protect-command"],
		[/is an environment file/, "env-file"],
		[/is inside \.pi\//, "pi-dir"],
		[/is inside .*\/, which is protected/, "secret-dir"],
		[/looks like a credential or secret file/, "secret-file"],
	];
	return rules.find(([pattern]) => pattern.test(reason))?.[1] ?? "other";
}

/** Appends the entries with a timestamp. Rotates once at 5 MB (log.jsonl.1). Never throws. */
export function appendLog(home: string, entries: readonly LogEntry[], now: Date = new Date()): void {
	if (!entries.length) return;
	try {
		const dir = stateDir(home);
		mkdirSync(dir, { recursive: true });
		const file = join(dir, LOG_FILE);
		try {
			if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
		} catch {
			// no log yet
		}
		const time = now.toISOString();
		appendFileSync(file, entries.map((entry) => `${JSON.stringify({ time, ...entry })}\n`).join(""));
	} catch {
		// The log is a record, not a gate: a full disk must not change the decision.
	}
}
