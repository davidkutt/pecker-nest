/**
 * Facts for a pull request review (skills/nest-review), read from GitHub, Pi's session files and the
 * Cursor adapter's log instead of typed by hand, and the patterns across saved reviews.
 *
 *   node scripts/nest-review.ts collect [--from nest|cursor] [--pr <number|url>] [--since <date>] [--json]
 *   node scripts/nest-review.ts patterns [--dir <reviews dir>] [--last <n>] [--json]
 *
 * `collect` runs in the product repository. The origin is nest unless `--from cursor` says otherwise. It reads the pull request with `gh` (read-only), proposes
 * the review window (from the commit the branch left `main` at to the last commit), lists the Pi
 * sessions that overlap it, sums up the Cursor adapter's gate and block records for the repository in
 * that window, and reads the CI state, the local checkout and the configuration under test. It names
 * every reason the review cannot go ahead (exit code 1) and every warning. Counts, dates and paths
 * only: never file contents, prompts, pull request titles or bodies, or command output.
 *
 * `patterns` reads the reviews David saved (default `field-notes/reviews/`, git-ignored): every
 * ```nest-review block in a Markdown file and every line of a `.jsonl` file holds one record, a review
 * or a fix. It counts the problem tags per lever over the last reviews, shows what recurs and whether
 * a tag still turns up after a recorded fix. Nothing is written, and no request leaves the machine
 * except `gh`'s reads.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stateDir, LOG_FILE } from "../cursor/lib/context.ts";
import { openNote, readConfig, renderConfig } from "./field-note.ts";
import { buildReport, parseSession, sessionFiles, sessionsDir, encodeCwd } from "./session-report.ts";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- levers and tags

/** The six levers a problem is put down to (docs/tasks/nest-review.md). */
export const LEVERS = ["config", "instructions", "harness", "target-repo", "task", "environment"] as const;
export type Lever = (typeof LEVERS)[number];

export const LEVER_NAMES: Record<Lever, string> = {
	config: "Config",
	instructions: "Instructions",
	harness: "Harness code",
	"target-repo": "Target repository",
	task: "Task",
	environment: "Environment",
};

/**
 * The fixed list of problem tags. A tag names what went wrong, the lever where to fix it, so one tag
 * can turn up under several levers; `patterns` counts each pair. A review may use a tag that is not
 * listed: `patterns` reports it as new, and David adds it here or maps it to an existing one.
 */
export const TAGS: Record<string, string> = {
	"task-not-met": "an acceptance check of the task is not met",
	"bug-shipped": "a bug is in the final diff although the gate was green",
	"weakened-test": "a test was deleted, skipped or loosened",
	"rule-break": "the diff breaks a rule of AGENTS.md or CLAUDE.md",
	"scope-creep": "changes the task did not ask for",
	"tests-not-run": "the agent did not run the tests or the check before it finished",
	"plan-skipped": "the agent built without planning a task that needed a plan",
	"edit-loop": "the same call repeated (the session report's loops)",
	"failed-edits": "many failed edits",
	"gate-repairs": "many quality-gate repair rounds",
	"handed-back-red": "the gate handed back red",
	"late-escalation": "the strong model stepped in too late or not at all",
	"needless-escalation": "the strong model stepped in where the working model would have done",
	"wrong-block": "the safety gate blocked a legitimate step, or let a wrong one through",
	"block-unreported": "the safety gate blocked a step and the agent did not tell David",
	"missing-context": "the agent lacked a fact it needed (repository, knowledge base, task)",
	"context-lost": "the agent lost track after a compaction or in a long session",
	"steering-needed": "David had to steer the agent during the session",
	"provider-errors": "request errors or failed calls from a model provider",
	"environment-broken": "dependencies, network, container or local tools failed",
	"cost-high": "the session cost far more than the task warranted",
	"empty-prompt-arg": "a prompt template arrived without its argument, e.g. /implement without a step",
};

// ---------------------------------------------------------------- pull request (pure)

export interface PullRequest {
	number: number;
	url: string;
	state: string;
	headRefName: string;
	headRefOid: string;
	baseRefName: string;
	commits: { oid: string; committedDate: string }[];
	files: { path: string; additions: number; deletions: number }[];
	checks: CheckSummary;
}

export interface CheckSummary {
	/** green: all finished checks passed · red: one failed · pending: one still runs · none: no checks. */
	state: "green" | "red" | "pending" | "none";
	total: number;
	success: number;
	failure: number;
	pending: number;
}

/** The pull request number from `12`, `#12` or a pull request URL. */
export function parsePrRef(value: string): number | undefined {
	const match = /^#?(\d+)$/.exec(value.trim()) ?? /\/pull\/(\d+)(?:[/?#].*)?$/.exec(value.trim());
	return match ? Number(match[1]) : undefined;
}

