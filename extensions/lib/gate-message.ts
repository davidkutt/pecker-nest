import { type GateConfig, outputExcerpt } from "./gate-config.ts";
import { type Finding, formatFindings } from "./tamper-check.ts";

/**
 * The quality gate's messages to the agent: a repair round, the hand-back when the rounds are used
 * up, and the hand-back when a round changed nothing. Pi's quality-gate.ts and the Cursor adapter
 * send the same text; the router (repair round 2) and the session report read its first line.
 */

export const GATE_MESSAGE_PREFIX = "[quality-gate]";

/** What the check command did. */
export interface CheckOutcome {
	ok: boolean;
	code: number;
	timedOut: boolean;
	output: string;
}

export type GateMessageConfig = Pick<GateConfig, "command" | "timeoutSeconds" | "maxRepairRounds">;

export const findingCount = (findings: readonly Finding[]) => `${findings.length} finding${findings.length === 1 ? "" : "s"}`;

/** Exit code 127: the check command itself is missing. The agent cannot fix that. */
export const isEnvironmentProblem = (result: CheckOutcome) => result.code === 127;

export function describeFailure(config: Pick<GateConfig, "command" | "timeoutSeconds">, result: CheckOutcome): string {
	const why = result.timedOut ? `timed out after ${config.timeoutSeconds}s` : `failed with exit code ${result.code}`;
	return `\`${config.command}\` ${why}`;
}

/** The headline of a red gate: the failed check, the findings, or both. */
export function describeRed(config: Pick<GateConfig, "command" | "timeoutSeconds">, result: CheckOutcome, findings: readonly Finding[]): string {
	if (!findings.length) return describeFailure(config, result);
	if (result.ok) return `\`${config.command}\` passed, but the weakened-test check has ${findingCount(findings)}`;
	return `${describeFailure(config, result)}, and the weakened-test check has ${findingCount(findings)}`;
}

function outputBlock(result: CheckOutcome): string[] {
	return result.ok ? [] : ["", "```", outputExcerpt(result.output) || "(no output)", "```"];
}

/** The message that sends a red check or findings back to the agent as repair round `round`. */
export function repairMessage(config: GateMessageConfig, result: CheckOutcome, findings: readonly Finding[], round: number): string {
	const list = formatFindings(findings);
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
	return [
		`${GATE_MESSAGE_PREFIX} ${describeRed(config, result, findings)}. Repair round ${round} of ${config.maxRepairRounds}.`,
		...checkPart,
		...tamperPart,
		result.ok ? "When nothing is left to do, end with a complete summary of the task." : "When the check passes, end with a complete summary of the task.",
		...outputBlock(result),
	].join("\n");
}

/** Why the gate stops repairing: the environment, or the rounds are used up. */
export function handBackReason(result: CheckOutcome, rounds: number): string {
	return isEnvironmentProblem(result) ? "the check command was not found (exit 127); fix the environment" : `still red after ${rounds} repair round(s)`;
}

/** The message that hands a red gate back to the user. */
export function handBackMessage(config: GateMessageConfig, result: CheckOutcome, findings: readonly Finding[], reason: string): string {
	const list = formatFindings(findings);
	return [`${GATE_MESSAGE_PREFIX} ${describeRed(config, result, findings)}; ${reason}. Handing back to the user.`, ...(findings.length ? ["", ...list] : []), ...outputBlock(result)].join("\n");
}

/** The message when findings remain after a round that changed nothing. */
export function unchangedFindingsMessage(findings: readonly Finding[]): string {
	return [
		`${GATE_MESSAGE_PREFIX} ${findingCount(findings)} of the weakened-test check remain${findings.length === 1 ? "s" : ""} after the last round, which changed nothing. Handing back to the user.`,
		"",
		...formatFindings(findings),
	].join("\n");
}
