/**
 * Session report: turns Pi session logs into the numbers a handoff needs. Counts and paths
 * only; it never prints file contents, prompts or model output.
 *
 *   node scripts/session-report.ts                       # latest session for the current directory
 *   node scripts/session-report.ts --cwd ~/dev/undertext # latest session for that repository
 *   node scripts/session-report.ts --since 8h            # every session of the repository in the last 8 hours
 *   node scripts/session-report.ts --since 2026-11-08    # … since a date
 *   node scripts/session-report.ts path/to/session.jsonl [more.jsonl]
 *   … --json                                             # machine-readable
 *
 * Subagent runs (pi-subagents keeps them next to the session file) are included and listed by
 * agent. Sessions live in ${PI_CODING_AGENT_SESSION_DIR:-${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions}.
 * Every branch of a session counts: abandoned /tree branches cost money too.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- analysis (pure)

export interface Entry {
	type: string;
	timestamp?: string;
	customType?: string;
	data?: unknown;
	content?: unknown;
	cwd?: string;
	usage?: Usage;
	message?: {
		role?: string;
		content?: unknown;
		model?: string;
		thinkingLevel?: string;
		stopReason?: string;
		errorMessage?: string;
		usage?: Usage;
		toolName?: string;
		isError?: boolean;
	};
}

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export interface ModelStats {
	requests: number;
	errors: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	thinking: Record<string, number>;
}

export interface Stats {
	prompts: number;
	planPrompts: number;
	models: Record<string, ModelStats>;
	agents: Record<string, { requests: number; cost: number }>;
	otherCost: number;
	escalations: Record<string, number>;
	/** The same switches counted by the strong model that served them (`glm`, `kimi`). */
	escalationsByModel: Record<string, number>;
	tools: Record<string, { calls: number; failed: number; blocked: number }>;
	edits: { calls: number; failed: number };
	loops: number;
	gate: { runs: number; green: number; red: number; repairs: number; handedBack: number };
	safetyBlocks: Record<string, number>;
	compactions: number;
	checkpoints: number;
	requestErrors: string[];
}

export function emptyStats(): Stats {
	return {
		prompts: 0,
		planPrompts: 0,
		models: {},
		agents: {},
		otherCost: 0,
		escalations: {},
		escalationsByModel: {},
		tools: {},
		edits: { calls: 0, failed: 0 },
		loops: 0,
		gate: { runs: 0, green: 0, red: 0, repairs: 0, handedBack: 0 },
		safetyBlocks: {},
		compactions: 0,
		checkpoints: 0,
		requestErrors: [],
	};
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { type?: string; text?: string }) => (part?.type === "text" ? (part.text ?? "") : "")).join("\n");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

const SAFETY_PREFIX = "Blocked by safety-gate: ";