const PASSING = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);

/** Sums up `statusCheckRollup` from `gh pr view --json`: check runs carry status and conclusion, status contexts a state. */
export function summarizeChecks(rollup: unknown): CheckSummary {
	const summary: CheckSummary = { state: "none", total: 0, success: 0, failure: 0, pending: 0 };
	for (const check of Array.isArray(rollup) ? rollup : []) {
		const record = (check ?? {}) as { status?: string; conclusion?: string; state?: string };
		const status = String(record.status ?? "").toUpperCase();
		const result = String(record.conclusion || record.state || "").toUpperCase();
		summary.total++;
		if ((status && status !== "COMPLETED") || PENDING.has(result) || (!result && !status)) summary.pending++;
		else if (PASSING.has(result)) summary.success++;
		else summary.failure++;
	}
	summary.state = !summary.total ? "none" : summary.failure ? "red" : summary.pending ? "pending" : "green";
	return summary;
}

/** The fields this script needs from `gh pr view --json number,url,state,headRefName,headRefOid,baseRefName,commits,files,statusCheckRollup`. */
export function pullRequestFromGh(json: unknown): PullRequest {
	const data = (json ?? {}) as Record<string, unknown>;
	const commits = (Array.isArray(data.commits) ? data.commits : []).map((commit) => {
		const record = commit as { oid?: string; committedDate?: string; authoredDate?: string };
		return { oid: String(record.oid ?? ""), committedDate: String(record.committedDate ?? record.authoredDate ?? "") };
	});
	const files = (Array.isArray(data.files) ? data.files : []).map((file) => {
		const record = file as { path?: string; additions?: number; deletions?: number };
		return { path: String(record.path ?? ""), additions: Number(record.additions ?? 0), deletions: Number(record.deletions ?? 0) };
	});
	return {
		number: Number(data.number),
		url: String(data.url ?? ""),
		state: String(data.state ?? ""),
		headRefName: String(data.headRefName ?? ""),
		headRefOid: String(data.headRefOid ?? ""),
		baseRefName: String(data.baseRefName ?? ""),
		commits: commits.sort((a, b) => Date.parse(a.committedDate) - Date.parse(b.committedDate)),
		files,
		checks: summarizeChecks(data.statusCheckRollup),
	};
}

export interface Window {
	start: string;
	end: string;
	/** branch-point: the date of the commit the branch left the base at · since: David's --since · first-commit: no branch point found. */
	source: "branch-point" | "since" | "first-commit";
}

/** The proposed review window: from the branch point (or --since) to the pull request's last commit. */
export function reviewWindow(pr: PullRequest, branchPoint?: string, since?: string): Window {
	const first = pr.commits[0]?.committedDate ?? "";
	const end = pr.commits.at(-1)?.committedDate ?? "";
	if (since) return { start: new Date(Date.parse(since)).toISOString(), end, source: "since" };
	if (branchPoint && !Number.isNaN(Date.parse(branchPoint))) return { start: branchPoint, end, source: "branch-point" };
	return { start: first, end, source: "first-commit" };
}

export const overlaps = (span: { start?: string; end?: string }, window: Window): boolean =>
	Boolean(span.start && span.end) && Date.parse(span.start!) <= Date.parse(window.end) && Date.parse(span.end!) >= Date.parse(window.start);

/** Commits of the pull request made between start and end. */
export function commitsDuring(pr: PullRequest, start?: string, end?: string): number {
	if (!start || !end) return 0;
	const from = Date.parse(start);
	const to = Date.parse(end);
	return pr.commits.filter((commit) => {
		const time = Date.parse(commit.committedDate);
		return time >= from && time <= to;
	}).length;
}

// ---------------------------------------------------------------- Pi sessions

export interface PiSession {
	file: string;
	start?: string;
	end?: string;
	/** Pull request commits made during the session; 0 for a session before the first commit. */
	commits: number;
	/** Edit and write calls, subagents included: a session that changed nothing reads 0. */
	edits: number;
}

/** Pi sessions of the repository that overlap the window, oldest first. */
export function piSessions(repoRoot: string, window: Window, pr: PullRequest, env: NodeJS.ProcessEnv = process.env): PiSession[] {
	const startTime = Date.parse(window.start);
	return sessionFiles(repoRoot, env)
		.filter((file) => statSync(file).mtimeMs >= startTime)
		.flatMap((file): PiSession[] => {
			const stamps = parseSession(file)
				.map((entry) => entry.timestamp)
				.filter((stamp): stamp is string => Boolean(stamp));
			const span = { start: stamps[0], end: stamps.at(-1) };
			if (!overlaps(span, window)) return [];
			return [{ file, ...span, commits: commitsDuring(pr, span.start, span.end), edits: buildReport([file]).stats.edits.calls }];
		})
		.sort((a, b) => Date.parse(a.start ?? "") - Date.parse(b.start ?? ""));
}

