/**
 * The three permission hooks: commands (beforeShellExecution and the Shell tool), writes and
 * deletes (preToolUse), reads (preToolUse on Read and Grep, beforeReadFile, beforeTabFileRead).
 * Each turns a Cursor payload into a call of extensions/lib/ and the answer back into Cursor's
 * format. A payload the hook cannot read is blocked: these hooks fail closed.
 *
 * Cursor hands the agent `user_message`, not `agent_message`, on a deny (C2), so both carry the
 * whole reason. `git push` is denied like everything else nest blocks: under Auto-review an `ask`
 * from a hook can run without asking (X1), and the hook cannot see the run mode.
 */

import { harnessScriptReason } from "../../extensions/lib/harness.ts";
import { PROTECT_CONFIG_PATH } from "../../extensions/lib/protect-config.ts";
import { bashCommandReason, protectedPathReason, protectedReadReason, searchReadReason } from "../../extensions/lib/safety-rules.ts";
import type { AdapterContext } from "./context.ts";
import { type LogEntry, ruleOf } from "./log.ts";
import { absolute, inputPath, type Payload, text, toolInput, workspaceRoots, writePaths } from "./payload.ts";
import { policyFor, repositoryFor } from "./policy.ts";

export interface HookResult {
	answer: Record<string, unknown>;
	entries: LogEntry[];
	/** Repositories an allowed write or command is about to change, for the gate (lib/gate.ts: joinTurn). */
	touched?: string[];
}

/** One check's outcome: a reason means deny. */
interface Verdict {
	reason?: string;
	rule: string;
	repo?: string;
	path?: string;
}

/** Tools the preToolUse hook checks; cursor/hooks.json uses the same list as its matcher. */
export const SHELL_TOOLS = ["Shell"];
export const READ_TOOLS = ["Read"];
export const SEARCH_TOOLS = ["Grep"];
/** Write is what the capture showed for new files and edits; the rest are names other models use. */
export const WRITE_TOOLS = ["Write", "Delete", "StrReplace", "Edit", "MultiEdit", "ApplyPatch"];
export const PRE_TOOL_USE_MATCHER = [...SHELL_TOOLS, ...READ_TOOLS, ...SEARCH_TOOLS, ...WRITE_TOOLS].join("|");

export const ALLOW = { permission: "allow" } as const;

/** The block text the agent and David see: nest's wording, without Pi's `!<command>`. */
export function blockText(reason: string): string {
	return `Blocked by pecker-nest: ${reason}. Do not try to work around this block. Tell the user what you wanted to do and why; they can do it themselves.`;
}

export function denyAnswer(reason: string, withAgentMessage = true): Record<string, unknown> {
	const message = blockText(reason);
	return withAgentMessage ? { permission: "deny", user_message: message, agent_message: message } : { permission: "deny", user_message: message };
}

const allowed = (rule = "allowed", repo?: string, path?: string): Verdict => ({ rule, repo, path });

/** A shell command against the rules of every workspace root: a command can reach any of them. */
export function shellVerdict(command: string, roots: readonly string[], context: AdapterContext): Verdict {
	if (!command.trim()) return allowed("empty");
	const script = harnessScriptReason(command, { nestDir: context.nestDir, cwd: roots[0] ?? context.home, home: context.home });
	if (script) return { reason: script, rule: ruleOf(script) };
	for (const root of roots.length ? roots : [undefined]) {
		const resolved = policyFor(root, context);
		if ("error" in resolved) return { reason: `fix ${PROTECT_CONFIG_PATH} first (${resolved.error})`, rule: "protect-invalid", repo: resolved.repo };
		const reason = bashCommandReason(command, resolved.policy);
		if (reason) return { reason, rule: ruleOf(reason), repo: resolved.repo };
	}
	return allowed("allowed", roots[0]);
}

/** A write or delete of one path, against the rules of the repository it lies in. */
export function writeVerdict(path: string, roots: readonly string[], context: AdapterContext): Verdict {
	const target = absolute(path, roots[0] ?? context.home, context.home);
	const resolved = policyFor(repositoryFor(target, roots), context);
	if ("error" in resolved) return { reason: `fix ${PROTECT_CONFIG_PATH} first (${resolved.error})`, rule: "protect-invalid", repo: resolved.repo, path: target };
	const reason = protectedPathReason(target, resolved.policy);
	return reason ? { reason, rule: ruleOf(reason), repo: resolved.repo, path: target } : allowed("allowed", resolved.repo, target);
}

/**
 * A read of one path. As in nest, an invalid `.pi/protect.json` blocks writes and commands but
 * not reads.
 */
export function readVerdict(path: string, roots: readonly string[], context: AdapterContext): Verdict {
	const target = absolute(path, roots[0] ?? context.home, context.home);
	const resolved = policyFor(repositoryFor(target, roots), context);
	if ("error" in resolved) return allowed("protect-invalid", resolved.repo, target);
	const reason = protectedReadReason(target, resolved.policy);
	return reason ? { reason, rule: ruleOf(reason), repo: resolved.repo, path: target } : allowed("allowed", resolved.repo, target);
}

/**
 * A search under `root` with an include glob and a search `pattern`. Cursor cannot remove matching
 * lines from Grep's output (X3), so a search that can reach a read-protected file is blocked as a
 * whole; every workspace root whose files the search covers is asked.
 *
 * Without `file_path`, Cursor's Grep is a file search (empty pattern, file names only) in every
 * capture case, and it can reach folders that `workspace_roots` does not show: in the multi-root
 * step it found a file in the second folder while the hooks saw only the first (C7, X12). So a
 * search without a path is checked against the roots the hook can see, and a content search without
 * a path, whose reach the hook cannot tell, is blocked with the request to name the folder.
 */