/** Adds one session's entries to `stats`. `agent` names the session: `main` or a subagent role. */
export function addEntries(stats: Stats, entries: readonly Entry[], agent = "main"): Stats {
	let lastKey: string | undefined;
	let run = 0;
	let lastTier = "flash";
	const agentStats = (stats.agents[agent] ??= { requests: 0, cost: 0 });
	for (const entry of entries) {
		const message = entry.message;
		if (entry.type === "message" && message) {
			if (message.role === "user") {
				lastKey = undefined;
				run = 0;
				if (agent === "main") {
					const text = textOf(message.content).trimStart();
					stats.prompts++;
					if (/^(\/plan\b|Plan the following change\.)/.test(text)) stats.planPrompts++;
				}
			} else if (message.role === "assistant" && message.model) {
				const model = (stats.models[message.model] ??= { requests: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, thinking: {} });
				const usage = message.usage ?? {};
				const cost = usage.cost?.total ?? 0;
				model.requests++;
				model.input += usage.input ?? 0;
				model.output += usage.output ?? 0;
				model.cacheRead += usage.cacheRead ?? 0;
				model.cacheWrite += usage.cacheWrite ?? 0;
				model.cost += cost;
				const level = message.thinkingLevel ?? "default";
				model.thinking[level] = (model.thinking[level] ?? 0) + 1;
				agentStats.requests++;
				agentStats.cost += cost;
				if (message.stopReason === "error") {
					model.errors++;
					if (stats.requestErrors.length < 10) stats.requestErrors.push(`${message.model}: ${(message.errorMessage ?? "error").slice(0, 120)}`);
				}
				if (Array.isArray(message.content)) {
					for (const block of message.content as { type?: string; name?: string; arguments?: unknown }[]) {
						if (block?.type !== "toolCall" || !block.name) continue;
						const tool = (stats.tools[block.name] ??= { calls: 0, failed: 0, blocked: 0 });
						tool.calls++;
						if (block.name === "edit" || block.name === "write") stats.edits.calls++;
						const key = `${block.name} ${stableJson(block.arguments ?? {})}`;
						run = key === lastKey ? run + 1 : 1;
						lastKey = key;
						if (run === 3) stats.loops++;
					}
				}
			} else if (message.role === "toolResult" && message.toolName) {
				const tool = (stats.tools[message.toolName] ??= { calls: 0, failed: 0, blocked: 0 });
				const text = textOf(message.content);
				if (message.isError && text.startsWith(SAFETY_PREFIX)) {
					tool.blocked++;
					const reason = text.slice(SAFETY_PREFIX.length).split(/\. Do not try/)[0].replace(/\s+/g, " ").slice(0, 100);
					stats.safetyBlocks[reason] = (stats.safetyBlocks[reason] ?? 0) + 1;
				} else if (message.isError) {
					tool.failed++;
					if (message.toolName === "edit" || message.toolName === "write") stats.edits.failed++;
				}
			}
		} else if (entry.type === "custom" && entry.customType === "pi.virtual-model-state") {
			const state = (entry.data as { state?: { tier?: string; why?: string; strong?: string } } | undefined)?.state;
			// `strong` is the current tier name; sessions from before /strong wrote `glm`.
			const tier = state?.tier === "glm" ? "strong" : state?.tier;
			if (tier === "strong" && lastTier !== "strong") {
				const why = state?.why ?? "unknown";
				stats.escalations[why] = (stats.escalations[why] ?? 0) + 1;
				const strong = state?.strong ?? "glm";
				stats.escalationsByModel[strong] = (stats.escalationsByModel[strong] ?? 0) + 1;
			}
			lastTier = tier ?? lastTier;
		} else if (entry.type === "custom" && entry.customType === "quality-gate") {
			const data = entry.data as { ok?: boolean } | undefined;
			stats.gate.runs++;
			if (data?.ok) stats.gate.green++;
			else stats.gate.red++;
		} else if (entry.type === "custom_message" && entry.customType === "quality-gate") {
			const text = textOf(entry.content);
			if (/Repair round \d+/.test(text)) stats.gate.repairs++;
			if (/Handing back to the user/.test(text)) stats.gate.handedBack++;
		} else if (entry.type === "custom" && entry.customType === "nest-checkpoint" && agent === "main") {
			stats.checkpoints++;
		} else if (entry.type === "compaction") {
			stats.compactions++;
		}
		// Usage that is not an assistant message (compaction summaries, cache warming).
		const extra = entry.type === "message" ? undefined : (entry.usage ?? (entry.data as { usage?: Usage } | undefined)?.usage);
		if (extra?.cost?.total) stats.otherCost += extra.cost.total;
	}
	return stats;
}

export function totalCost(stats: Stats): number {
	return Object.values(stats.models).reduce((sum, model) => sum + model.cost, 0) + stats.otherCost;
}

// ---------------------------------------------------------------- files

export function parseSession(file: string): Entry[] {
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter((line) => line.trim())
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Entry];
			} catch {
				return [];
			}
		});
}

export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PI_CODING_AGENT_SESSION_DIR) return env.PI_CODING_AGENT_SESSION_DIR;
	return join(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
}

