/**
 * Where the Cursor adapter keeps its files, and what every hook call gets to work with. Paths below
 * the home directory are built here at run time; the repository holds none.
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This checkout: cursor/lib/ lies two levels below it. */
export const NEST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** `~/.config/pecker-nest`: the recorded Node path and the trust list. */
export const configDir = (home: string) => join(home, ".config", "pecker-nest");
/** `~/.local/state/pecker-nest/cursor`: the decision log and the turn snapshots. */
export const stateDir = (home: string) => join(home, ".local", "state", "pecker-nest", "cursor");

export const TRUST_FILE = "cursor-trusted";
export const NODE_FILE = "cursor-node";
export const LOG_FILE = "log.jsonl";
export const TURNS_DIR = "turns";

/**
 * Values cursor/hooks.json sets for the stop hook. Cursor reads them from that file, not per
 * repository, so the gate fits a repository's `.pi/gate.json` into them; test/cursor-adapter.test.ts
 * checks that the file and these constants agree.
 */
export const STOP_LOOP_LIMIT = 5;
export const STOP_TIMEOUT_SECONDS = 900;
/** Time the stop hook keeps for the snapshot, the weakened-test check and the answer. */
export const STOP_RESERVE_SECONDS = 60;

export interface AdapterContext {
	home: string;
	/** This checkout, for the harness rules. */
	nestDir: string;
	env: NodeJS.ProcessEnv;
	now: () => Date;
	/** Compare paths without regard to case (lib/policy.ts: caseInsensitive); unset means on macOS. Tests set it. */
	caseInsensitive?: boolean;
}

export function defaultContext(): AdapterContext {
	return { home: homedir(), nestDir: NEST_DIR, env: process.env, now: () => new Date() };
}
