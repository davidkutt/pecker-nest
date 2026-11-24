import { STRONG_MODELS, type Strong, strongByModelId } from "./router-logic.ts";

/**
 * The woodpecker's logic (bird.ts only translates Pi's events and draws): the mood of the
 * current run, its frames for Pi's working indicator and its line in the footer. Pure and
 * unit-tested; no Pi imports.
 *
 * Every frame is printable ASCII and has the same width, so the indicator never jumps and no
 * terminal draws a glyph wider than expected.
 */

/** What the agent is doing right now. */
export type Activity = "think" | "look" | "peck" | "drum" | "listen";

/** How a run ended: gate green, gate red, aborted, or no gate result in this run. */
export type Outcome = "green" | "red" | "stopped" | "done";

/** Colours the extension maps to theme colours (Pi's `theme.fg` takes these names). */
export type BirdColor = "accent" | "warning" | "error" | "success" | "muted" | "dim";
export type Paint = (color: BirdColor, text: string) => string;

export interface Repair {
	round: number;
	of: number;
}

export interface BirdState {
	running: boolean;
	activity: Activity;
	/** Tool calls that started and have not ended (parallel calls overlap). */
	tools: number;
	/** The strong model answering now; undefined on Flash or a model outside the router. */
	strong?: Strong;
	/** The latest strong model that answered in this run, for the footer after the run. */
	strongUsed?: Strong;
	/** The quality gate's repair round in this run. */
	repair?: Repair;
	/** How the last run ended; undefined before the first run. */
	outcome?: Outcome;
	/** Seconds the gate took in the last run, when it was green. */
	seconds?: number;
}

export const IDLE: BirdState = { running: false, activity: "think", tools: 0 };

export interface GateResult {
	ok: boolean;
	seconds?: number;
}

export type BirdEvent =
	| { type: "run_start" }
	| { type: "turn_start"; repair?: Repair }
	| { type: "model"; modelId: string }
	| { type: "tool_start"; toolName: string }
	| { type: "tool_end" }
	| { type: "settle_check" }
	| { type: "settled"; aborted: boolean; gate?: GateResult };

const LOOK = new Set(["read", "grep", "find", "ls"]);
const PECK = new Set(["edit", "write"]);
const DRUM = new Set(["bash"]);

/** Reading looks around, writing pecks, bash drums; any other tool (subagents, MCP) looks. */
export function activityFor(toolName: string): Activity {
	if (PECK.has(toolName)) return "peck";
	if (DRUM.has(toolName)) return "drum";
	if (LOOK.has(toolName)) return "look";
	return "look";
}

export function next(state: BirdState, event: BirdEvent): BirdState {
	switch (event.type) {
		case "run_start":
			// Pi starts a new low-level run for retries and the gate's repair rounds: same run.
			if (state.running) return state;
			return { ...IDLE, running: true, ...(state.outcome ? { outcome: state.outcome } : {}) };
		case "turn_start":
			return { ...state, activity: "think", tools: 0, ...(event.repair ? { repair: event.repair } : {}) };
		case "model": {
			const strong = strongByModelId(event.modelId);
			const { strong: _, ...rest } = state;
			return { ...rest, ...(strong ? { strong, strongUsed: strong } : {}) };
		}
		case "tool_start":
			return { ...state, activity: activityFor(event.toolName), tools: state.tools + 1 };
		case "tool_end": {
			const tools = Math.max(0, state.tools - 1);
			return { ...state, tools, activity: tools === 0 ? "think" : state.activity };
		}
		case "settle_check":
			return { ...state, activity: "listen", tools: 0 };
		case "settled": {
			const outcome: Outcome = event.aborted ? "stopped" : event.gate ? (event.gate.ok ? "green" : "red") : "done";
			const { seconds: _, repair: __, strong: ___, ...rest } = state;
			return {
				...rest,
				running: false,
				activity: "think",
				tools: 0,
				outcome,
				...(outcome === "green" && event.gate?.seconds !== undefined ? { seconds: event.gate.seconds } : {}),
			};
		}
	}
}

// ---------------------------------------------------------------- frames

/** The bird faces the trunk (`|`) on its right; `'` and `:` are chips flying off. Width 8. */
const FRAMES: Record<Activity, { frames: string[]; intervalMs: number }> = {
	think: { frames: [" (o>  | ", " (o>  | ", " (o>  | ", " (->  | "], intervalMs: 350 },
	look: { frames: [" (o>  | ", " (o>  | ", " <o)  | ", " <o)  | "], intervalMs: 300 },
	peck: { frames: ["(o>   | ", " (o>  | ", "  (o> | ", "   (o>|'", "  (o> | "], intervalMs: 120 },
	drum: { frames: ["   (o>| ", "   (o>|'", "   (o>|:", "   (o>|'"], intervalMs: 90 },
	listen: { frames: ["   (o>| ", "   (O>| "], intervalMs: 400 },
};

/** A repair round drums, faster. */
const REPAIR_INTERVAL_MS = 60;