// ---------------------------------------------------------------- Cursor adapter log (pure)

export interface CursorLogEntry {
	time?: string;
	event?: string;
	decision?: string;
	rule?: string;
	repo?: string;
	gate?: "green" | "red";
	round?: number;
	findings?: number;
}

export interface CursorActivity {
	/** Log entries for the repository in the window. */
	entries: number;
	/**
	 * When turns that changed files in the repository ended (a gate run or a docs-only skip). The stop
	 * hook compares the working tree, so a turn also counts when Pi changed the files while a Cursor
	 * chat ran beside it, as in a supervised nest session.
	 */
	changedTurns: string[];
	gate: { runs: number; green: number; red: number; repairs: number; handedBack: number; findings: number };
	/** The gate's last result in the window. */
	last?: "green" | "red";
	blocks: Record<string, number>;
	first?: string;
	lastTime?: string;
}

export function parseCursorLog(text: string): CursorLogEntry[] {
	return text
		.split("\n")
		.filter((line) => line.trim())
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as CursorLogEntry];
			} catch {
				return [];
			}
		});
}

/** Whether a log entry's repository is this one: its checkout, or a Cursor worktree of it under `~/.cursor/worktrees/<repo>/`. */
export function isRepo(entryRepo: string | undefined, repoRoot: string, home: string): boolean {
	if (!entryRepo) return false;
	if (entryRepo === repoRoot) return true;
	return entryRepo.startsWith(`${join(home, ".cursor", "worktrees", basename(repoRoot))}/`);
}

export const emptyActivity = (): CursorActivity => ({ entries: 0, changedTurns: [], gate: { runs: 0, green: 0, red: 0, repairs: 0, handedBack: 0, findings: 0 }, blocks: {} });

export function cursorActivity(entries: readonly CursorLogEntry[], repoRoot: string, window: Window, home: string): CursorActivity {
	const activity = emptyActivity();
	const from = Date.parse(window.start);
	const to = Date.parse(window.end);
	for (const entry of entries) {
		const time = Date.parse(entry.time ?? "");
		if (Number.isNaN(time) || time < from || time > to || !isRepo(entry.repo, repoRoot, home)) continue;
		activity.entries++;
		activity.first ??= entry.time;
		activity.lastTime = entry.time;
		if (entry.decision === "deny") activity.blocks[entry.rule ?? "other"] = (activity.blocks[entry.rule ?? "other"] ?? 0) + 1;
		if (entry.event !== "stop") continue;
		if (entry.decision === "skip" && entry.rule === "docs-only") activity.changedTurns.push(entry.time!);
		if (!entry.gate) continue;
		activity.gate.runs++;
		activity.gate.findings += entry.findings ?? 0;
		activity.last = entry.gate;
		if (entry.gate === "green") activity.gate.green++;
		else activity.gate.red++;
		if (entry.decision === "repair") activity.gate.repairs++;
		if (entry.decision === "final") activity.gate.handedBack++;
		// One turn ends with its first green or its hand-back; a repair round continues the same turn.
		if (entry.decision !== "repair") activity.changedTurns.push(entry.time!);
	}
	return activity;
}

// ---------------------------------------------------------------- decision (pure)

export type Origin = "nest" | "cursor";

export interface Facts {
	origin: Origin;
	/** True when `--from` was not given and the origin is nest by default. */
	originDefault?: boolean;
	pr?: PullRequest;
	prError?: string;
	window?: Window;
	/** Where Pi keeps this repository's sessions. */
	piDir?: string;
	piSessions: PiSession[];
	cursor: CursorActivity;
	local: { head?: string; matchesPr: boolean; dirty: boolean; gateConfig?: string; canRunCheck: boolean };
	nest: { config: string; commit: string; dirty: boolean; changedSinceWindowStart: boolean };
	fieldNote?: string;
}

const LARGE_DIFF_FILES = 40;
const LARGE_DIFF_LINES = 2000;

