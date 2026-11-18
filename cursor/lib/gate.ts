/**
 * The quality gate in Cursor. beforeSubmitPrompt records each trusted repository's working tree for
 * the conversation; stop compares, runs the weakened-test check and the repository's check command,
 * and sends a red result back to the same agent as a follow-up message, built by
 * extensions/lib/gate-message.ts exactly as nest builds it.
 *
 * Differences to Pi's quality-gate.ts, all from docs/research/cursor-hooks.md:
 * - Rounds are counted per user prompt, in the turn's state file and by Cursor's `loop_count`,
 *   which also starts again at every new prompt (C4).
 * - Cursor calls `stop` at most `loop_limit` times per prompt; the round after the last follow-up
 *   gets no `stop` at all (X11). So the gate keeps the last call for the hand-back: at most
 *   `loop_limit - 1` repair rounds, and a red result at `loop_count = loop_limit - 1` is handed back.
 * - `stop` cannot show David anything (C4), so the hand-back is one last follow-up that tells the
 *   agent to change nothing more and to report the result to the user.
 * - `workspace_roots` can be stale or show one folder of several (X12), so a repository the agent
 *   is about to change joins the turn from the permission hooks (joinTurn), with its baseline taken
 *   before the change.
 * - The check command gets the recorded Node's directory in front of PATH, so `npm` and `pnpm` of a
 *   Node installed with fnm are found by a hook started from the GUI.
 * - The check command runs repository code outside Cursor's sandbox with the user's rights, so its
 *   environment makes pushes and GitHub writes fail (checkEnvironment). A tripwire, not a sandbox.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type GateConfig, isDocsOnly, loadGateConfig } from "../../extensions/lib/gate-config.ts";
import {
	type CheckOutcome,
	GATE_MESSAGE_PREFIX,
	handBackMessage,
	handBackReason,
	isEnvironmentProblem,
	repairMessage,
	unchangedFindingsMessage,
} from "../../extensions/lib/gate-message.ts";
import { type Finding, snapshotTree, tamperFindings } from "../../extensions/lib/tamper-check.ts";
import { changedPaths, snapshotKey, takeSnapshot } from "../../extensions/lib/worktree.ts";
import { type AdapterContext, STOP_LOOP_LIMIT, STOP_RESERVE_SECONDS, STOP_TIMEOUT_SECONDS, stateDir, TURNS_DIR } from "./context.ts";
import type { LogEntry } from "./log.ts";
import { type Payload, text, workspaceRoots } from "./payload.ts";
import type { HookResult } from "./permission.ts";
import { isTrusted, readTrustList, trustFile } from "./trust.ts";

/** One repository's part of a turn. */
export interface RepoTurn {
	repo: string;
	/** takeSnapshot at the prompt, as entries. */
	baseline: [string, string][];
	/** snapshotTree at the prompt, for the weakened-test check. */
	baseTree?: string;
	/** snapshotKey of the last red round, to notice a round that changed nothing. */
	lastFailedKey?: string;
	openFindings: Finding[];
	/** Green, or handed back: nothing more to do in this turn. */
	done?: boolean;
}

export interface TurnState {
	version: 1;
	conversation: string;
	started: string;
	/** Repair rounds sent since the prompt. */
	rounds: number;
	repos: RepoTurn[];
	/** Repositories already looked at that the gate does not cover (no gate, untrusted, not git). */
	passed?: string[];
}

/** Added to a hand-back, because only the agent can show David the result. */
export const REPORT_INSTRUCTION =
	"This message comes from pecker-nest's quality gate, not from the user, and it is the last one for this prompt. Change nothing more. In your answer, tell the user that the gate handed the task back to them and repeat the result above with every finding, then stop.";

/** For a multi-root workspace where one repository is handed back while another is repaired. */
export const MIXED_INSTRUCTION =
	"The hand-back above comes from pecker-nest's quality gate, not from the user: change nothing more in that repository, and at the end of your answer tell the user that the gate handed it back to them, with every finding.";

const TURN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const turnsDir = (home: string) => join(stateDir(home), TURNS_DIR);

/** The state file of a conversation; the id is reduced to safe characters. */
export function turnFile(home: string, conversation: string): string {
	return join(turnsDir(home), `${conversation.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120)}.json`);
}

