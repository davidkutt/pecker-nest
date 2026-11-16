/**
 * Capture hook for Cursor, Part 1 of docs/tasks/cursor-adapter.md. cursor/capture/hooks.json
 * registers it for every agent hook event; scripts/link.sh --cursor-capture installs that file as
 * ~/.cursor/hooks.json. Each call appends one line to ~/.local/state/pecker-nest/cursor/capture.jsonl
 * and lets the action through.
 *
 * A line holds the event, the payload's key names with value types and lengths, the ids that tie
 * events together, short enumerations (tool name, status, loop count, model) and, for path-like
 * fields, the path. It also records how Cursor started the hook: working directory, PATH, shell,
 * parent processes and which `node`, `npm` and `git` that PATH would find. It never records file
 * contents, prompts, commands, command output, URLs or the user's e-mail address: any other string
 * is reduced to its length.
 *
 * Answers: `{"permission":"allow"}` for permission hooks, `{"continue":true}` for
 * beforeSubmitPrompt, `{}` otherwise, also when the payload is not JSON or anything here fails.
 * One opt-in exception for questions C3 and C4: while
 * ~/.local/state/pecker-nest/cursor/capture-followups holds a number N, `stop` answers a harmless
 * follow-up message N times per conversation and then a `user_message`, so the log shows how Cursor
 * counts follow-up rounds and whether it shows that message.
 */

import { spawnSync } from "node:child_process";
import { accessSync, appendFileSync, constants, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the capture log and the follow-up switch live, below the home directory. */
export function captureDir(home: string = homedir()): string {
	return join(home, ".local", "state", "pecker-nest", "cursor");
}

export const LOG_FILE = "capture.jsonl";
export const FOLLOWUP_FILE = "capture-followups";

/** Hooks whose answer Cursor reads as a permission decision; anything but a valid answer blocks them. */
export const PERMISSION_HOOKS = new Set(["beforeShellExecution", "beforeMCPExecution", "preToolUse", "beforeReadFile", "beforeTabFileRead", "subagentStart"]);

/** Fields whose value ties events together: ids, never content. */
const ID_KEYS = new Set(["conversation_id", "generation_id", "session_id", "tool_use_id", "tool_call_id", "subagent_id", "parent_conversation_id"]);

/** Fields with short, fixed values worth reading in the log. */
const ENUM_KEYS = new Set([
	"hook_event_name",
	"tool_name",
	"status",
	"subagent_type",
	"subagent_model",
	"composer_mode",
	"reason",
	"final_status",
	"trigger",
	"failure_type",
	"cursor_version",
	"model",
	"model_id",
	"environment",
	"permission",
	"type",
]);

/** Path-like field names, after camelCase is turned into snake_case. */
const PATH_KEY = /(?:^|_)(?:path|paths|file|files|cwd|dir|dirs|directory|directories|folder|folders|root|roots|glob|globs|include|includes|exclude|excludes)$|^(?:working_directory|target_file|filepath)$/;

const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const MAX_ITEMS = 5;
const MAX_PATHS = 50;

export type Shape =
	| { type: "string"; length: number; value?: string }
	| { type: "number"; value: number }
	| { type: "boolean"; value: boolean }
	| { type: "null" }
	| { type: "array"; length: number; value?: string[]; items?: Shape[] }
	| { type: "object"; keys: Record<string, Shape>; truncated?: true }
	| { type: "other" };

function snake(key: string): string {
	return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

export function isPathKey(key: string): boolean {
	return PATH_KEY.test(snake(key));
}

const oneLine = (text: string) => !/[\r\n]/.test(text);

function stringShape(value: string, key: string): Shape {
	const name = snake(key);
	const keep =
		oneLine(value) &&
		((ID_KEYS.has(name) && value.length <= 200) || (ENUM_KEYS.has(name) && value.length <= 100) || (isPathKey(name) && value.length <= 4096));
	return keep ? { type: "string", length: value.length, value } : { type: "string", length: value.length };
}

/**
 * The shape of a payload value: types and lengths everywhere, values only for ids, enumerations,
 * numbers, booleans and path-like fields. `key` is the name of the field that holds the value.
 */
export function shapeOf(value: unknown, key = "", depth = 0): Shape {
	if (value === null) return { type: "null" };
	if (typeof value === "string") return stringShape(value, key);
	if (typeof value === "number") return { type: "number", value };
	if (typeof value === "boolean") return { type: "boolean", value };
	if (Array.isArray(value)) {
		const paths = isPathKey(key) && value.every((item) => typeof item === "string" && oneLine(item) && item.length <= 4096);
		if (paths && value.length) return { type: "array", length: value.length, value: (value as string[]).slice(0, MAX_PATHS) };
		if (!value.length || depth >= MAX_DEPTH) return { type: "array", length: value.length };
		return { type: "array", length: value.length, items: value.slice(0, MAX_ITEMS).map((item) => shapeOf(item, key, depth + 1)) };
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (depth >= MAX_DEPTH) return { type: "object", keys: {}, truncated: true };
		const keys: Record<string, Shape> = {};
		for (const [name, inner] of entries.slice(0, MAX_KEYS)) keys[name] = shapeOf(inner, name, depth + 1);
		return entries.length > MAX_KEYS ? { type: "object", keys, truncated: true } : { type: "object", keys };
	}
	return { type: "other" };
}

/** How Cursor started this process. Paths and names only; no variable that could hold a secret. */
export interface EnvironmentFacts {
	cwd: string;
	PATH: string | null;
	SHELL: string | null;
	HOME: string | null;
	node: string;
	nodeVersion: string;
	/** The first executable of each name on PATH, as a shell's `command -v` would find it. */
	onPath: Record<string, string | null>;
	/** Up to three ancestors, nearest first: what spawned the hook. */
	parents: { pid: number; command: string }[];
	/** Names (not values) of the variables Cursor and VS Code set. */
	cursorVariables: string[];
	/** Values of the documented variables that hold paths, versions or flags. */
	values: Record<string, string>;
}

const VALUE_VARIABLES = [
	"CURSOR_PROJECT_DIR",
	"CLAUDE_PROJECT_DIR",
	"CURSOR_VERSION",
	"CURSOR_TRANSCRIPT_PATH",
	"CURSOR_CODE_REMOTE",
	"CURSOR_PLUGIN_ROOT",
	"CURSOR_SANDBOX",
	"CURSOR_AGENT",
];
const TOOLS = ["node", "npm", "npx", "pnpm", "uv", "git", "bash", "zsh", "fish"];

function onPath(name: string, path: string): string | null {
	for (const dir of path.split(":")) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// not here
		}
	}
	return null;
}