/** Every reason the review cannot go ahead, and every warning, as the skill's plan sets them out. */
export function assess(facts: Facts): { aborts: string[]; warnings: string[] } {
	const aborts: string[] = [];
	const warnings: string[] = [];
	if (!facts.pr) {
		aborts.push(facts.prError ?? "no pull request found");
		return { aborts, warnings };
	}
	const piChanged = facts.piSessions.filter((session) => session.edits > 0);
	if (facts.origin === "nest") {
		if (!facts.piSessions.length)
			aborts.push(
				`no Pi session of this repository overlaps the window (${facts.piDir ?? "Pi's session folder"}): nothing to review nest's work by${facts.originDefault ? "; the origin is nest because --from was not given: if Cursor did the work, run collect with --from cursor" : ""}`,
			);
		const during = (time: string) => facts.piSessions.some((session) => overlaps({ start: session.start, end: session.end }, { start: time, end: time, source: "since" }));
		const outside = facts.cursor.changedTurns.filter((time) => !during(time));
		const inside = facts.cursor.changedTurns.length - outside.length;
		if (outside.length)
			warnings.push(
				`Cursor's agent changed files in this repository outside nest's sessions (${outside.length} turn(s): ${outside.join(", ")}): if that was work on this PR, it mixes two agents and the review stops (one PR, one model); David confirms`,
			);
		if (inside)
			warnings.push(
				`Cursor's adapter saw changed files in ${inside} turn(s) while nest's sessions ran: that is nest's work seen from a Cursor chat beside it, unless Cursor's agent changed files itself (an intervention, or a second agent); David confirms`,
			);
	}
	if (facts.origin === "cursor") {
		const committed = piChanged.filter((session) => session.commits > 0);
		const other = piChanged.filter((session) => !session.commits);
		if (committed.length) aborts.push(`one PR, one model: ${committed.length} Pi session(s) changed files and made commits of this PR (${committed.map((session) => basename(session.file)).join(", ")})`);
		if (other.length)
			warnings.push(
				`${other.length} Pi session(s) in the window changed files but made none of the PR's commits (${other.map((session) => basename(session.file)).join(", ")}): if that was work on this PR, the review stops (one PR, one model); David confirms`,
			);
		if (!facts.cursor.gate.runs) warnings.push("no Cursor adapter gate record in the window: the gate result comes from CI only, and Cursor's transcript is the only session record");
	}
	const cursorGate = facts.origin === "cursor" && facts.cursor.gate.runs > 0;
	const checks = facts.pr.checks.state;
	if (!cursorGate && (checks === "pending" || checks === "none")) {
		const ci = checks === "pending" ? "CI is still running" : "the PR has no CI checks";
		if (facts.local.canRunCheck) warnings.push(`${ci}: run the check command of .pi/gate.json locally for the final gate state`);
		else
			aborts.push(
				`${ci} and the check cannot be repeated locally (${!facts.local.gateConfig ? "no .pi/gate.json" : !facts.local.matchesPr ? "HEAD is not the PR's head commit" : "uncommitted changes"})`,
			);
	}
	if (facts.nest.dirty) warnings.push("the pecker-nest checkout has uncommitted changes: the configuration under test is not exactly a commit");
	if (facts.nest.changedSinceWindowStart) warnings.push("pecker-nest has commits newer than the window start: the configuration line shows today's nest, which may not be the one that ran");
	const lines = facts.pr.files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
	if (facts.pr.files.length > LARGE_DIFF_FILES || lines > LARGE_DIFF_LINES)
		warnings.push(`large diff (${facts.pr.files.length} files, ${lines} lines): name the files you only saw in the --stat`);
	const before = facts.piSessions.filter((session) => !session.commits);
	if (facts.origin === "nest" && before.length) warnings.push(`${before.length} Pi session(s) in the window made none of the PR's commits: David confirms whether they belong to this PR`);
	return { aborts, warnings };
}

// ---------------------------------------------------------------- output