export const FRAME_WIDTH = 8;

/** Every raw frame, for tests. */
export function allFrames(): string[] {
	return Object.values(FRAMES).flatMap((entry) => entry.frames);
}

function birdColor(state: BirdState): BirdColor {
	if (state.strong) return "error";
	if (state.repair) return "warning";
	return "accent";
}

const plain: Paint = (_color, text) => text;

/** Paints a frame by character class: bird, trunk, chips. Spaces stay unpainted. */
function paintFrame(frame: string, bird: BirdColor, paint: Paint): string {
	const classOf = (char: string): BirdColor | undefined => {
		if (char === " ") return undefined;
		if (char === "|") return "muted";
		if (char === "'" || char === ":") return "dim";
		return bird;
	};
	let out = "";
	let run = "";
	let runColor: BirdColor | undefined;
	const flush = () => {
		if (run) out += runColor ? paint(runColor, run) : run;
		run = "";
	};
	for (const char of frame) {
		const color = classOf(char);
		if (color !== runColor) {
			flush();
			runColor = color;
		}
		run += char;
	}
	flush();
	return out;
}

export interface Indicator {
	/** Changes when the frames change, so the extension only resets the animation then. */
	key: string;
	frames: string[];
	intervalMs: number;
}

/** The working indicator for the current state. */
export function indicator(state: BirdState, paint: Paint = plain): Indicator {
	const activity: Activity = state.repair && (state.activity === "think" || state.activity === "drum") ? "drum" : state.activity;
	const { frames, intervalMs } = FRAMES[activity];
	const color = birdColor(state);
	const interval = state.repair && activity === "drum" ? REPAIR_INTERVAL_MS : intervalMs;
	return {
		key: `${activity}:${color}:${interval}`,
		frames: frames.map((frame) => paintFrame(frame, color, paint)),
		intervalMs: interval,
	};
}

// ---------------------------------------------------------------- footer

/** The footer line. Pi collapses repeated spaces in statuses, so it uses single spaces only. */
export function footer(state: BirdState, paint: Paint = plain): string {
	const model = (strong: Strong | undefined) => (strong ? ` ${paint("error", STRONG_MODELS[strong].name)}` : "");
	if (state.running) {
		const repair = state.repair ? ` ${paint("warning", `repair ${state.repair.round}/${state.repair.of}`)}` : "";
		// Pi hides the working indicator while the gate runs, so the footer bird listens at the trunk.
		const bird = state.activity === "listen" ? `${paint(birdColor(state), "(O>")}${paint("muted", "|")}` : `${paint(birdColor(state), "(o>")} ${paint("muted", "|")}`;
		return `${bird}${model(state.strong)}${repair}`;
	}
	switch (state.outcome) {
		case "green": {
			const seconds = state.seconds ? ` ${state.seconds}s` : "";
			return `${paint("success", "(o>|")} ${paint("success", `gate ok${seconds}`)}${model(state.strongUsed)}`;
		}
		case "red":
			return `${paint("error", "(x>|")} ${paint("error", "gate red")}${model(state.strongUsed)}`;
		case "stopped":
			return `${paint("muted", "(-> | stopped")}`;
		case "done":
			return `${paint("muted", "(o> | done")}${model(state.strongUsed)}`;
		default:
			return paint("muted", "(o> |");
	}
}

// ---------------------------------------------------------------- session entries

/** The parts of Pi's session entries the bird reads. */
export interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
	content?: unknown;
}

/** quality-gate.ts writes one `custom` entry per gate run and a `custom_message` per repair round. */
const GATE = "quality-gate";

const isGateResult = (entry: EntryLike) => entry.type === "custom" && entry.customType === GATE;

/** How many gate results the branch holds; the extension notes it when a run starts. */
export function countGateResults(entries: readonly EntryLike[]): number {
	return entries.filter(isGateResult).length;
}

/** The last gate result written after the first `before` gate results, i.e. in this run. */
export function gateResultSince(entries: readonly EntryLike[], before: number): GateResult | undefined {
	const results = entries.filter(isGateResult);
	if (results.length <= before) return undefined;
	const data = results.at(-1)?.data as { ok?: unknown; seconds?: unknown } | undefined;
	if (typeof data?.ok !== "boolean") return undefined;
	return { ok: data.ok, ...(typeof data.seconds === "number" ? { seconds: data.seconds } : {}) };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : ""))
		.join("");
}

/**
 * The repair round when the branch ends with the gate's repair message, else undefined. Plain
 * `custom` entries (gate results, router state, provider log) carry no message and are skipped.
 */
export function repairRound(entries: readonly EntryLike[]): Repair | undefined {
	const last = entries.findLast((entry) => entry.type !== "custom");
	if (!last || last.type !== "custom_message" || last.customType !== GATE) return undefined;
	const match = /Repair round (\d+) of (\d+)/.exec(textOf(last.content));
	return match ? { round: Number(match[1]), of: Number(match[2]) } : undefined;
}