function parents(): { pid: number; command: string }[] {
	const chain: { pid: number; command: string }[] = [];
	let pid = process.ppid;
	for (let step = 0; step < 3 && pid > 1; step++) {
		const result = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf-8", timeout: 2000 });
		const match = /^\s*(\d+)\s+(.*)$/.exec(result.stdout?.trim() ?? "");
		if (!match) break;
		chain.push({ pid, command: match[2].trim() });
		pid = Number(match[1]);
	}
	return chain;
}

export function environmentFacts(env: NodeJS.ProcessEnv = process.env, ancestors: () => { pid: number; command: string }[] = parents): EnvironmentFacts {
	const path = env.PATH ?? "";
	const values: Record<string, string> = {};
	for (const name of VALUE_VARIABLES) if (env[name] !== undefined) values[name] = String(env[name]);
	return {
		cwd: process.cwd(),
		PATH: env.PATH ?? null,
		SHELL: env.SHELL ?? null,
		HOME: env.HOME ?? null,
		node: process.execPath,
		nodeVersion: process.version,
		onPath: Object.fromEntries(TOOLS.map((tool) => [tool, onPath(tool, path)])),
		parents: ancestors(),
		cursorVariables: Object.keys(env)
			.filter((name) => /^(?:CURSOR|CLAUDE|VSCODE)_/.test(name))
			.sort(),
		values,
	};
}

export interface CaptureRecord {
	time: string;
	/** The event hooks.json registered this command for. */
	hook: string;
	/** `hook_event_name` from the payload, when it differs or the payload says so. */
	event?: string;
	bytes: number;
	payload?: Shape;
	parseError?: string;
	/** What this call answered: allow, continue, empty, followup or user_message. */
	answered: string;
	/** For a follow-up answer: which round of the test it was. */
	followup?: number;
	env?: EnvironmentFacts;
	error?: string;
}