export function renderCollect(facts: Facts, verdict: { aborts: string[]; warnings: string[] }): string {
	const lines: string[] = ["# nest-review facts", ""];
	const pr = facts.pr;
	if (pr) {
		const added = pr.files.reduce((sum, file) => sum + file.additions, 0);
		const deleted = pr.files.reduce((sum, file) => sum + file.deletions, 0);
		lines.push(
			`- Pull request: #${pr.number} (${pr.state.toLowerCase()}), ${pr.url}`,
			`- Branch: \`${pr.headRefName}\` → \`${pr.baseRefName}\`, head ${pr.headRefOid.slice(0, 7)}; ${pr.commits.length} commit(s), ${pr.files.length} file(s), +${added} −${deleted}`,
		);
	}
	lines.push(`- Origin: ${facts.origin}${facts.originDefault ? " (default, no --from)" : ""}`);
	if (facts.window) lines.push(`- Window (${facts.window.source}): ${facts.window.start} → ${facts.window.end}`);
	lines.push(`- Config under test: ${facts.nest.config}`, `- Open field note: ${facts.fieldNote ?? "none"}`, "", "## Pi sessions in the window", "");
	if (facts.piSessions.length) {
		lines.push("| Session file | Start → end | PR commits during it | Edits |", "| --- | --- | ---: | ---: |");
		for (const session of facts.piSessions) lines.push(`| \`${session.file}\` | ${session.start} → ${session.end} | ${session.commits} | ${session.edits} |`);
		lines.push("", `After David confirms them: \`node ${join(NEST, "scripts/session-report.ts")} ${facts.piSessions.map((session) => session.file).join(" ")}\``);
	} else lines.push("None.");
	const cursor = facts.cursor;
	lines.push("", "## Cursor adapter in the window", "");
	if (cursor.entries) {
		lines.push(
			`Turns that changed files: ${cursor.changedTurns.length}. Quality gate: ${cursor.gate.runs} run(s), ${cursor.gate.green} green, ${cursor.gate.red} red, ${cursor.gate.repairs} repair round(s), handed back red ${cursor.gate.handedBack}×, ${cursor.gate.findings} weakened-test finding(s); last result ${cursor.last ?? "–"}.`,
		);
		const blocks = Object.entries(cursor.blocks);
		lines.push(blocks.length ? `Blocks: ${blocks.map(([rule, count]) => `${count}× ${rule}`).join(", ")}.` : "Blocks: none.");
	} else lines.push("No record for this repository.");
	if (pr)
		lines.push(
			"",
			"## Final gate state",
			"",
			`CI: ${pr.checks.state} (${pr.checks.success} passed, ${pr.checks.failure} failed, ${pr.checks.pending} running of ${pr.checks.total}).`,
			`Local checkout: HEAD ${facts.local.head?.slice(0, 7) ?? "?"}${facts.local.matchesPr ? " is the PR's head" : " is not the PR's head"}${facts.local.dirty ? ", uncommitted changes" : ""}; .pi/gate.json ${facts.local.gateConfig ? "present" : "missing"}; check can be repeated locally: ${facts.local.canRunCheck ? "yes" : "no"}.`,
		);
	lines.push("", "## Verdict", "");
	if (verdict.aborts.length) lines.push("Cannot review:", ...verdict.aborts.map((reason) => `- ${reason}`));
	else lines.push("Ready to review once David confirms the sessions.");
	if (verdict.warnings.length) lines.push("", "Warnings:", ...verdict.warnings.map((warning) => `- ${warning}`));
	return lines.join("\n");
}

// ---------------------------------------------------------------- saved reviews (pure)

export interface ReviewRecord {
	kind: "review";
	date: string;
	repo: string;
	pr: number;
	from: Origin;
	nestCommit?: string;
	reviewer?: string;
	taskMet?: "yes" | "partly" | "no";
	findings: { lever: Lever; tag: string }[];
	observe: { tag: string }[];
	source: string;
}

