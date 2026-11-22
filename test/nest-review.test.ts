import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import {
	assess,
	commitsDuring,
	countPatterns,
	cursorActivity,
	type CursorLogEntry,
	emptyActivity,
	type Facts,
	isRepo,
	LEVERS,
	overlaps,
	parseCursorLog,
	parsePrRef,
	parseRecords,
	piSessions,
	type PullRequest,
	pullRequestFromGh,
	renderCollect,
	renderPatterns,
	reviewWindow,
	summarizeChecks,
	TAGS,
	toRecord,
	type Window,
} from "../scripts/nest-review.ts";
import { encodeCwd } from "../scripts/session-report.ts";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(NEST, "scripts/nest-review.ts");
const HOME = "/Users/david";
const REPO = "/Users/david/dev/undertext";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

/** `gh pr view --json …` as gh prints it, commits deliberately out of order. */
const ghJson = {
	number: 12,
	url: "https://github.com/davidkutt/undertext/pull/12",
	state: "OPEN",
	headRefName: "feat/m1-parser",
	headRefOid: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
	baseRefName: "main",
	commits: [
		{ oid: "b2", committedDate: "2026-11-20T11:00:00Z", authoredDate: "2026-11-20T11:00:00Z", messageHeadline: "feat: parser" },
		{ oid: "a1", committedDate: "2026-11-20T10:00:00Z", authoredDate: "2026-11-20T10:00:00Z", messageHeadline: "test: parser" },
	],
	files: [
		{ path: "src/parser.ts", additions: 120, deletions: 4 },
		{ path: "test/parser.test.ts", additions: 60, deletions: 0 },
	],
	statusCheckRollup: [
		{ __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "SUCCESS" },
		{ __typename: "StatusContext", context: "ci/lint", state: "SUCCESS" },
	],
};
const pr: PullRequest = pullRequestFromGh(ghJson);
const window: Window = { start: "2026-11-20T08:00:00.000Z", end: "2026-11-20T11:00:00Z", source: "branch-point" };

function facts(overrides: Partial<Facts> = {}): Facts {
	return {
		origin: "nest",
		pr,
		window,
		piSessions: [{ file: "/s/a.jsonl", start: "2026-11-20T09:00:00Z", end: "2026-11-20T11:30:00Z", commits: 2, edits: 14 }],
		cursor: emptyActivity(),
		local: { head: pr.headRefOid, matchesPr: true, dirty: false, gateConfig: `${REPO}/.pi/gate.json`, canRunCheck: true },
		nest: { config: "pecker-nest e0c4cfd, Pi 1.5.0", commit: "e0c4cfd", dirty: false, changedSinceWindowStart: false },
		...overrides,
	};
}