export function readTurn(file: string): TurnState | undefined {
	try {
		const state = JSON.parse(readFileSync(file, "utf-8")) as TurnState;
		return state && state.version === 1 && Array.isArray(state.repos) ? state : undefined;
	} catch {
		return undefined;
	}
}

function writeTurn(file: string, state: TurnState): void {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(state));
	renameSync(temporary, file);
}

function pruneTurns(home: string, now: Date): void {
	const dir = turnsDir(home);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const file = join(dir, name);
		try {
			if (now.getTime() - statSync(file).mtimeMs > TURN_MAX_AGE_MS) rmSync(file, { force: true });
		} catch {
			// gone already
		}
	}
}

/** The gate config of `repo`; undefined when absent, the error when invalid. */
function gateConfig(repo: string): { config?: GateConfig; error?: string } {
	try {
		return { config: loadGateConfig(repo) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/** A repository's part of a turn, with its baseline taken now, or why the gate does not cover it. */
function repoTurn(repo: string, trusted: readonly string[]): { turn: RepoTurn } | { skip: string } {
	const { config, error } = gateConfig(repo);
	if (error) return { skip: "gate-invalid" };
	if (!config) return { skip: "no-gate" };
	if (!isTrusted(repo, trusted)) return { skip: "untrusted" };
	const baseline = takeSnapshot(repo);
	if (!baseline) return { skip: "not-git" };
	return { turn: { repo, baseline: [...baseline], baseTree: config.tamperCheck ? snapshotTree(repo) : undefined, openFindings: [] } };
}

/**
 * beforeSubmitPrompt: a new turn. Records, for every workspace root with a `.pi/gate.json` that is
 * trusted and a git work tree, the working tree as the gate's baseline. Cursor submits each of the
 * gate's follow-ups as a prompt (X11); one that starts with `[quality-gate]` keeps the running turn.
 */
export function startTurn(payload: Payload, context: AdapterContext): HookResult {
	const answer = { continue: true };
	const event = "beforeSubmitPrompt";
	const conversation = text(payload.conversation_id);
	if (!conversation) return { answer, entries: [{ event, decision: "skip", rule: "no-conversation-id" }] };
	const file = turnFile(context.home, conversation);
	const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
	if (prompt.trimStart().startsWith(GATE_MESSAGE_PREFIX) && readTurn(file)) return { answer, entries: [{ event, decision: "continue", rule: "gate-followup" }] };

	const now = context.now();
	pruneTurns(context.home, now);
	const trusted = readTrustList(trustFile(context.home));
	const entries: LogEntry[] = [];
	const repos: RepoTurn[] = [];
	const passed: string[] = [];
	for (const repo of workspaceRoots(payload, context.env)) {
		const result = repoTurn(repo, trusted);
		if ("skip" in result) {
			passed.push(repo);
			if (result.skip !== "no-gate") entries.push({ event, decision: "skip", rule: result.skip, repo });
			continue;
		}
		repos.push(result.turn);
		entries.push({ event, decision: "start", repo });
	}
	// Written also without a repository, so one the agent changes later can join (joinTurn).
	writeTurn(file, { version: 1, conversation, started: now.toISOString(), rounds: 0, repos, passed });
	if (!entries.length) entries.push({ event, decision: "continue", rule: "no-gate-repo" });
	return { answer, entries };
}

/**
 * After an allowed write, delete or command: a repository it is about to change that the turn does
 * not know yet joins the turn, with its baseline taken now, before the change. Cursor's
 * `workspace_roots` stays on a worktree after `move_agent_to_root` back to the main checkout, and
 * shows one folder of a multi-root workspace (X12); without this the gate would look at the wrong
 * tree or none. A subagent's tool calls carry their own conversation, which has no turn: its changes
 * in a repository the parent's turn knows are still in that repository's diff. Never changes the
 * decision and never throws.
 */
export function joinTurn(result: HookResult, payload: Payload, context: AdapterContext): HookResult {
	const touched = result.touched ?? [];
	if (!touched.length || result.answer.permission !== "allow") return result;
	try {
		const conversation = text(payload.conversation_id);
		if (!conversation) return result;
		const file = turnFile(context.home, conversation);
		const state = readTurn(file);
		if (!state) return result;
		const passed = state.passed ?? [];
		const known = new Set([...state.repos.map((turn) => turn.repo), ...passed]);
		const fresh = touched.filter((repo) => !known.has(repo));
		if (!fresh.length) return result;
		const event = result.entries[0]?.event ?? "preToolUse";
		const trusted = readTrustList(trustFile(context.home));
		const entries: LogEntry[] = [];
		for (const repo of fresh) {
			const joined = repoTurn(repo, trusted);
			if ("skip" in joined) {
				passed.push(repo);
				if (joined.skip !== "no-gate") entries.push({ event, decision: "skip", rule: joined.skip, repo });
				continue;
			}
			state.repos.push(joined.turn);
			entries.push({ event, decision: "join", repo });
		}
		writeTurn(file, { ...state, passed });
		return { ...result, entries: [...result.entries, ...entries] };
	} catch {
		return result;
	}
}

export interface CheckRun extends CheckOutcome {
	seconds: number;
}

export type RunCheck = (command: string, cwd: string, timeoutSeconds: number) => CheckRun;

/** The token gh gets in the check command: a placeholder, so gh does not fall back to the stored login. */
export const GATE_GH_TOKEN = "pecker-nest-gate-no-token";

/**
 * The environment of the check command. The check runs repository code the agent may have changed,
 * outside Cursor's sandbox and with the user's rights; so pushes and GitHub writes from it should
 * fail without disturbing ordinary tests: no terminal or askpass prompt, no SSH (command and agent),
 * no git credential helper (an empty `credential.helper` resets osxkeychain, appended after the
 * user's own GIT_CONFIG_COUNT entries), and a gh token that GitHub refuses. A tripwire, not a
 * sandbox: the code can still read files and use other credentials.
 */
export function checkEnvironment(env: NodeJS.ProcessEnv, nodeDir: string): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = { ...env, PATH: [nodeDir, env.PATH].filter(Boolean).join(":") };
	delete result.SSH_AUTH_SOCK;
	delete result.GITHUB_TOKEN;
	const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
	const index = Number.isInteger(count) && count > 0 ? count : 0;
	return {
		...result,
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "/usr/bin/false",
		SSH_ASKPASS: "/usr/bin/false",
		GIT_SSH_COMMAND: "false",
		GIT_CONFIG_COUNT: String(index + 1),
		[`GIT_CONFIG_KEY_${index}`]: "credential.helper",
		[`GIT_CONFIG_VALUE_${index}`]: "",
		GH_TOKEN: GATE_GH_TOKEN,
	};
}

/** The check command with `bash -c` in the repository, Node's directory first on PATH, in checkEnvironment. */
export function runCheckCommand(command: string, cwd: string, timeoutSeconds: number, env: NodeJS.ProcessEnv = process.env, nodeDir = dirname(process.execPath)): CheckRun {
	const started = Date.now();
	const result = spawnSync("/bin/bash", ["-c", command], {
		cwd,
		env: checkEnvironment(env, nodeDir),
		encoding: "utf-8",
		timeout: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
		killSignal: "SIGKILL",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
	const code = typeof result.status === "number" ? result.status : timedOut ? 124 : 1;
	const output = [result.stdout ?? "", result.stderr ?? ""].filter((part) => part.trim()).join("\n");
	return { ok: code === 0 && !timedOut, code, timedOut, output, seconds: Math.round((Date.now() - started) / 1000) };
}

/**
 * The repair rounds a repository gets: its `maxRepairRounds`, at most `loop_limit - 1`, so that the
 * stop after the last repair round is still called and can hand back (X11).
 */
export const roundsFor = (config: GateConfig) => Math.min(config.maxRepairRounds, STOP_LOOP_LIMIT - 1);
/** The check's timeout inside the stop hook's own timeout; 0 in `.pi/gate.json` means that ceiling. */
export const timeoutFor = (config: GateConfig) => Math.min(config.timeoutSeconds > 0 ? config.timeoutSeconds : Number.POSITIVE_INFINITY, STOP_TIMEOUT_SECONDS - STOP_RESERVE_SECONDS);

/**
 * stop: the gate for each repository of the turn that changed more than docs. Answers a
 * `followup_message` while there is something to repair or to hand back, else nothing.
 */
export function stopTurn(payload: Payload, context: AdapterContext, run: RunCheck = (command, cwd, timeout) => runCheckCommand(command, cwd, timeout, context.env)): HookResult {
	const event = "stop";
	const status = text(payload.status) ?? "unknown";
	const conversation = text(payload.conversation_id);
	if (status !== "completed") return { answer: {}, entries: [{ event, decision: "skip", rule: `status-${status}` }] };
	if (!conversation) return { answer: {}, entries: [{ event, decision: "skip", rule: "no-conversation-id" }] };
	const file = turnFile(context.home, conversation);
	const state = readTurn(file);
	if (!state) return { answer: {}, entries: [{ event, decision: "skip", rule: "no-turn-start" }] };
	if (!state.repos.length) return { answer: {}, entries: [{ event, decision: "skip", rule: "no-gate-repo" }] };

	// Follow-ups already sent for this prompt: ours, and Cursor's count, which also sees those of
	// other stop hooks. Cursor calls stop for loop_count 0 to loop_limit - 1 only (X11).
	const loopCount = typeof payload.loop_count === "number" && Number.isInteger(payload.loop_count) ? payload.loop_count : 0;
	const used = Math.max(state.rounds, loopCount);
	const trusted = readTrustList(trustFile(context.home));
	const entries: LogEntry[] = [];
	const repairs: string[] = [];
	const handBacks: string[] = [];
	for (const turn of state.repos) {
		if (turn.done) continue;
		const repo = turn.repo;
		const { config, error } = gateConfig(repo);
		if (error || !config) {
			entries.push({ event, decision: "skip", rule: error ? "gate-invalid" : "no-gate", repo });
			continue;
		}
		if (!isTrusted(repo, trusted)) {
			entries.push({ event, decision: "skip", rule: "untrusted", repo });
			continue;
		}
		const current = takeSnapshot(repo);
		if (!current) {
			entries.push({ event, decision: "skip", rule: "not-git", repo });
			continue;
		}
		const changed = changedPaths(new Map(turn.baseline), current);
		if (!changed.length || isDocsOnly(changed)) {
			entries.push({ event, decision: "skip", rule: changed.length ? "docs-only" : "no-change", repo });
			continue;
		}
		const rounds = roundsFor(config);
		const shown = { ...config, maxRepairRounds: rounds };
		const key = snapshotKey(current);
		if (turn.lastFailedKey !== undefined && key === turn.lastFailedKey) {
			// The round changed nothing: for a red check that ends it, for findings it is the agent's answer.
			turn.done = true;
			const findings = turn.openFindings;
			handBacks.push(
				findings.length
					? unchangedFindingsMessage(findings)
					: `${GATE_MESSAGE_PREFIX} \`${config.command}\` is still red and the last repair round changed nothing; stopped. Handing back to the user.`,
			);
			entries.push({ event, decision: "final", rule: "unchanged", repo, gate: "red", round: used, findings: findings.length });
			continue;
		}

		let findings: Finding[] = [];
		if (config.tamperCheck && turn.baseTree) {
			try {
				const tree = snapshotTree(repo);
				if (tree) findings = tamperFindings(repo, turn.baseTree, tree, config.tamperPatterns);
			} catch {
				entries.push({ event, decision: "error", rule: "tamper-check-failed", repo });
			}
		}
		const result = run(config.command, repo, timeoutFor(config));
		const counts = { findings: findings.length, code: result.code, seconds: result.seconds };
		if (result.ok && !findings.length) {
			turn.done = true;
			entries.push({ event, decision: "green", repo, gate: "green", round: used, ...counts });
			continue;
		}
		turn.lastFailedKey = key;
		turn.openFindings = findings;
		if (!isEnvironmentProblem(result) && used < rounds) {
			repairs.push(repairMessage(shown, result, findings, used + 1));
			entries.push({ event, decision: "repair", repo, gate: "red", round: used + 1, ...counts });
		} else {
			turn.done = true;
			handBacks.push(handBackMessage(shown, result, findings, handBackReason(result, used)));
			entries.push({ event, decision: "final", rule: isEnvironmentProblem(result) ? "environment" : "rounds-used", repo, gate: "red", round: used, ...counts });
		}
	}
	if (repairs.length) state.rounds = used + 1;
	writeTurn(file, state);
	const messages = [...repairs, ...handBacks];
	if (!messages.length) return { answer: {}, entries };
	if (handBacks.length) messages.push(repairs.length ? MIXED_INSTRUCTION : REPORT_INSTRUCTION);
	return { answer: { followup_message: messages.join("\n\n") }, entries };
}