export interface FixRecord {
	kind: "fix";
	date: string;
	lever: Lever;
	tag: string;
	ref?: string;
	source: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isLever = (value: unknown): value is Lever => typeof value === "string" && (LEVERS as readonly string[]).includes(value);

/** One record from a parsed JSON object, or the reason it is not one (never its content). */
export function toRecord(value: unknown, source: string): ReviewRecord | FixRecord | string {
	const data = (value ?? {}) as Record<string, unknown>;
	if (data.kind === "fix") {
		if (typeof data.date !== "string" || !DATE.test(data.date)) return `${source}: fix without a date (YYYY-MM-DD)`;
		if (!isLever(data.lever)) return `${source}: fix with an unknown lever`;
		if (typeof data.tag !== "string" || !data.tag) return `${source}: fix without a tag`;
		return { kind: "fix", date: data.date, lever: data.lever, tag: data.tag, ref: typeof data.ref === "string" ? data.ref : undefined, source };
	}
	if (data.kind !== "review") return `${source}: kind is neither review nor fix`;
	if (typeof data.date !== "string" || !DATE.test(data.date)) return `${source}: review without a date (YYYY-MM-DD)`;
	if (typeof data.repo !== "string" || !data.repo) return `${source}: review without a repo`;
	if (!Number.isInteger(data.pr)) return `${source}: review without a PR number`;
	if (data.from !== "nest" && data.from !== "cursor") return `${source}: review whose from is neither nest nor cursor`;
	const findings = Array.isArray(data.findings) ? data.findings : [];
	for (const finding of findings) {
		const record = (finding ?? {}) as Record<string, unknown>;
		if (!isLever(record.lever)) return `${source}: finding with an unknown lever`;
		if (typeof record.tag !== "string" || !record.tag) return `${source}: finding without a tag`;
	}
	const observe = (Array.isArray(data.observe) ? data.observe : []).filter((item) => typeof (item as { tag?: unknown })?.tag === "string");
	return {
		kind: "review",
		date: data.date,
		repo: data.repo,
		pr: data.pr as number,
		from: data.from,
		nestCommit: typeof data.nestCommit === "string" ? data.nestCommit : undefined,
		reviewer: typeof data.reviewer === "string" ? data.reviewer : undefined,
		taskMet: data.taskMet === "yes" || data.taskMet === "partly" || data.taskMet === "no" ? data.taskMet : undefined,
		findings: findings.map((finding) => ({ lever: (finding as { lever: Lever }).lever, tag: (finding as { tag: string }).tag })),
		observe: observe.map((item) => ({ tag: (item as { tag: string }).tag })),
		source,
	};
}

/** Records in a saved file: ```nest-review blocks in Markdown, one JSON object per line in .jsonl. */
export function parseRecords(text: string, file: string): { records: (ReviewRecord | FixRecord)[]; errors: string[] } {
	const records: (ReviewRecord | FixRecord)[] = [];
	const errors: string[] = [];
	const chunks: { json: string; line: number }[] = [];
	if (file.endsWith(".jsonl")) {
		text.split("\n").forEach((line, index) => {
			if (line.trim()) chunks.push({ json: line, line: index + 1 });
		});
	} else {
		const block = /^```nest-review[^\n]*\n([\s\S]*?)^```/gm;
		for (let match = block.exec(text); match; match = block.exec(text)) {
			const line = text.slice(0, match.index).split("\n").length;
			for (const [offset, json] of match[1].split("\n").entries()) if (json.trim()) chunks.push({ json, line: line + 1 + offset });
		}
	}
	for (const chunk of chunks) {
		const source = `${basename(file)}:${chunk.line}`;
		let value: unknown;
		try {
			value = JSON.parse(chunk.json);
		} catch {
			errors.push(`${source}: not valid JSON`);
			continue;
		}
		const record = toRecord(value, source);
		if (typeof record === "string") errors.push(record);
		else records.push(record);
	}
	return { records, errors };
}

export interface PatternRow {
	lever: Lever;
	tag: string;
	/** Reviews that report this lever and tag. */
	reviews: number;
	prs: string[];
	lastSeen: string;
	/** The latest fix recorded for this lever and tag, and the reviews after it: with the tag, and in total. */
	fix?: { date: string; ref?: string; reviewsAfter: number; seenAfter: number };
	known: boolean;
}

export interface Patterns {
	reviews: number;
	rows: PatternRow[];
	/** Tags under "observe": the plan fixes them once they turn up in several PRs. */
	observed: { tag: string; reviews: number; prs: string[]; known: boolean }[];
}

/** Counts lever and tag pairs over the last `last` reviews (by date); recurring = in two or more reviews. */
export function countPatterns(records: readonly (ReviewRecord | FixRecord)[], last?: number): Patterns {
	const allReviews = records.filter((record): record is ReviewRecord => record.kind === "review").sort((a, b) => a.date.localeCompare(b.date));
	const reviews = last ? allReviews.slice(-last) : allReviews;
	const fixes = records.filter((record): record is FixRecord => record.kind === "fix");
	const rows = new Map<string, PatternRow>();
	const observed = new Map<string, Patterns["observed"][number]>();
	for (const review of reviews) {
		const pr = `${review.repo}#${review.pr}`;
		for (const key of new Set(review.findings.map((finding) => `${finding.lever}\u0000${finding.tag}`))) {
			const [lever, tag] = key.split("\u0000") as [Lever, string];
			const row = rows.get(key) ?? { lever, tag, reviews: 0, prs: [], lastSeen: review.date, known: tag in TAGS };
			row.reviews++;
			if (!row.prs.includes(pr)) row.prs.push(pr);
			row.lastSeen = review.date;
			rows.set(key, row);
		}
		for (const tag of new Set(review.observe.map((item) => item.tag))) {
			const row = observed.get(tag) ?? { tag, reviews: 0, prs: [], known: tag in TAGS };
			row.reviews++;
			if (!row.prs.includes(pr)) row.prs.push(pr);
			observed.set(tag, row);
		}
	}
	for (const row of rows.values()) {
		const fix = fixes
			.filter((record) => record.lever === row.lever && record.tag === row.tag)
			.sort((a, b) => a.date.localeCompare(b.date))
			.at(-1);
		if (!fix) continue;
		const after = reviews.filter((review) => review.date > fix.date);
		row.fix = {
			date: fix.date,
			ref: fix.ref,
			reviewsAfter: after.length,
			seenAfter: after.filter((review) => review.findings.some((finding) => finding.lever === row.lever && finding.tag === row.tag)).length,
		};
	}
	return {
		reviews: reviews.length,
		rows: [...rows.values()].sort((a, b) => b.reviews - a.reviews || a.lever.localeCompare(b.lever) || a.tag.localeCompare(b.tag)),
		observed: [...observed.values()].sort((a, b) => b.reviews - a.reviews || a.tag.localeCompare(b.tag)),
	};
}

export function renderPatterns(patterns: Patterns, errors: readonly string[]): string {
	const lines = ["# nest-review patterns", "", `Reviews counted: ${patterns.reviews}. Recurring: in two or more reviews.`, ""];
	if (patterns.rows.length) {
		lines.push("| Lever | Tag | Reviews | PRs | Last seen | After the latest fix |", "| --- | --- | ---: | --- | --- | --- |");
		for (const row of patterns.rows) {
			const fix = row.fix ? `fix ${row.fix.date}${row.fix.ref ? ` (${row.fix.ref})` : ""}: in ${row.fix.seenAfter} of ${row.fix.reviewsAfter} later review(s)` : "–";
			const tag = `${row.tag}${row.known ? "" : " (new)"}${row.reviews >= 2 ? " **recurring**" : ""}`;
			lines.push(`| ${LEVER_NAMES[row.lever]} | ${tag} | ${row.reviews} | ${row.prs.join(", ")} | ${row.lastSeen} | ${fix} |`);
		}
	} else lines.push("No findings yet.");
	if (patterns.observed.length) {
		lines.push("", "Observed (a fix is due once a tag turns up in several PRs):", "");
		for (const row of patterns.observed) lines.push(`- ${row.tag}${row.known ? "" : " (new)"}: ${row.reviews} review(s), ${row.prs.join(", ")}${row.reviews >= 2 ? " — due for a fix" : ""}`);
	}
	const fresh = [...new Set([...patterns.rows, ...patterns.observed].filter((row) => !row.known).map((row) => row.tag))];
	if (fresh.length) lines.push("", `Tags not in the list (add them to TAGS in scripts/nest-review.ts or map them to a listed one): ${fresh.join(", ")}.`);
	if (errors.length) lines.push("", "Records skipped:", ...errors.map((error) => `- ${error}`));
	return lines.join("\n");
}

// ---------------------------------------------------------------- side effects

function run(command: string, args: string[], cwd?: string): { ok: boolean; out: string; code: number } {
	try {
		return { ok: true, out: execFileSync(command, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim(), code: 0 };
	} catch (error) {
		return { ok: false, out: "", code: (error as { status?: number }).status ?? 1 };
	}
}

const PR_FIELDS = "number,url,state,headRefName,headRefOid,baseRefName,commits,files,statusCheckRollup";

/** The date of the commit the pull request's first commit was made on: local git first, then GitHub. */
function branchPointDate(firstOid: string, cwd: string): string | undefined {
	const local = run("git", ["log", "-1", "--format=%cI", `${firstOid}^`], cwd);
	if (local.ok && local.out) return new Date(local.out).toISOString();
	const parent = run("gh", ["api", `repos/{owner}/{repo}/commits/${firstOid}`, "--jq", ".parents[0].sha"], cwd);
	if (!parent.ok || !parent.out) return undefined;
	const date = run("gh", ["api", `repos/{owner}/{repo}/commits/${parent.out}`, "--jq", ".commit.committer.date"], cwd);
	return date.ok && date.out ? new Date(date.out).toISOString() : undefined;
}

function readCursorLog(home: string): CursorLogEntry[] {
	const file = join(stateDir(home), LOG_FILE);
	return [`${file}.1`, file].filter((path) => existsSync(path)).flatMap((path) => parseCursorLog(readFileSync(path, "utf-8")));
}

function collect(options: { origin: Origin; originDefault: boolean; pr?: string; since?: string; cwd: string }): Facts {
	const home = homedir();
	const top = run("git", ["rev-parse", "--show-toplevel"], options.cwd);
	const repoRoot = realpathSync(top.ok ? top.out : options.cwd);
	const config = readConfig();
	const facts: Facts = {
		origin: options.origin,
		originDefault: options.originDefault,
		piSessions: [],
		piDir: join(sessionsDir(), encodeCwd(repoRoot)),
		cursor: emptyActivity(),
		local: { matchesPr: false, dirty: false, canRunCheck: false },
		nest: { config: renderConfig(config), commit: config.commit, dirty: config.dirty, changedSinceWindowStart: false },
		fieldNote: openNote(join(NEST, "field-notes"), basename(repoRoot)),
	};
	const prNumber = options.pr === undefined ? undefined : parsePrRef(options.pr);
	if (options.pr !== undefined && prNumber === undefined) {
		facts.prError = `not a pull request number or URL: ${options.pr}`;
		return facts;
	}
	const view = run("gh", ["pr", "view", ...(prNumber === undefined ? [] : [String(prNumber)]), "--json", PR_FIELDS], repoRoot);
	if (!view.ok) {
		facts.prError = `gh pr view failed (exit ${view.code}): is gh signed in, and is there a pull request ${prNumber === undefined ? "for this branch" : `#${prNumber}`} in this repository?`;
		return facts;
	}
	let pr: PullRequest;
	try {
		pr = pullRequestFromGh(JSON.parse(view.out));
	} catch {
		facts.prError = "gh pr view printed no JSON: update gh (it needs --json)";
		return facts;
	}
	facts.pr = pr;
	const window = reviewWindow(pr, pr.commits[0] ? branchPointDate(pr.commits[0].oid, repoRoot) : undefined, options.since);
	facts.window = window;
	facts.piSessions = piSessions(repoRoot, window, pr);
	facts.cursor = cursorActivity(readCursorLog(home), repoRoot, window, home);
	const head = run("git", ["rev-parse", "HEAD"], repoRoot);
	const gateConfig = join(repoRoot, ".pi", "gate.json");
	facts.local.head = head.ok ? head.out : undefined;
	facts.local.matchesPr = Boolean(head.ok && head.out === pr.headRefOid);
	facts.local.dirty = Boolean(run("git", ["status", "--porcelain"], repoRoot).out);
	facts.local.gateConfig = existsSync(gateConfig) ? gateConfig : undefined;
	facts.local.canRunCheck = Boolean(facts.local.gateConfig && facts.local.matchesPr && !facts.local.dirty);
	const nestDate = run("git", ["-C", NEST, "log", "-1", "--format=%cI"]);
	facts.nest.changedSinceWindowStart = Boolean(nestDate.ok && window.start && Date.parse(nestDate.out) > Date.parse(window.start));
	return facts;
}

function reviewFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".md") || name.endsWith(".jsonl"))
		.sort()
		.map((name) => join(dir, name));
}