describe("pull request", () => {
	it("reads a number, #number or a pull request URL", () => {
		assert.equal(parsePrRef("12"), 12);
		assert.equal(parsePrRef("#12"), 12);
		assert.equal(parsePrRef("https://github.com/davidkutt/undertext/pull/12"), 12);
		assert.equal(parsePrRef("https://github.com/davidkutt/undertext/pull/12/files"), 12);
		assert.equal(parsePrRef("feat/m1"), undefined);
	});

	it("keeps the fields it needs and sorts commits oldest first", () => {
		assert.deepEqual(
			pr.commits.map((commit) => commit.oid),
			["a1", "b2"],
		);
		assert.equal(pr.number, 12);
		assert.equal(pr.headRefName, "feat/m1-parser");
		assert.equal(pr.files.length, 2);
		assert.equal(pr.checks.state, "green");
		assert.equal(JSON.stringify(pr).includes("messageHeadline"), false, "commit messages are not kept");
	});

	it("sums up check runs and status contexts", () => {
		assert.equal(summarizeChecks([]).state, "none");
		assert.equal(summarizeChecks(undefined).state, "none");
		assert.deepEqual(summarizeChecks([{ status: "IN_PROGRESS", conclusion: "" }, { status: "COMPLETED", conclusion: "SUCCESS" }]), {
			state: "pending",
			total: 2,
			success: 1,
			failure: 0,
			pending: 1,
		});
		assert.equal(summarizeChecks([{ state: "PENDING" }]).state, "pending");
		assert.equal(summarizeChecks([{ status: "COMPLETED", conclusion: "FAILURE" }, { status: "IN_PROGRESS" }]).state, "red", "a failure wins over a running check");
		assert.equal(summarizeChecks([{ state: "ERROR" }]).state, "red");
		assert.equal(summarizeChecks([{ status: "COMPLETED", conclusion: "SKIPPED" }, { status: "COMPLETED", conclusion: "NEUTRAL" }]).state, "green");
	});

	it("proposes the window from the branch point, --since or the first commit", () => {
		assert.deepEqual(reviewWindow(pr, "2026-11-19T17:00:00.000Z"), { start: "2026-11-19T17:00:00.000Z", end: "2026-11-20T11:00:00Z", source: "branch-point" });
		assert.deepEqual(reviewWindow(pr, "2026-11-19T17:00:00.000Z", "2026-11-20T09:30:00Z"), { start: "2026-11-20T09:30:00.000Z", end: "2026-11-20T11:00:00Z", source: "since" });
		assert.deepEqual(reviewWindow(pr, undefined), { start: "2026-11-20T10:00:00Z", end: "2026-11-20T11:00:00Z", source: "first-commit" });
	});

	it("tells overlapping spans and commits during a span", () => {
		assert.equal(overlaps({ start: "2026-11-20T07:00:00Z", end: "2026-11-20T08:30:00Z" }, window), true);
		assert.equal(overlaps({ start: "2026-11-20T06:00:00Z", end: "2026-11-20T07:59:00Z" }, window), false);
		assert.equal(overlaps({ start: "2026-11-20T11:01:00Z", end: "2026-11-20T12:00:00Z" }, window), false);
		assert.equal(overlaps({ start: undefined, end: "2026-11-20T09:00:00Z" }, window), false);
		assert.equal(commitsDuring(pr, "2026-11-20T09:00:00Z", "2026-11-20T10:30:00Z"), 1);
		assert.equal(commitsDuring(pr, "2026-11-20T09:00:00Z", "2026-11-20T11:00:00Z"), 2);
		assert.equal(commitsDuring(pr, undefined, "2026-11-20T11:00:00Z"), 0);
	});
});

describe("Pi sessions", () => {
	function session(dir: string, name: string, stamps: string[], edits: number) {
		const entries: unknown[] = [{ type: "session", cwd: REPO, timestamp: stamps[0] }];
		for (let index = 0; index < edits; index++) {
			entries.push({ type: "message", timestamp: stamps[0], message: { role: "assistant", model: "m", content: [{ type: "toolCall", id: `e${name}${index}`, name: "edit", arguments: { path: `f${index}` } }] } });
		}
		entries.push({ type: "message", timestamp: stamps.at(-1), message: { role: "user", content: [{ type: "text", text: "x" }] } });
		const file = join(dir, name);
		writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
		const time = new Date(stamps.at(-1)!);
		utimesSync(file, time, time);
	}

	it("lists the sessions that overlap the window with their commits and edits", () => {
		const sessions = tempDir("nest-review-sessions-");
		const dir = join(sessions, encodeCwd(REPO));
		mkdirSync(dir, { recursive: true });
		session(dir, "old.jsonl", ["2026-11-19T09:00:00Z", "2026-11-19T10:00:00Z"], 3);
		session(dir, "planning.jsonl", ["2026-11-20T08:10:00Z", "2026-11-20T08:50:00Z"], 0);
		session(dir, "build.jsonl", ["2026-11-20T09:00:00Z", "2026-11-20T11:30:00Z"], 4);
		const found = piSessions(REPO, window, pr, { PI_CODING_AGENT_SESSION_DIR: sessions });
		assert.deepEqual(
			found.map((item) => [item.file.split("/").at(-1), item.commits, item.edits]),
			[
				["planning.jsonl", 0, 0],
				["build.jsonl", 2, 4],
			],
		);
	});

	it("finds nothing for a repository Pi never ran in", () => {
		assert.deepEqual(piSessions("/nowhere", window, pr, { PI_CODING_AGENT_SESSION_DIR: tempDir("nest-review-empty-") }), []);
	});
});

