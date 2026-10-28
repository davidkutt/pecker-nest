/**
 * Quality gate: when a run changed code, run the repository's single check command from
 * `.pi/gate.json` before the run settles. A red check goes back to the agent for at most
 * `maxRepairRounds` rounds (default 2); after that, or when a round changes nothing, the
 * gate stops and tells the user.
 *
 * Changes are detected from git (so edits made through bash or subagents count) plus
 * edit/write tool calls. Changes to documentation alone (PLAN.md, *.md) never run it.
 * The gate runs only in trusted projects, because `.pi/gate.json` is a command from the repo.
 *
 * `/gate` runs the check now, `/gate off` and `/gate on` toggle it for this session, and
 * PI_NEST_GATE=off disables it for a process (for comparing other gate packages).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GATE_CONFIG_PATH, type GateConfig, isDocsOnly, loadGateConfig, outputTail } from "./lib/gate-config.ts";
import { changedPaths, snapshotKey, takeSnapshot, type WorktreeSnapshot } from "./lib/worktree.ts";

const CUSTOM_TYPE = "quality-gate";

interface CheckResult {
	ok: boolean;
	code: number;
	timedOut: boolean;
	output: string;
	seconds: number;
}

export default function (pi: ExtensionAPI) {
	let enabled = process.env.PI_NEST_GATE !== "off";
	let baseline: WorktreeSnapshot | undefined;
	let touched = new Set<string>();
	let rounds = 0;
	let lastFailedKey: string | undefined;
	let warnedUntrusted = false;

	function tell(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") {
		if (ctx.hasUI) ctx.ui.notify(message, level);
		else process.stderr.write(`[quality-gate] ${message}\n`);
	}

	async function runCheck(config: GateConfig, ctx: ExtensionContext): Promise<CheckResult> {
		if (ctx.hasUI) ctx.ui.setStatus(CUSTOM_TYPE, `gate: ${config.command}`);
		const started = Date.now();
		try {
			const result = await pi.exec("bash", ["-c", config.command], {
				cwd: ctx.cwd,
				timeout: config.timeoutSeconds > 0 ? config.timeoutSeconds * 1000 : undefined,
			});
			const output = [result.stdout, result.stderr].filter((part) => part.trim()).join("\n");
			return {
				ok: result.code === 0 && !result.killed,
				code: result.code,
				timedOut: result.killed,
				output,
				seconds: Math.round((Date.now() - started) / 1000),
			};
		} finally {
			if (ctx.hasUI) ctx.ui.setStatus(CUSTOM_TYPE, undefined);
		}
	}

	function describeFailure(config: GateConfig, result: CheckResult): string {
		const why = result.timedOut ? `timed out after ${config.timeoutSeconds}s` : `failed with exit code ${result.code}`;
		return `\`${config.command}\` ${why}`;
	}

	function resultEntry(config: GateConfig, result: CheckResult) {
		return {
			type: "custom" as const,
			customType: CUSTOM_TYPE,
			data: { command: config.command, ok: result.ok, code: result.code, timedOut: result.timedOut, seconds: result.seconds, rounds },
		};
	}

	pi.on("before_agent_start", (event, ctx) => {
		// Runs started by extension messages (for example a finished background subagent)
		// keep the baseline of the user's prompt, so their changes are checked too.
		if (event.messageType !== "user" && baseline) return undefined;
		baseline = takeSnapshot(ctx.cwd);
		touched = new Set();
		rounds = 0;
		lastFailedKey = undefined;
		return undefined;
	});

	pi.on("tool_result", (event) => {
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			touched.add(String(event.input.path ?? ""));
		}
		return undefined;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!enabled || event.outcome !== "completed") return undefined;

		let config: GateConfig | undefined;
		try {
			config = loadGateConfig(ctx.cwd);
		} catch (error) {
			tell(ctx, error instanceof Error ? error.message : String(error), "error");
			return undefined;
		}
		if (!config) return undefined;
		if (!ctx.isProjectTrusted()) {
			if (!warnedUntrusted) tell(ctx, `${GATE_CONFIG_PATH} ignored: this project is not trusted (run /trust).`, "warning");
			warnedUntrusted = true;
			return undefined;
		}

		const current = takeSnapshot(ctx.cwd);
		const changed = new Set(touched);
		if (baseline && current) for (const path of changedPaths(baseline, current)) changed.add(path);
		if (changed.size === 0 || isDocsOnly(changed)) return undefined;

		const key = current ? snapshotKey(current) : undefined;
		if (key !== undefined && key === lastFailedKey) {
			tell(ctx, `Gate still red and the last repair round changed nothing; stopped. Run /gate to see the output.`, "error");
			baseline = current;
			touched = new Set();
			return undefined;
		}

		const result = await runCheck(config, ctx);
		if (result.ok) {
			if (rounds > 0) tell(ctx, `Gate green after ${rounds} repair round(s): ${config.command}`, "info");
			baseline = current;
			touched = new Set();
			lastFailedKey = undefined;
			return { entries: [resultEntry(config, result)] };
		}

		lastFailedKey = key;
		const failure = describeFailure(config, result);
		const output = outputTail(result.output) || "(no output)";

		// Exit code 127: the check command itself is missing. The agent cannot fix that.
		const environmentProblem = result.code === 127;
		if (!environmentProblem && rounds < config.maxRepairRounds) {
			rounds++;
			return {
				entries: [
					resultEntry(config, result),
					{
						type: "custom_message" as const,
						customType: CUSTOM_TYPE,
						display: true,
						content: [
							`[quality-gate] ${failure}. Repair round ${rounds} of ${config.maxRepairRounds}.`,
							"Fix the cause of the failures below. Do not delete, skip or weaken tests and do not loosen lint or type settings. If a failure is unrelated to your task or cannot be fixed in code, say so and stop.",
							"When the check passes, end with a complete summary of the task.",
							"",
							"```",
							output,
							"```",
						].join("\n"),
					},
				],
				continue: true,
			};
		}

		const stopReason = environmentProblem
			? "the check command was not found (exit 127); fix the environment"
			: `still red after ${rounds} repair round(s)`;
		tell(ctx, `Gate ${stopReason}: ${failure}.`, "error");
		baseline = current;
		touched = new Set();
		return {
			entries: [
				resultEntry(config, result),
				{
					type: "custom_message" as const,
					customType: CUSTOM_TYPE,
					display: true,
					content: [`[quality-gate] ${failure}; ${stopReason}. Handing back to the user.`, "", "```", output, "```"].join("\n"),
				},
			],
		};
	});

	pi.registerCommand("gate", {
		description: "Run the quality gate now, or turn it off/on for this session: /gate [off|on]",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "off" || arg === "on") {
				enabled = arg === "on";
				ctx.ui.notify(`Quality gate ${enabled ? "on" : "off"} for this session.`, "info");
				return;
			}
			let config: GateConfig | undefined;
			try {
				config = loadGateConfig(ctx.cwd);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (!config) {
				ctx.ui.notify(`No ${GATE_CONFIG_PATH} in ${ctx.cwd}.`, "warning");
				return;
			}
			const result = await runCheck(config, ctx);
			const headline = result.ok
				? `\`${config.command}\` passed in ${result.seconds}s.`
				: `${describeFailure(config, result)} after ${result.seconds}s.`;
			pi.sendMessage({
				customType: CUSTOM_TYPE,
				display: true,
				content: [`[quality-gate] ${headline}`, "", "```", outputTail(result.output) || "(no output)", "```"].join("\n"),
			});
		},
	});
}
