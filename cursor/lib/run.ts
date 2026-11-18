/**
 * What every entry script in cursor/hooks/ does: read the payload from stdin, decide, append the
 * log, print the answer. A permission hook that cannot read its payload or fails answers deny, so
 * it blocks even where Cursor would let a failed hook through; the prompt and stop hooks answer
 * their neutral value instead and never block.
 */

import { readFileSync } from "node:fs";
import { type AdapterContext, defaultContext } from "./context.ts";
import { appendLog, type LogEntry } from "./log.ts";
import { type Payload, parsePayload } from "./payload.ts";
import { denyAnswer, type HookResult } from "./permission.ts";

export type HookKind = "permission" | "permission-tab" | "prompt" | "stop";

/** The answer that changes nothing, for a hook that does not fail closed. */
export function neutralAnswer(kind: HookKind): Record<string, unknown> {
	if (kind === "prompt") return { continue: true };
	if (kind === "permission-tab") return { permission: "allow" };
	return {};
}

/** The answer when the hook cannot decide: deny for the permission hooks, neutral otherwise. */
export function failureAnswer(kind: HookKind, reason: string): Record<string, unknown> {
	if (kind === "permission") return denyAnswer(`the pecker-nest hook could not check this (${reason})`, true);
	return neutralAnswer(kind);
}

/** One hook call from raw stdin to answer and log entries. Pure apart from what `decide` does. */
export function handle(kind: HookKind, event: string, raw: string, decide: (payload: Payload, context: AdapterContext) => HookResult, context: AdapterContext): HookResult {
	const parsed = parsePayload(raw);
	if ("error" in parsed) {
		return { answer: failureAnswer(kind, parsed.error), entries: [{ event, decision: kind === "permission" ? "deny" : "error", rule: "malformed" }] };
	}
	try {
		return decide(parsed.payload, context);
	} catch (error) {
		// The message may name a file or carry git's stderr: it goes into the answer, not the log.
		const message = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
		const entry: LogEntry = { event, decision: kind === "permission" ? "deny" : "error", rule: `hook-error:${error instanceof Error ? error.name : "unknown"}` };
		return { answer: failureAnswer(kind, message), entries: [entry] };
	}
}

/** The body of an entry script. */
export function runHook(kind: HookKind, event: string, decide: (payload: Payload, context: AdapterContext) => HookResult): void {
	const context = defaultContext();
	let raw = "";
	try {
		raw = readFileSync(0, "utf-8");
	} catch {
		// no stdin: handled as a malformed payload
	}
	const { answer, entries } = handle(kind, event, raw, decide, context);
	appendLog(context.home, entries, context.now());
	process.stdout.write(`${JSON.stringify(answer)}\n`);
}