describe("Cursor adapter log", () => {
	const at = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, "0")}:00.000Z`;
	const log: CursorLogEntry[] = [
		{ time: at(1), event: "beforeSubmitPrompt", decision: "start", repo: REPO },
		{ time: at(2), event: "preToolUse", decision: "deny", rule: "env-file", tool: "Read", repo: REPO } as CursorLogEntry,
		{ time: at(3), event: "stop", decision: "repair", repo: REPO, gate: "red", round: 1, findings: 1 },
		{ time: at(4), event: "stop", decision: "green", repo: REPO, gate: "green", round: 1, findings: 0 },
		{ time: at(5), event: "stop", decision: "skip", rule: "docs-only", repo: REPO },
		{ time: at(6), event: "stop", decision: "skip", rule: "no-change", repo: REPO },
		{ time: at(7), event: "stop", decision: "final", rule: "rounds-used", repo: `${HOME}/.cursor/worktrees/undertext/fix-x`, gate: "red", round: 4, findings: 2 },
		{ time: at(8), event: "stop", decision: "green", repo: "/Users/david/dev/other", gate: "green" },
		{ time: "2026-11-21T10:00:00.000Z", event: "stop", decision: "green", repo: REPO, gate: "green" },
	];

	it("parses JSON lines and skips broken ones", () => {
		assert.equal(parseCursorLog(`${JSON.stringify(log[0])}\nnot json\n\n${JSON.stringify(log[1])}`).length, 2);
	});

	it("matches the checkout and Cursor worktrees of the same repository only", () => {
		assert.equal(isRepo(REPO, REPO, HOME), true);
		assert.equal(isRepo(`${HOME}/.cursor/worktrees/undertext/fix-x`, REPO, HOME), true);
		assert.equal(isRepo(`${HOME}/.cursor/worktrees/undertext-old/fix-x`, REPO, HOME), false);
		assert.equal(isRepo("/Users/david/dev/other", REPO, HOME), false);
		assert.equal(isRepo(undefined, REPO, HOME), false);
	});

	it("sums up gate runs, turns that changed files and blocks inside the window", () => {
		const activity = cursorActivity(log, REPO, window, HOME);
		assert.equal(activity.entries, 7);
		assert.deepEqual(activity.gate, { runs: 3, green: 1, red: 2, repairs: 1, handedBack: 1, findings: 3 });
		assert.deepEqual(activity.changedTurns, [at(4), at(5), at(7)], "a repair round continues its turn; no-change is not a change");
		assert.equal(activity.last, "red");
		assert.deepEqual(activity.blocks, { "env-file": 1 });
	});
});

describe("assess", () => {
	it("is ready when everything is there", () => {
		assert.deepEqual(assess(facts()), { aborts: [], warnings: [] });
	});

	it("stops without an origin or a pull request", () => {
		const verdict = assess(facts({ origin: undefined, pr: undefined, prError: "gh pr view failed (exit 1)" }));
		assert.equal(verdict.aborts.length, 2);
		assert.match(verdict.aborts[0], /origin missing/);
		assert.match(verdict.aborts[1], /gh pr view failed/);
	});

	it("stops a nest review without a Pi session", () => {
		const verdict = assess(facts({ piSessions: [], piDir: "/s/--undertext--" }));
		assert.match(verdict.aborts.join("\n"), /no Pi session.*\/s\/--undertext--/);
	});

	it("asks David about Cursor turns that changed files beside or outside nest's sessions", () => {
		const cursor = { ...emptyActivity(), changedTurns: ["2026-11-20T10:00:00.000Z", "2026-11-20T08:30:00.000Z"] };
		const verdict = assess(facts({ cursor }));
		assert.deepEqual(verdict.aborts, []);
		assert.match(verdict.warnings.join("\n"), /outside nest's sessions \(1 turn\(s\): 2026-11-20T08:30:00.000Z\)/);
		assert.match(verdict.warnings.join("\n"), /in 1 turn\(s\) while nest's sessions ran/);
	});

	it("stops a Cursor review when a Pi session made commits of the PR, and asks about other Pi edits", () => {
		const verdict = assess(
			facts({
				origin: "cursor",
				piSessions: [
					{ file: "/s/build.jsonl", start: "2026-11-20T09:00:00Z", end: "2026-11-20T11:30:00Z", commits: 2, edits: 4 },
					{ file: "/s/other.jsonl", start: "2026-11-20T08:00:00Z", end: "2026-11-20T08:30:00Z", commits: 0, edits: 1 },
					{ file: "/s/read.jsonl", start: "2026-11-20T08:00:00Z", end: "2026-11-20T08:30:00Z", commits: 1, edits: 0 },
				],
			}),
		);
		assert.deepEqual(verdict.aborts, ["one PR, one model: 1 Pi session(s) changed files and made commits of this PR (build.jsonl)"]);
		assert.match(verdict.warnings.join("\n"), /other\.jsonl/);
		assert.match(verdict.warnings.join("\n"), /no Cursor adapter gate record/);
	});

	it("takes a Cursor PR's gate from the adapter, so CI may still run", () => {
		const cursor = { ...emptyActivity(), gate: { runs: 2, green: 1, red: 1, repairs: 1, handedBack: 0, findings: 0 }, last: "green" as const };
		const running = { ...pr, checks: summarizeChecks([{ status: "IN_PROGRESS" }]) };
		const verdict = assess(facts({ origin: "cursor", piSessions: [], cursor, pr: running, local: { matchesPr: false, dirty: false, canRunCheck: false } }));
		assert.deepEqual(verdict, { aborts: [], warnings: [] });
	});

	it("needs CI or a local check for the final gate state", () => {
		const running = { ...pr, checks: summarizeChecks([{ status: "IN_PROGRESS" }]) };
		assert.match(assess(facts({ pr: running })).warnings.join("\n"), /CI is still running: run the check command/);
		const elsewhere = { head: "d4", matchesPr: false, dirty: false, gateConfig: `${REPO}/.pi/gate.json`, canRunCheck: false };
		assert.match(assess(facts({ pr: running, local: elsewhere })).aborts.join("\n"), /CI is still running and the check cannot be repeated locally \(HEAD is not the PR's head commit\)/);
		const none = { ...pr, checks: summarizeChecks([]) };
		assert.match(assess(facts({ pr: none, local: { ...elsewhere, gateConfig: undefined } })).aborts.join("\n"), /no CI checks and the check cannot be repeated locally \(no \.pi\/gate\.json\)/);
		const dirty = { ...elsewhere, matchesPr: true, dirty: true };
		assert.match(assess(facts({ pr: none, local: dirty })).aborts.join("\n"), /uncommitted changes/);
		const red = { ...pr, checks: summarizeChecks([{ status: "COMPLETED", conclusion: "FAILURE" }]) };
		assert.deepEqual(assess(facts({ pr: red, local: elsewhere })).aborts, [], "a red CI is a final state");
	});

	it("warns about a changed nest, a large diff and sessions without commits", () => {
		const big = { ...pr, files: Array.from({ length: 41 }, (_, index) => ({ path: `f${index}`, additions: 1, deletions: 0 })) };
		const verdict = assess(
			facts({
				pr: big,
				nest: { config: "c", commit: "e0c4cfd", dirty: true, changedSinceWindowStart: true },
				piSessions: [{ file: "/s/plan.jsonl", start: "2026-11-20T08:10:00Z", end: "2026-11-20T08:50:00Z", commits: 0, edits: 0 }, ...facts().piSessions],
			}),
		);
		assert.deepEqual(verdict.aborts, []);
		assert.equal(verdict.warnings.length, 4);
		assert.match(verdict.warnings.join("\n"), /large diff \(41 files, 41 lines\)/);
		assert.match(verdict.warnings.join("\n"), /1 Pi session\(s\) in the window made none of the PR's commits/);
	});
});

describe("collect output", () => {
	it("holds counts, dates and paths, not titles or commit messages", () => {
		const text = renderCollect(facts(), assess(facts()));
		assert.match(text, /#12 \(open\)/);
		assert.match(text, /2 commit\(s\), 2 file\(s\), \+180 −4/);
		assert.match(text, /\| `\/s\/a\.jsonl` \| .* \| 2 \| 14 \|/);
		assert.match(text, /scripts\/session-report\.ts \/s\/a\.jsonl/);
		assert.match(text, /Ready to review once David confirms the sessions/);
		assert.equal(text.includes("feat: parser"), false);
	});

	it("leaves out the gate section without a pull request", () => {
		const text = renderCollect(facts({ pr: undefined, prError: "no pull request found" }), assess(facts({ pr: undefined, prError: "no pull request found" })));
		assert.equal(text.includes("Final gate state"), false);
		assert.match(text, /Cannot review:\n- no pull request found/);
	});
});

describe("saved reviews", () => {
	const review = (date: string, pr: number, findings: [string, string][], observe: string[] = []) =>
		JSON.stringify({ kind: "review", date, repo: "undertext", pr, from: "nest", nestCommit: "e0c4cfd", reviewer: "Claude", taskMet: "partly", findings: findings.map(([lever, tag]) => ({ lever, tag })), observe: observe.map((tag) => ({ tag })) });

	it("has six levers and tags in kebab case", () => {
		assert.equal(LEVERS.length, 6);
		for (const tag of Object.keys(TAGS)) assert.match(tag, /^[a-z]+(-[a-z]+)*$/);
	});

	it("reads nest-review blocks in Markdown and lines in .jsonl", () => {
		const markdown = ["# Review", "", "```json", "{\"kind\":\"review\"}", "```", "", "```nest-review", review("2026-11-20", 12, [["instructions", "tests-not-run"]]), "```"].join("\n");
		const fromMarkdown = parseRecords(markdown, "/r/2026-11-20-undertext-pr12.md");
		assert.equal(fromMarkdown.records.length, 1, "only nest-review blocks count");
		assert.deepEqual(fromMarkdown.errors, []);
		const lines = `${review("2026-11-21", 13, [])}\n\n${JSON.stringify({ kind: "fix", date: "2026-11-22", lever: "instructions", tag: "tests-not-run", ref: "pecker-nest#15" })}\n`;
		const fromJsonl = parseRecords(lines, "/r/fixes.jsonl");
		assert.deepEqual(
			fromJsonl.records.map((record) => record.kind),
			["review", "fix"],
		);
	});

	it("names a broken record by file and line, never by its content", () => {
		const text = ["```nest-review", "{broken", JSON.stringify({ kind: "review", date: "2026-11-20", repo: "secret-repo", pr: 1, from: "nest", findings: [{ lever: "vibes", tag: "x" }] }), "```"].join("\n");
		const { records, errors } = parseRecords(text, "/r/a.md");
		assert.equal(records.length, 0);
		assert.deepEqual(errors, ["a.md:2: not valid JSON", "a.md:3: finding with an unknown lever"]);
		assert.match(String(toRecord({ kind: "review", date: "20.11.2026" }, "x")), /without a date/);
		assert.match(String(toRecord({ kind: "fix", date: "2026-11-20", lever: "task" }, "x")), /fix without a tag/);
		assert.match(String(toRecord({ kind: "note" }, "x")), /neither review nor fix/);
		assert.match(String(toRecord({ kind: "review", date: "2026-11-20", repo: "u", pr: 1, from: "pi", findings: [] }, "x")), /from is neither/);
	});

	it("counts lever and tag pairs, recurring ones and what a fix changed", () => {
		const parsed = parseRecords(
			[
				review("2026-11-18", 10, [["instructions", "tests-not-run"], ["instructions", "tests-not-run"], ["task", "scope-creep"]], ["edit-loop"]),
				review("2026-11-19", 11, [["instructions", "tests-not-run"]], ["edit-loop"]),
				review("2026-11-23", 14, [["harness", "made-up-tag"]]),
				review("2026-11-24", 15, [["instructions", "tests-not-run"]]),
				JSON.stringify({ kind: "fix", date: "2026-11-20", lever: "instructions", tag: "tests-not-run", ref: "pecker-nest#15" }),
			].join("\n"),
			"/r/all.jsonl",
		);
		const patterns = countPatterns(parsed.records);
		assert.equal(patterns.reviews, 4);
		const tests = patterns.rows[0];
		assert.deepEqual(
			{ ...tests, prs: tests.prs.join(",") },
			{ lever: "instructions", tag: "tests-not-run", reviews: 3, prs: "undertext#10,undertext#11,undertext#15", lastSeen: "2026-11-24", known: true, fix: { date: "2026-11-20", ref: "pecker-nest#15", reviewsAfter: 2, seenAfter: 1 } },
		);
		assert.deepEqual(patterns.observed, [{ tag: "edit-loop", reviews: 2, prs: ["undertext#10", "undertext#11"], known: true }]);
		const text = renderPatterns(patterns, ["x.md:3: not valid JSON"]);
		assert.match(text, /\| Instructions \| tests-not-run \*\*recurring\*\* \| 3 \|/);
		assert.match(text, /fix 2026-11-20 \(pecker-nest#15\): in 1 of 2 later review\(s\)/);
		assert.match(text, /made-up-tag \(new\)/);
		assert.match(text, /Tags not in the list .*: made-up-tag\./);
		assert.match(text, /edit-loop: 2 review\(s\).*due for a fix/);
		assert.match(text, /Records skipped:\n- x\.md:3: not valid JSON/);
		assert.equal(countPatterns(parsed.records, 2).reviews, 2, "--last counts the newest reviews");
	});
});