/** Pi's folder name for a working directory: leading separator removed, `/ \ :` become `-`. */
export function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Main session files of a working directory, newest first. */
export function sessionFiles(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const dir = join(sessionsDir(env), encodeCwd(cwd));
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(dir, name))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/** pi-subagents child sessions of a main session file, with the agent name when it is known. */
export function childSessions(file: string): { file: string; agent: string }[] {
	const dir = file.replace(/\.jsonl$/, "");
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
	const agents = new Map<string, string>();
	const artifacts = join(dirname(file), "subagent-artifacts");
	if (existsSync(artifacts)) {
		for (const name of readdirSync(artifacts)) {
			const match = /^([0-9a-f-]{36})_(.+?)(?:_\d+)?_meta\.json$/.exec(name);
			if (match) agents.set(match[1], match[2]);
		}
	}
	const found: { file: string; agent: string }[] = [];
	const walk = (current: string, depth: number) => {
		if (depth > 4) return;
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) walk(path, depth + 1);
			else if (entry.name === "session.jsonl") {
				const runId = path.slice(dir.length + 1).split(/[\\/]/)[0];
				found.push({ file: path, agent: agents.get(runId) ?? "subagent" });
			}
		}
	};
	walk(dir, 0);
	return found;
}

export function parseSince(value: string, now = Date.now()): number {
	const relative = /^(\d+)([mhd])$/.exec(value);
	if (relative) return now - Number(relative[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as "m" | "h" | "d"];
	const time = Date.parse(value);
	if (Number.isNaN(time)) throw new Error(`--since: expected e.g. 8h, 2d or a date, got ${value}`);
	return time;
}

export interface Report {
	sessions: { file: string; cwd?: string; start?: string; end?: string; subagentRuns: number }[];
	stats: Stats;
	totalCost: number;
}

export function buildReport(files: readonly string[]): Report {
	const stats = emptyStats();
	const sessions: Report["sessions"] = [];
	for (const file of files) {
		const entries = parseSession(file);
		const stamps = entries.map((entry) => entry.timestamp).filter((stamp): stamp is string => Boolean(stamp));
		addEntries(stats, entries);
		const children = childSessions(file);
		for (const child of children) addEntries(stats, parseSession(child.file), child.agent);
		sessions.push({
			file,
			cwd: entries.find((entry) => entry.type === "session")?.cwd,
			start: stamps[0],
			end: stamps.at(-1),
			subagentRuns: children.length,
		});
	}
	return { sessions, stats, totalCost: totalCost(stats) };
}

// ---------------------------------------------------------------- output

/** Display names for the strong models the router can call in (see extensions/lib/router-logic.ts). */
const STRONG_NAMES: Record<string, string> = { glm: "GLM 5.3", kimi: "Kimi K3.1 Pro" };

const usd = (value: number) => `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
const tokens = (value: number) => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value));
const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "–");

function minutes(start?: string, end?: string): number {
	if (!start || !end) return 0;
	return Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000));
}

export function renderMarkdown(report: Report): string {
	const { stats } = report;
	const lines: string[] = ["# nest session report", ""];
	for (const session of report.sessions) {
		lines.push(
			`- \`${basename(session.file)}\` in \`${session.cwd ?? "?"}\`: ${session.start ?? "?"} → ${session.end ?? "?"} (${minutes(session.start, session.end)} min), ${session.subagentRuns} subagent run(s)`,
		);
	}
	lines.push("", `Prompts: ${stats.prompts} (of them /plan: ${stats.planPrompts}). Total cost: **${usd(report.totalCost)}**.`, "", "## Models", "");
	lines.push("| Model | Requests | Errors | Thinking | Input | Cache read | Output | Cost |", "| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |");
	for (const [name, model] of Object.entries(stats.models).sort(([, a], [, b]) => b.cost - a.cost)) {
		const thinking = Object.entries(model.thinking)
			.map(([level, count]) => `${level} ${count}`)
			.join(", ");
		lines.push(`| ${name} | ${model.requests} | ${model.errors} | ${thinking} | ${tokens(model.input)} | ${tokens(model.cacheRead)} | ${tokens(model.output)} | ${usd(model.cost)} |`);
	}
	if (stats.otherCost) lines.push(`| (compaction and other usage) | | | | | | | ${usd(stats.otherCost)} |`);
	const cacheRead = Object.values(stats.models).reduce((sum, model) => sum + model.cacheRead, 0);
	const input = Object.values(stats.models).reduce((sum, model) => sum + model.input, 0);
	lines.push("", `Cache hit rate on input: ${pct(cacheRead, cacheRead + input)}.`);
	if (Object.keys(stats.agents).length > 1) {
		lines.push("", "By agent: " + Object.entries(stats.agents).map(([agent, value]) => `${agent} ${value.requests} req / ${usd(value.cost)}`).join(", ") + ".");
	}
	if (stats.requestErrors.length) lines.push("", "Request errors:", ...stats.requestErrors.map((error) => `- ${error}`));

	const escalations = Object.entries(stats.escalations);
	const byModel = Object.entries(stats.escalationsByModel);
	lines.push("", "## Router", "");
	if (escalations.length) {
		lines.push(`Switches to the strong model: ${escalations.map(([why, count]) => `${why} ${count}`).join(", ")}.`);
		lines.push(`By strong model: ${byModel.map(([strong, count]) => `${STRONG_NAMES[strong] ?? strong} ${count}`).join(", ")}.`);
	} else {
		lines.push("No switch to the strong model (or router/escalate was not selected).");
	}

	lines.push("", "## Tools", "", "| Tool | Calls | Failed | Blocked |", "| --- | ---: | ---: | ---: |");
	for (const [name, tool] of Object.entries(stats.tools).sort(([, a], [, b]) => b.calls - a.calls)) {
		lines.push(`| ${name} | ${tool.calls} | ${tool.failed} | ${tool.blocked} |`);
	}
	lines.push("", `Failed edits: ${stats.edits.failed} of ${stats.edits.calls} (${pct(stats.edits.failed, stats.edits.calls)}). Loops (same call 3× in a row): ${stats.loops}.`);

	const gate = stats.gate;
	lines.push("", "## Gates", "");
	lines.push(`Quality gate: ${gate.runs} run(s), ${gate.green} green, ${gate.red} red, ${gate.repairs} repair round(s), handed back red ${gate.handedBack}×.`);
	const blocks = Object.entries(stats.safetyBlocks);
	lines.push(blocks.length ? `Safety gate blocks: ${blocks.map(([reason, count]) => `${count}× ${reason}`).join("; ")}.` : "Safety gate blocks: none.");
	lines.push("", `Compactions: ${stats.compactions}. Checkpoints: ${stats.checkpoints}.`);
	return lines.join("\n");
}

// ---------------------------------------------------------------- CLI

function main(argv: string[]) {
	let cwd = process.cwd();
	let since: number | undefined;
	let json = false;
	const files: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--json") json = true;
		else if (arg === "--cwd") cwd = resolve(argv[++index] ?? "");
		else if (arg === "--since") since = parseSince(argv[++index] ?? "");
		else if (arg === "--latest") continue;
		else if (arg === "-h" || arg === "--help") {
			console.log("usage: session-report.ts [--cwd DIR] [--since 8h|DATE] [--json] [session.jsonl …]");
			return;
		} else files.push(resolve(arg));
	}
	if (!files.length) {
		const real = existsSync(cwd) ? realpathSync(cwd) : cwd;
		const all = sessionFiles(real);
		const chosen = since === undefined ? all.slice(0, 1) : all.filter((file) => statSync(file).mtimeMs >= since);
		if (!chosen.length) {
			console.error(`no Pi sessions for ${real} in ${join(sessionsDir(), encodeCwd(real))}`);
			process.exit(1);
		}
		files.push(...chosen.reverse());
	}
	const report = buildReport(files);
	console.log(json ? JSON.stringify(report, null, 2) : renderMarkdown(report));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
