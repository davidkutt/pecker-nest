/**
 * Safety gate: blocks destructive shell commands and writes to protected paths before
 * they run. Pi itself asks before no tool call, so this is the only stop.
 *
 * - bash: rm -rf, git push, git reset --hard, git clean -f, curl … | sh, and writes to
 *   .env*, .git/, keys and other credential files (see lib/safety-rules.ts).
 * - edit/write: the same protected paths.
 * - /plan runs: edit/write may only touch PLAN.md.
 *
 * Blocks are final in every mode; the user can still run a command with `!cmd`.
 * Loaded in the main session and, through subagents.defaultSubagentOnlyExtensions, in
 * every subagent child.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bashCommandReason, isPlanCommand, planModeReason, protectedPathReason } from "./lib/safety-rules.ts";

export default function (pi: ExtensionAPI) {
	let planMode = false;

	pi.on("input", (event) => {
		// Steering and follow-up messages join the running run and keep its mode.
		if (event.source === "extension" || event.streamingBehavior) return undefined;
		planMode = isPlanCommand(event.text);
		return undefined;
	});

	pi.on("tool_call", (event, ctx) => {
		let reason: string | undefined;
		if (event.toolName === "bash") {
			reason = bashCommandReason(String(event.input.command ?? ""));
		} else if (event.toolName === "edit" || event.toolName === "write") {
			const path = String(event.input.path ?? "");
			reason = protectedPathReason(path) ?? (planMode ? planModeReason(path, ctx.cwd) : undefined);
		}
		if (!reason) return undefined;

		if (ctx.hasUI) ctx.ui.notify(`safety-gate blocked ${event.toolName}: ${reason}`, "warning");
		return {
			block: true,
			reason: `Blocked by safety-gate: ${reason}. Do not try to work around this block. Tell the user what you wanted to do and why; they can run it themselves with !<command>.`,
		};
	});
}