describe("CLI", () => {
	it("prints the patterns of a reviews folder", () => {
		const dir = tempDir("nest-review-reviews-");
		writeFileSync(join(dir, "2026-11-20-undertext-pr12.md"), ["# Review", "```nest-review", JSON.stringify({ kind: "review", date: "2026-11-20", repo: "undertext", pr: 12, from: "nest", findings: [{ lever: "task", tag: "scope-creep" }] }), "```"].join("\n"));
		writeFileSync(join(dir, "notes.txt"), "ignored");
		const result = spawnSync(process.execPath, [SCRIPT, "patterns", "--dir", dir, "--json"], { encoding: "utf-8" });
		assert.equal(result.status, 0, result.stderr);
		const patterns = JSON.parse(result.stdout);
		assert.equal(patterns.reviews, 1);
		assert.equal(patterns.rows[0].tag, "scope-creep");
	});

	it("collects the facts of a pull request with gh, git and Pi's session folder", () => {
		const repo = realpathSync(tempDir("nest-review-repo-"));
		const git = (args: string[], date: string) =>
			spawnSync("git", args, {
				cwd: repo,
				encoding: "utf-8",
				env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
			});
		git(["init", "-q", "-b", "main"], "2026-11-20T08:00:00Z");
		const commit = (name: string, date: string) => {
			writeFileSync(join(repo, name), name);
			git(["add", name], date);
			git(["commit", "-q", "-m", name], date);
			return git(["rev-parse", "HEAD"], date).stdout.trim();
		};
		commit("base", "2026-11-20T08:00:00Z");
		const first = commit("a", "2026-11-20T10:00:00Z");
		const head = commit("b", "2026-11-20T11:00:00Z");

		const bin = tempDir("nest-review-bin-");
		const view = { ...ghJson, headRefOid: head, commits: [{ oid: first, committedDate: "2026-11-20T10:00:00Z" }, { oid: head, committedDate: "2026-11-20T11:00:00Z" }] };
		writeFileSync(join(bin, "view.json"), JSON.stringify(view));
		writeFileSync(join(bin, "gh"), `#!/bin/sh\n[ "$1 $2" = "pr view" ] && exec cat "${join(bin, "view.json")}"\nexit 1\n`);
		chmodSync(join(bin, "gh"), 0o755);

		const sessions = tempDir("nest-review-pi-");
		mkdirSync(join(sessions, encodeCwd(repo)));
		const file = join(sessions, encodeCwd(repo), "build.jsonl");
		writeFileSync(
			file,
			[
				{ type: "session", cwd: repo, timestamp: "2026-11-20T09:30:00Z" },
				{ type: "message", timestamp: "2026-11-20T11:05:00Z", message: { role: "assistant", model: "m", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a" } }] } },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);
		const home = tempDir("nest-review-home-");
		const result = spawnSync(process.execPath, [SCRIPT, "collect", "--from", "nest", "--pr", "12", "--json"], {
			cwd: repo,
			encoding: "utf-8",
			env: { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, PI_CODING_AGENT_SESSION_DIR: sessions },
		});
		assert.equal(result.status, 0, result.stdout + result.stderr);
		const collected = JSON.parse(result.stdout);
		assert.deepEqual(collected.window, { start: "2026-11-20T08:00:00.000Z", end: "2026-11-20T11:00:00Z", source: "branch-point" });
		assert.deepEqual(
			collected.piSessions.map((session: { file: string; commits: number; edits: number }) => [session.file, session.commits, session.edits]),
			[[file, 2, 1]],
		);
		assert.equal(collected.local.matchesPr, true);
		assert.equal(collected.local.canRunCheck, false, "no .pi/gate.json");
		assert.equal(collected.pr.checks.state, "green");
		assert.deepEqual(collected.aborts, []);

		const missing = spawnSync(process.execPath, [SCRIPT, "collect", "--pr", "12"], { cwd: repo, encoding: "utf-8", env: { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, PI_CODING_AGENT_SESSION_DIR: sessions } });
		assert.equal(missing.status, 1);
		assert.match(missing.stdout, /origin missing/);
	});

	it("rejects unknown commands, arguments and a bad --last", () => {
		assert.equal(spawnSync(process.execPath, [SCRIPT, "review"], { encoding: "utf-8" }).status, 2);
		assert.equal(spawnSync(process.execPath, [SCRIPT, "collect", "--frm", "nest"], { encoding: "utf-8" }).status, 2);
		assert.equal(spawnSync(process.execPath, [SCRIPT, "patterns", "--last", "0"], { encoding: "utf-8" }).status, 2);
		assert.equal(spawnSync(process.execPath, [SCRIPT, "collect", "--since", "yesterday-ish"], { encoding: "utf-8" }).status, 2);
	});
});