/** The answer that lets the action through, by event. */
export function allowAnswer(hook: string): Record<string, unknown> {
	if (PERMISSION_HOOKS.has(hook)) return { permission: "allow" };
	if (hook === "beforeSubmitPrompt") return { continue: true };
	return {};
}

function answerKind(answer: Record<string, unknown>): string {
	if (answer.permission === "allow") return "allow";
	if (answer.continue === true) return "continue";
	if (typeof answer.followup_message === "string") return "followup";
	if (typeof answer.user_message === "string") return "user_message";
	return "empty";
}

/** The follow-up test count from the switch file: 1 to 10, or undefined when off or invalid. */
export function followupRounds(text: string | undefined): number | undefined {
	if (text === undefined) return undefined;
	const rounds = Number(text.trim());
	return Number.isInteger(rounds) && rounds >= 1 && rounds <= 10 ? rounds : undefined;
}

/** The answer to `stop` while the follow-up test is on. */
export function stopTestAnswer(payload: Record<string, unknown>, rounds: number): { answer: Record<string, unknown>; round?: number } {
	if (payload.status !== "completed" || typeof payload.loop_count !== "number") return { answer: {} };
	const done = payload.loop_count;
	if (done < rounds) {
		return {
			answer: { followup_message: `pecker-nest capture test: follow-up ${done + 1} of ${rounds}. Reply with the single word ok and do nothing else.` },
			round: done + 1,
		};
	}
	return { answer: { user_message: `pecker-nest capture test: no further follow-up (loop_count ${done}). Note whether you can see this line in Cursor.` } };
}

export interface CaptureOptions {
	now?: Date;
	env?: EnvironmentFacts;
	/** Content of the follow-up switch file, undefined when it does not exist. */
	followups?: string;
}

/** The log line and the answer for one hook call. Pure apart from the inputs it is given. */
export function capture(hook: string, raw: string, options: CaptureOptions = {}): { record: CaptureRecord; answer: Record<string, unknown> } {
	const text = raw.replace(/^﻿/, "");
	let payload: Record<string, unknown> | undefined;
	let shape: Shape | undefined;
	let parseError: string | undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		shape = shapeOf(parsed);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
		else parseError = `payload is ${Array.isArray(parsed) ? "an array" : typeof parsed}, not an object`;
	} catch (error) {
		parseError = error instanceof SyntaxError ? "not valid JSON" : String(error).slice(0, 200);
	}

	let answer = allowAnswer(hook);
	let followup: number | undefined;
	const rounds = followupRounds(options.followups);
	if (hook === "stop" && payload && rounds !== undefined) {
		const test = stopTestAnswer(payload, rounds);
		answer = test.answer;
		followup = test.round;
	}

	const record: CaptureRecord = {
		time: (options.now ?? new Date()).toISOString(),
		hook,
		...(payload && typeof payload.hook_event_name === "string" ? { event: payload.hook_event_name } : {}),
		bytes: Buffer.byteLength(text),
		answered: answerKind(answer),
		...(followup !== undefined ? { followup } : {}),
		...(parseError ? { parseError } : {}),
		...(shape ? { payload: shape } : {}),
		...(options.env ? { env: options.env } : {}),
	};
	return { record, answer };
}

function readOptional(path: string): string | undefined {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

function main(): void {
	const hook = process.argv[2] ?? "unknown";
	let answer = allowAnswer(hook);
	const dir = captureDir();
	try {
		let raw = "";
		try {
			raw = readFileSync(0, "utf-8");
		} catch {
			// no stdin: logged as an empty payload
		}
		const result = capture(hook, raw, { env: environmentFacts(), followups: readOptional(join(dir, FOLLOWUP_FILE)) });
		answer = result.answer;
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, LOG_FILE), `${JSON.stringify(result.record)}\n`);
	} catch (error) {
		try {
			mkdirSync(dir, { recursive: true });
			const line = { time: new Date().toISOString(), hook, answered: "allow", error: (error instanceof Error ? error.message : String(error)).slice(0, 200) };
			appendFileSync(join(dir, LOG_FILE), `${JSON.stringify(line)}\n`);
		} catch {
			// the answer below still lets the action through
		}
	}
	process.stdout.write(`${JSON.stringify(answer)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
