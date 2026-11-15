/**
 * Quality gate: when a run changed code, run the repository's single check command from
 * `.pi/gate.json` before the run settles. A red check goes back to the agent for at most
 * `maxRepairRounds` rounds (default 2); after that, or when a round changes nothing, the
 * gate stops and tells the user.
 *
 * A green check is only worth something if the run did not weaken what it checks. So the gate
 * also reads the diff since your prompt (lib/tamper-check.ts): deleted test files, fewer test
 * cases, added skip or focus markers, added suppressions, changed lint, type or test
 * configuration. A finding counts like a red check: it goes back to the agent as a repair round
 * that names file and line and asks it to revert the change or to say why it is right. Findings
 * that remain are handed to you as a list. The gate never reverts anything itself, and it has no
 * way to stay silent about a finding. `"tamperCheck": false` in `.pi/gate.json` turns this off,
 * `"tamperPatterns"` adds the repository's own patterns.
 *
 * Changes are detected from git (so edits made through bash or subagents count) plus
 * edit/write tool calls. Changes to documentation alone (PLAN.md, *.md) never run it.
 * The gate runs only in trusted projects, because `.pi/gate.json` is a command from the repo.
 *
 * `/gate` runs the check now, `/gate off` and `/gate on` toggle it for this session, and
 * PI_NEST_GATE=off disables it for a process (for comparing other gate packages).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GATE_CONFIG_PATH, type GateConfig, isDocsOnly, loadGateConfig, outputExcerpt } from "./lib/gate-config.ts";
import { type Finding, formatFindings, snapshotTree, tamperFindings } from "./lib/tamper-check.ts";
import { changedPaths, snapshotKey, takeSnapshot, type WorktreeSnapshot } from "./lib/worktree.ts";

const CUSTOM_TYPE = "quality-gate";

interface CheckResult {
	ok: boolean;
	code: number;
	timedOut: boolean;
	output: string;
	seconds: number;
}

/** The weakened-test check of one gate run. `findings` is undefined when it did not run. */
interface TamperResult {
	findings?: Finding[];
	/** The working tree it looked at, which becomes the next baseline once the gate settles. */
	tree?: string;
}

const count = (findings: readonly Finding[]) => `${findings.length} finding${findings.length === 1 ? "" : "s"}`;

