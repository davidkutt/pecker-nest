import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GateConfig {
	/** The repository's single check command, run with `bash -c` in the working directory. */
	command: string;
	/** Automatic repair rounds before the gate hands back to the user. */
	maxRepairRounds: number;
	timeoutSeconds: number;
}

export const GATE_CONFIG_PATH = ".pi/gate.json";
const DEFAULTS = { maxRepairRounds: 2, timeoutSeconds: 600 };

/** Reads `.pi/gate.json`. Returns undefined when the file is absent; throws on invalid content. */
export function loadGateConfig(cwd: string): GateConfig | undefined {
	const path = join(cwd, GATE_CONFIG_PATH);
	if (!existsSync(path)) return undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		throw new Error(`${GATE_CONFIG_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`${GATE_CONFIG_PATH} must be a JSON object`);
	}
	const record = raw as Record<string, unknown>;
	if (typeof record.command !== "string" || !record.command.trim()) {
		throw new Error(`${GATE_CONFIG_PATH} needs a non-empty "command" string`);
	}
	return {
		command: record.command.trim(),
		maxRepairRounds: nonNegativeInteger(record.maxRepairRounds, "maxRepairRounds") ?? DEFAULTS.maxRepairRounds,
		timeoutSeconds: nonNegativeInteger(record.timeoutSeconds, "timeoutSeconds") ?? DEFAULTS.timeoutSeconds,
	};
}

function nonNegativeInteger(value: unknown, key: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${GATE_CONFIG_PATH} "${key}" must be a non-negative integer`);
	}
	return value;
}

/** Changes to these files alone (PLAN.md, docs) never start the check. Not .txt: requirements.txt is code. */
export function isDocsOnly(paths: Iterable<string>): boolean {
	let any = false;
	for (const path of paths) {
		any = true;
		if (!/\.(md|mdx|markdown|rst|adoc)$/i.test(path)) return false;
	}
	return any;
}

/** The last lines of a check's output, bounded for the model's context. */
export function outputTail(output: string, maxLines = 80, maxChars = 8000): string {
	const lines = output.trimEnd().split("\n");
	let tail = lines.slice(-maxLines).join("\n");
	if (tail.length > maxChars) tail = tail.slice(-maxChars);
	const omitted = tail.length < output.trimEnd().length;
	return omitted ? `…(earlier output omitted)\n${tail}` : tail;
}