export function searchVerdict(root: string | undefined, glob: string | undefined, roots: readonly string[], context: AdapterContext, pattern = ""): Verdict {
	if (!root) {
		if (pattern) return { reason: SEARCH_WITHOUT_PATH, rule: "search-without-path" };
		for (const repo of roots) {
			const resolved = policyFor(repo, context);
			if ("error" in resolved) continue;
			const reason = searchReadReason(undefined, glob, resolved.policy);
			if (reason) return { reason, rule: ruleOf(reason), repo, path: repo };
		}
		return allowed(roots.length ? "allowed" : "no-root", roots[0]);
	}
	const start = absolute(root, roots[0] ?? context.home, context.home);
	const repos = new Set<string>(roots);
	const own = repositoryFor(start, roots);
	if (own) repos.add(own);
	for (const repo of repos) {
		const resolved = policyFor(repo, context);
		if ("error" in resolved) continue;
		const reason = searchReadReason(start, glob, resolved.policy);
		if (reason) return { reason, rule: ruleOf(reason), repo, path: start };
	}
	return allowed("allowed", own, start);
}

export const SEARCH_WITHOUT_PATH =
	"a content search without a path can cover folders the hook cannot see; give the folder to search as file_path (the workspace root for all of it)";

function result(event: string, verdict: Verdict, tool?: string, withAgentMessage = true, touched: (string | undefined)[] = []): HookResult {
	const repos = verdict.reason ? [] : [...new Set(touched.filter((repo): repo is string => Boolean(repo)))];
	const entry: LogEntry = {
		event,
		decision: verdict.reason ? "deny" : "allow",
		rule: verdict.rule,
		...(tool ? { tool } : {}),
		...(verdict.repo ? { repo: verdict.repo } : {}),
		...(verdict.path ? { path: verdict.path } : {}),
	};
	return { answer: verdict.reason ? denyAnswer(verdict.reason, withAgentMessage) : { ...ALLOW }, entries: [entry], ...(repos.length ? { touched: repos } : {}) };
}

/** The repository a command runs in, when the payload names its `cwd`; with `cwd: ""` it is a workspace root. */
function commandRepository(cwd: string | undefined, roots: readonly string[], context: AdapterContext): string[] {
	return cwd ? [repositoryFor(absolute(cwd, roots[0] ?? context.home, context.home), roots) ?? ""] : [];
}

/** beforeShellExecution: `command`, `cwd` (often empty), `sandbox`. */
export function beforeShellExecution(payload: Payload, context: AdapterContext): HookResult {
	const command = payload.command;
	if (typeof command !== "string") return result("beforeShellExecution", { reason: "the hook payload has no command", rule: "malformed" });
	const roots = workspaceRoots(payload, context.env);
	return result("beforeShellExecution", shellVerdict(command, roots, context), undefined, true, commandRepository(text(payload.cwd)?.trim(), roots, context));
}

/** preToolUse for Shell, Read, Grep and the write tools; other tools pass. */
export function preToolUse(payload: Payload, context: AdapterContext): HookResult {
	const tool = text(payload.tool_name) ?? "";
	const input = toolInput(payload);
	const event = "preToolUse";
	if (SHELL_TOOLS.includes(tool)) {
		const command = input.command;
		if (typeof command !== "string") return result(event, { reason: `the ${tool} input has no command`, rule: "malformed" }, tool);
		const cwd = text(input.cwd) ?? text(input.working_directory) ?? text(payload.cwd);
		const roots = workspaceRoots(payload, context.env, [cwd]);
		return result(event, shellVerdict(command, roots, context), tool, true, commandRepository(cwd?.trim(), roots, context));
	}
	const roots = workspaceRoots(payload, context.env);
	if (READ_TOOLS.includes(tool)) {
		const path = inputPath(input);
		if (!path) return result(event, { reason: `the ${tool} input names no file`, rule: "malformed" }, tool);
		return result(event, readVerdict(path, roots, context), tool);
	}
	if (SEARCH_TOOLS.includes(tool)) {
		const root = inputPath(input, ["file_path", "path", "target_directory", "directory"]);
		const pattern = typeof input.pattern === "string" ? input.pattern : "";
		return result(event, searchVerdict(root, text(input.glob) ?? text(input.include), roots, context, pattern), tool);
	}
	if (WRITE_TOOLS.includes(tool)) {
		const paths = writePaths(input);
		if (!paths.length) return result(event, { reason: `the ${tool} input names no file, so the hook cannot tell what it would change`, rule: "malformed" }, tool);
		const verdicts = paths.map((path) => writeVerdict(path, roots, context));
		const touched = verdicts.map((verdict) => verdict.repo ?? (verdict.path ? repositoryFor(verdict.path, roots) : undefined));
		return result(event, verdicts.find((verdict) => verdict.reason) ?? verdicts[0], tool, true, touched);
	}
	return result(event, allowed("not-checked"), tool);
}

/**
 * beforeReadFile (`file_path`, `content`) and beforeTabFileRead. Their answer has no
 * `agent_message` field (C2). A Tab read without a path passes: Tab is not the agent, and the
 * Tab hook does not fail closed.
 */
export function beforeReadFile(payload: Payload, context: AdapterContext, event: "beforeReadFile" | "beforeTabFileRead" = "beforeReadFile"): HookResult {
	const path = text(payload.file_path);
	if (!path) {
		if (event === "beforeTabFileRead") return result(event, allowed("no-path"), undefined, false);
		return result(event, { reason: "the hook payload names no file", rule: "malformed" }, undefined, false);
	}
	return result(event, readVerdict(path, workspaceRoots(payload, context.env), context), undefined, false);
}