export default function (pi: ExtensionAPI) {
	let enabled = process.env.PI_NEST_GATE !== "off";
	let baseline: WorktreeSnapshot | undefined;
	let touched = new Set<string>();
	let rounds = 0;
	let lastFailedKey: string | undefined;
	let warnedUntrusted = false;
	/** The working tree at the prompt, as a git tree object: what the weakened-test check diffs against. */
	let baseTree: string | undefined;
	/** The findings of the last red run, in case the next round changes nothing. */
	let openFindings: Finding[] = [];
	let warnedNoDiff = false;

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

	/** The headline of a red gate: the failed check, the findings, or both. */
	function describeRed(config: GateConfig, result: CheckResult, findings: readonly Finding[]): string {
		if (!findings.length) return describeFailure(config, result);
		if (result.ok) return `\`${config.command}\` passed, but the weakened-test check has ${count(findings)}`;
		return `${describeFailure(config, result)}, and the weakened-test check has ${count(findings)}`;
	}

	/** `ok` is the gate's verdict: the check passed and nothing was weakened. `checkOk` is the command alone. */
	function resultEntry(config: GateConfig, result: CheckResult, tamper: TamperResult) {
		const findings = tamper.findings;
		return {
			type: "custom" as const,
			customType: CUSTOM_TYPE,
			data: {
				command: config.command,
				ok: result.ok && !findings?.length,
				checkOk: result.ok,
				code: result.code,
				timedOut: result.timedOut,
				seconds: result.seconds,
				rounds,
				...(findings ? { tamper: findings } : {}),
			},
		};
	}

	/** Whether this repository's gate looks for weakened tests. False without a usable `.pi/gate.json`. */
	function wantsTamperCheck(ctx: ExtensionContext): boolean {
		if (!enabled) return false;
		try {
			return Boolean(loadGateConfig(ctx.cwd)?.tamperCheck) && ctx.isProjectTrusted();
		} catch {
			return false;
		}
	}

	function checkTampering(config: GateConfig, ctx: ExtensionContext): TamperResult {
		if (!config.tamperCheck) return {};
		const tree = snapshotTree(ctx.cwd);
		if (!tree || !baseTree) {
			if (!warnedNoDiff) tell(ctx, "Weakened-test check skipped: no git state from the start of this prompt to compare with (not a git repository, or the gate was off).", "warning");
			warnedNoDiff = true;
			return { tree };
		}
		try {
			return { findings: tamperFindings(ctx.cwd, baseTree, tree, config.tamperPatterns), tree };
		} catch (error) {
			tell(ctx, `Weakened-test check skipped: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`, "warning");
			return { tree };
		}
	}

	pi.on("before_agent_start", (event, ctx) => {
		// Runs started by extension messages (for example a finished background subagent)
		// keep the baseline of the user's prompt, so their changes are checked too.
		if (event.messageType !== "user" && baseline) return undefined;
		baseline = takeSnapshot(ctx.cwd);
		baseTree = wantsTamperCheck(ctx) ? snapshotTree(ctx.cwd) : undefined;
		touched = new Set();
		rounds = 0;
		lastFailedKey = undefined;
		openFindings = [];
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
			// The round changed nothing. For a red check that is the end; for findings it is the
			// agent's answer that the changes are right, and the list goes to the user.
			const findings = openFindings;
			baseline = current;
			baseTree = findings.length ? snapshotTree(ctx.cwd) : baseTree;
			touched = new Set();
			openFindings = [];
			if (!findings.length) {
				tell(ctx, `Gate still red and the last repair round changed nothing; stopped. Run /gate to see the output.`, "error");
				return undefined;
			}
			const list = formatFindings(findings);
			tell(ctx, `Gate still red and the last repair round changed nothing; stopped. ${count(findings)} of the weakened-test check for you to judge:\n${list.join("\n")}`, "error");
			return {
				entries: [
					...event.entries,
					{
						type: "custom_message" as const,
						customType: CUSTOM_TYPE,
						display: true,
						content: [
							`[quality-gate] ${count(findings)} of the weakened-test check remain${findings.length === 1 ? "s" : ""} after the last round, which changed nothing. Handing back to the user.`,
							"",
							...list,
						].join("\n"),
					},
				],
			};
		}

		// Before the check runs, so files the check itself writes are not part of the diff.
		const tamper = checkTampering(config, ctx);
		const findings = tamper.findings ?? [];
		const result = await runCheck(config, ctx);
		if (result.ok && !findings.length) {
			if (rounds > 0) tell(ctx, `Gate green after ${rounds} repair round(s): ${config.command}`, "info");
			baseline = current;
			baseTree = tamper.tree ?? baseTree;
			touched = new Set();
			lastFailedKey = undefined;
			openFindings = [];
			return { entries: [...event.entries, resultEntry(config, result, tamper)] };
		}

		lastFailedKey = key;
		openFindings = findings;
		const red = describeRed(config, result, findings);
		const output = result.ok ? "" : outputExcerpt(result.output) || "(no output)";
		const outputBlock = result.ok ? [] : ["", "```", output, "```"];
		const list = formatFindings(findings);

		// Exit code 127: the check command itself is missing. The agent cannot fix that.
		const environmentProblem = result.code === 127;
		if (!environmentProblem && rounds < config.maxRepairRounds) {
			rounds++;
			const checkPart = result.ok
				? []
				: [
						"Fix the cause of the failures below. Do not delete, skip or weaken tests and do not loosen lint or type settings. If a failure is unrelated to your task or cannot be fixed in code, say so and stop.",
					];
			const tamperPart = findings.length
				? [
						...(result.ok ? [] : [""]),
						"The changes since the task started weaken what the check verifies:",
						...list,
						"For each of these: revert it, or, if the change is right (for example because the task asked for it), keep it and say why in one sentence. Do not hide a finding by rewording it. What remains is shown to the user.",
					]
				: [];
			return {
				entries: [
					...event.entries,
					resultEntry(config, result, tamper),
					{
						type: "custom_message" as const,
						customType: CUSTOM_TYPE,
						display: true,
						content: [
							`[quality-gate] ${red}. Repair round ${rounds} of ${config.maxRepairRounds}.`,
							...checkPart,
							...tamperPart,
							result.ok ? "When nothing is left to do, end with a complete summary of the task." : "When the check passes, end with a complete summary of the task.",
							...outputBlock,
						].join("\n"),
					},
				],
				continue: true,
			};
		}

		const stopReason = environmentProblem
			? "the check command was not found (exit 127); fix the environment"
			: `still red after ${rounds} repair round(s)`;
		tell(ctx, `Gate ${stopReason}: ${red}.${findings.length ? `\n${list.join("\n")}` : ""}`, "error");
		baseline = current;
		baseTree = tamper.tree ?? baseTree;
		touched = new Set();
		openFindings = [];
		return {
			entries: [
				...event.entries,
				resultEntry(config, result, tamper),
				{
					type: "custom_message" as const,
					customType: CUSTOM_TYPE,
					display: true,
					content: [`[quality-gate] ${red}; ${stopReason}. Handing back to the user.`, ...(findings.length ? ["", ...list] : []), ...outputBlock].join("\n"),
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
				content: [`[quality-gate] ${headline}`, "", "```", outputExcerpt(result.output) || "(no output)", "```"].join("\n"),
			});
		},
	});
}