// ---------------------------------------------------------------- CLI

const USAGE = "usage: nest-review.ts collect [--from nest|cursor] [--pr <number|url>] [--since <date>] [--cwd DIR] [--json]\n       nest-review.ts patterns [--dir <reviews dir>] [--last <n>] [--json]";

function main(argv: string[]): number {
	const [command, ...rest] = argv;
	const options: { origin?: string; pr?: string; since?: string; cwd: string; dir: string; last?: number; json: boolean } = {
		cwd: process.cwd(),
		dir: join(NEST, "field-notes", "reviews"),
		json: false,
	};
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		const value = () => rest[++index] ?? "";
		if (arg === "--from") options.origin = value();
		else if (arg === "--pr") options.pr = value();
		else if (arg === "--since") options.since = value();
		else if (arg === "--cwd") options.cwd = resolve(value());
		else if (arg === "--dir") options.dir = resolve(value());
		else if (arg === "--last") options.last = Number(value());
		else if (arg === "--json") options.json = true;
		else {
			console.error(`nest-review.ts: unknown argument ${arg}\n${USAGE}`);
			return 2;
		}
	}
	if (options.since !== undefined && Number.isNaN(Date.parse(options.since))) {
		console.error(`nest-review.ts: --since expects a date, e.g. 2026-11-20T09:30, got ${options.since}`);
		return 2;
	}
	if (command === "collect") {
		const origin = options.origin ?? "nest";
		if (origin !== "nest" && origin !== "cursor") {
			console.error(`nest-review.ts: --from expects nest or cursor, got ${origin}`);
			return 2;
		}
		const facts = collect({ ...options, origin, originDefault: options.origin === undefined });
		const verdict = assess(facts);
		console.log(options.json ? JSON.stringify({ ...facts, ...verdict }, null, 2) : renderCollect(facts, verdict));
		return verdict.aborts.length ? 1 : 0;
	}
	if (command === "patterns") {
		if (options.last !== undefined && !(Number.isInteger(options.last) && options.last > 0)) {
			console.error("nest-review.ts: --last expects a positive whole number");
			return 2;
		}
		const parsed = reviewFiles(options.dir).map((file) => parseRecords(readFileSync(file, "utf-8"), file));
		const records = parsed.flatMap((result) => result.records);
		const errors = parsed.flatMap((result) => result.errors);
		const patterns = countPatterns(records, options.last);
		console.log(options.json ? JSON.stringify({ ...patterns, errors }, null, 2) : renderPatterns(patterns, errors));
		return 0;
	}
	console.error(USAGE);
	return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

