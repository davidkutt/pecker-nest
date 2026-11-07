/**
 * Safety gate: blocks destructive shell commands and writes to protected paths before
 * they run. Pi itself asks before no tool call, so this is the only stop.
 *
 * - bash: rm -rf, git push, git reset --hard, git clean -f, curl … | sh, and writes to
 *   .env*, .git/, .pi/, keys and other credential files (see lib/safety-rules.ts).
 * - edit/write: the same protected paths, plus the harness itself: this package and Pi's
 *   agent directory. The agent never edits its own gates, settings or protection rules.
 * - /plan runs: edit/write may only touch PLAN.md.
 * - `.pi/protect.json` adds repository rules (lib/protect-config.ts): paths the agent must not
 *   write, paths it must not read either, and commands it must not run. Lines that mention a
 *   read-protected file are removed from grep, find, ls and bash output. An invalid file blocks
 *   every write and command until it is fixed.
 *
 * Blocks are final in every mode; the user can still run a command with `!cmd`.
 * Loaded in the main session and, through subagents.defaultSubagentOnlyExtensions, in
 * every subagent child.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existingMatches, loadProtectConfig, PROTECT_CONFIG_PATH } from "./lib/protect-config.ts";
import {
	bashCommandReason,
	isPlanCommand,
	type PathPolicy,
	planModeReason,
	protectedPathReason,
	protectedReadReason,
	redactProtectedLines,
} from "./lib/safety-rules.ts";

/** The path with symlinks resolved, also for files that do not exist yet. */
function canonical(path: string): string {
	let current = resolve(path);
	const rest: string[] = [];
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return resolve(path);
		rest.unshift(basename(current));
		current = parent;
	}
	try {
		return join(realpathSync(current), ...rest);
	} catch {
		return resolve(path);
	}
}

const HARNESS_DIRS = [
	canonical(resolve(dirname(fileURLToPath(import.meta.url)), "..")),
	canonical(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")),
];

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILTERED_TOOLS = new Set(["grep", "find", "ls", "bash"]);
const READ_FILES_TTL_MS = 5_000;

export default function (pi: ExtensionAPI) {
	let planMode = false;
	let warnedConfig: string | undefined;
	let readFilesCache: { cwd: string; at: number; files: string[] } | undefined;

	function block(ctx: ExtensionContext, toolName: string, reason: string) {
		if (ctx.hasUI) ctx.ui.notify(`safety-gate blocked ${toolName}: ${reason}`, "warning");
		return {
			block: true,
			reason: `Blocked by safety-gate: ${reason}. Do not try to work around this block. Tell the user what you wanted to do and why; they can run it themselves with !<command>.`,
		};
	}

	/** The policy for this call, or an error message when `.pi/protect.json` is invalid. */
	function policyFor(ctx: ExtensionContext): { policy: PathPolicy } | { error: string } {
		let config;
		try {
			config = loadProtectConfig(ctx.cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (warnedConfig !== message) {
				warnedConfig = message;
				if (ctx.hasUI) ctx.ui.notify(`safety-gate: ${message}; every write and command is blocked until it is fixed`, "error");
				else process.stderr.write(`[safety-gate] ${message}; every write and command is blocked until it is fixed\n`);
			}
			return { error: message };
		}
		const read = config?.read ?? [];
		let readFiles: string[] = [];
		if (read.length) {
			const now = Date.now();
			if (!readFilesCache || readFilesCache.cwd !== ctx.cwd || now - readFilesCache.at > READ_FILES_TTL_MS) {
				readFilesCache = { cwd: ctx.cwd, at: now, files: existingMatches(ctx.cwd, read) };
			}
			readFiles = readFilesCache.files;
		}
		return {
			policy: {
				cwd: ctx.cwd,
				write: config?.write ?? [],
				read,
				readFiles,
				commands: config?.commands ?? [],
				harnessDirs: HARNESS_DIRS,
				canonical,
			},
		};
	}

	pi.on("input", (event) => {
		// Steering and follow-up messages join the running run and keep its mode.
		if (event.source === "extension" || event.streamingBehavior) return undefined;
		planMode = isPlanCommand(event.text);
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		const name = event.toolName;
		if (name !== "bash" && name !== "edit" && name !== "write" && !READ_TOOLS.has(name)) return undefined;
		const resolved = policyFor(ctx);
		if ("error" in resolved) {
			return READ_TOOLS.has(name) ? undefined : block(ctx, name, `fix ${PROTECT_CONFIG_PATH} first (${resolved.error})`);
		}
		const { policy } = resolved;
		const input = event.input as { command?: unknown; path?: unknown };
		let reason: string | undefined;
		if (name === "bash") {
			reason = bashCommandReason(String(input.command ?? ""), policy);
		} else if (name === "edit" || name === "write") {
			const path = String(input.path ?? "");
			reason = protectedPathReason(path, policy) ?? (planMode ? planModeReason(path, ctx.cwd) : undefined);
		} else if (typeof input.path === "string" && input.path) {
			reason = protectedReadReason(input.path, policy);
		}
		return reason ? block(ctx, name, reason) : undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (!FILTERED_TOOLS.has(event.toolName)) return undefined;
		const resolved = policyFor(ctx);
		if ("error" in resolved || !resolved.policy.readFiles?.length) return undefined;
		const files = resolved.policy.readFiles;
		let removed = 0;
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			const redacted = redactProtectedLines(part.text, files);
			removed += redacted.removed;
			return { ...part, text: redacted.text };
		});
		if (!removed) return undefined;
		content.push({ type: "text", text: `[safety-gate] removed ${removed} line(s) that mention files protected by ${PROTECT_CONFIG_PATH}.` });
		return { content };
	});
}
