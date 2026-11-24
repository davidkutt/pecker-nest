import type { BirdColor, Outcome, Paint } from "./bird.ts";

/**
 * The woodpecker's meter (docs/tasks/bird-meter.md): how close the session is to Pi's
 * auto-compaction, and what the session and the run cost. The perch draws the fill on its trunk
 * and says notes in its bubble, the footer shows `ctx N%`, `/meter` prints the numbers. bird.ts
 * reads Pi (context usage, session entries, compaction settings) on events and hands the readings
 * to `nextMeter`; nothing here is computed per frame. Pure and unit-tested; no Pi imports.
 *
 * Pi 1.5.0 compacts a request the router sends on when
 *   contextTokens > routedModel.contextWindow - reserveTokens(selected model)
 * (agent-session.js, `_exceedsCompactionThreshold`): the routed model's window, the selected
 * model's settings. With nest's 800k reserve and a 1,048,576 window that is 248,576 tokens.
 */

// ---------------------------------------------------------------- compaction point

/** Pi's built-in `compaction.reserveTokens` (settings-defaults.js in Pi 1.5.0). */
export const DEFAULT_RESERVE_TOKENS = 16_384;

/** The part of Pi's `compaction` settings the meter reads. */
export interface CompactionSettingsLike {
	enabled?: boolean;
	reserveTokens?: number;
	modelOverrides?: Record<string, { reserveTokens?: number } | undefined>;
}

export interface ModelRef {
	provider: string;
	id: string;
}

export interface CompactionPoint {
	/** The context window Pi compares against: the routed model's, otherwise the selected one's. */
	window: number;
	reserve: number;
	enabled: boolean;
	/** The tokens at which Pi compacts: window minus reserve, or the whole window without auto-compaction. */
	point: number;
	/** Where the reserve comes from: the selected model's key, `compaction.reserveTokens` or `Pi default`. */
	source: string;
}

const isTokenCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * The compaction point for the selected model, in the fallback order of Pi's
 * `getCompactionSettings`: the model's override, then `reserveTokens`, then Pi's default.
 */
export function compactionPoint(settings: CompactionSettingsLike | undefined, selected: ModelRef | undefined, window: number): CompactionPoint {
	const key = selected ? `${selected.provider}/${selected.id}` : undefined;
	const override = key !== undefined && settings?.modelOverrides && Object.hasOwn(settings.modelOverrides, key) ? settings.modelOverrides[key]?.reserveTokens : undefined;
	const ordinary = settings?.reserveTokens;
	const [reserve, source] = isTokenCount(override) && key !== undefined
		? [override, key]
		: isTokenCount(ordinary)
			? [ordinary, "compaction.reserveTokens"]
			: [DEFAULT_RESERVE_TOKENS, "Pi default"];
	const enabled = typeof settings?.enabled === "boolean" ? settings.enabled : true;
	return { window, reserve, enabled, point: enabled ? window - reserve : window, source };
}

/** True when the reserve leaves no room: Pi compacts before every request. */
export function noRoom(point: CompactionPoint): boolean {
	return point.enabled && point.point <= 0;
}

// ---------------------------------------------------------------- fill

/** Below 70%, from 70% (yellow), from 90% (red). */
export type Level = "ok" | "warn" | "hot";

export const WARN_PERCENT = 70;
export const HOT_PERCENT = 90;
/** The footer shows `ctx N%` from here on. */
export const FOOTER_PERCENT = 50;

/**
 * A fill as a whole percentage, rounded like Pi's footer rounds its own. The levels go by this
 * number, so a shown `70%` is always yellow and a shown `69%` never is.
 */
export function percentOf(fill: number): number {
	return Math.round(fill * 100);
}

export function levelOf(fill: number | undefined): Level {
	if (fill === undefined) return "ok";
	const percent = percentOf(fill);
	return percent >= HOT_PERCENT ? "hot" : percent >= WARN_PERCENT ? "warn" : "ok";
}

export interface Meter {
	/** Context tokens over the compaction point; undefined while unknown (right after a compaction). */
	fill?: number;
	level: Level;
}

/** The fill for Pi's token count; no room before the point counts as full. */
export function meterOf(tokens: number | null, point: number): Meter {
	if (point <= 0) return { fill: 1, level: "hot" };
	if (tokens === null) return { level: "ok" };
	const fill = Math.max(0, tokens) / point;
	return { fill, level: levelOf(fill) };
}

const LEVEL_COLOR: Record<Level, BirdColor> = { ok: "accent", warn: "warning", hot: "error" };

// ---------------------------------------------------------------- the trunk gauge

export interface GaugeCell {
	char: string;
	color: BirdColor;
}

/** The trunk's bark: five rows of two cells. */
export const GAUGE_ROWS = 5;
export const GAUGE_CELLS = GAUGE_ROWS * 2;

/**
 * The bark's cells, top row first. Cells fill bottom-up (bottom row left, bottom row right, then
 * the row above) with `#` in the level's colour; free cells are a dim `:` (not `.`, the hole's
 * first stage). Unknown is all free.
 */
export function gaugeCells(fill?: number): GaugeCell[][] {
	const filled = fill === undefined ? 0 : Math.min(GAUGE_CELLS, Math.max(0, Math.round(fill * GAUGE_CELLS)));
	const color = LEVEL_COLOR[levelOf(fill)];
	return Array.from({ length: GAUGE_ROWS }, (_, y) => {
		const fromBottom = GAUGE_ROWS - 1 - y;
		return [0, 1].map((x): GaugeCell => (fromBottom * 2 + x < filled ? { char: "#", color } : { char: ":", color: "dim" }));
	});
}

/** The run's hole over one row of the gauge: each `#` of the hole shows that cell, the hole stays muted. */
export function overlayHole(row: readonly GaugeCell[], hole: string): GaugeCell[] {
	return [...hole].map((char, i) => (char === "#" && row[i] ? row[i] : { char, color: "muted" }));
}

// ---------------------------------------------------------------- notes

/** A line of the gauge: 70% or 90%. */
export type Line = "warn" | "hot";

/** The lines the fill has reached since it was last below them; each fires its note once. */
export interface Noted {
	warn: boolean;
	hot: boolean;
}

/** The lines a fill is at or above; unknown counts as below both. */
export function notedAt(fill: number | undefined): Noted {
	const level = levelOf(fill);
	return { warn: fill !== undefined && level !== "ok", hot: fill !== undefined && level === "hot" };
}

/**
 * Whether a new fill crosses a line upward. A line fires once and again only after the fill
 * dropped below it; an unknown fill changes nothing. Crossing both at once fires the 90% line.
 */
export function crossing(fill: number | undefined, noted: Noted): { noted: Noted; line?: Line } {
	if (fill === undefined) return { noted };
	const at = notedAt(fill);
	const line: Line | undefined = at.hot && !noted.hot ? "hot" : at.warn && !noted.warn ? "warn" : undefined;
	return line ? { noted: at, line } : { noted: at };
}

/** A bubble the meter puts up for a while, over the bird's own. */
export interface Note {
	text: string;
	color: BirdColor;
	/** When it went up. */
	at: number;
}

/** How long a note stays up. */
export const NOTE_MS = 4_000;
/** How long the compaction scene's chips fall. */
export const SCENE_MS = 1_500;

export function crossingNote(line: Line, fill: number, point: number, at: number): Note {
	return line === "hot"
		? { text: `context ${percentOf(fill)}% - compaction soon`, color: "error", at }
		: { text: `context ${percentOf(fill)}% of ${formatTokens(point)}`, color: "warning", at };
}

export function compactedNote(tokensBefore: number, overflow: boolean, at: number): Note {
	return { text: `compacted from ${formatTokens(tokensBefore)}${overflow ? " (overflow)" : ""}`, color: overflow ? "warning" : "accent", at };
}

export function compactFailedNote(at: number): Note {
	return { text: "compaction failed", color: "error", at };
}

/** The note while it is up. */
export function activeNote(note: Note | undefined, now: number): Note | undefined {
	return note && now >= note.at && now - note.at < NOTE_MS ? note : undefined;
}

export function sceneRunning(sceneAt: number | undefined, now: number): boolean {
	return sceneAt !== undefined && now >= sceneAt && now - sceneAt < SCENE_MS;
}

/** The `/compact` nudge after a green gate with the trunk at 70% or more, e.g. `/compact? (78%)`. */
export function compactNudge(outcome: Outcome | undefined, fill?: number): string | undefined {
	return outcome === "green" && fill !== undefined && levelOf(fill) !== "ok" ? `/compact? (${percentOf(fill)}%)` : undefined;
}

// ---------------------------------------------------------------- cost

interface UsageLike {
	cost?: { total?: unknown };
}

/** The parts of Pi's session entries the cost sum reads. */
export interface CostEntryLike {
	type: string;
	usage?: UsageLike;
	message?: { role?: string; usage?: UsageLike };
}

const costOf = (usage: UsageLike | undefined): number => {
	const total = usage?.cost?.total;
	return typeof total === "number" && Number.isFinite(total) ? total : 0;
};

/**
 * What the session has cost, by the rules of Pi's footer (`getSessionStats`) over all entries,
 * other branches included: usage entries, assistant messages, tool results that carry usage
 * (subagents), compaction and branch summaries with usage.
 */
export function sessionCost(entries: readonly CostEntryLike[]): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") total += costOf(entry.usage);
		else if (entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")) total += costOf(entry.message.usage);
	}
	return total;
}

// ---------------------------------------------------------------- state

/** What bird.ts reads from Pi on an event. */
export interface MeterReading {
	/** Context tokens (null right after a compaction) and the compaction point; undefined when Pi reports no usage. */
	context?: { tokens: number | null; point: CompactionPoint };
	sessionCost: number;
}

/** What the perch and the footer show of the meter. */
export interface MeterView {
	/** The context until compaction; undefined without a model or window, so the trunk is drawn as before. */
	context?: { fill?: number };
	/** The cost of the run going on, or of the last run between runs; undefined before the first run. */
	runCost?: number;
	note?: Note;
	/** When the compaction scene started. */
	sceneAt?: number;
}

export interface MeterState {
	view: MeterView;
	noted: Noted;
	running: boolean;
	/** The session cost at the run's first agent_start. */
	runBaseline?: number;
}

export const METER_IDLE: MeterState = { view: {}, noted: { warn: false, hot: false }, running: false };

export type MeterEvent =
	/** A new or resumed session: lines it is already above count as noted, so no note greets it. */
	| { type: "reset"; reading: MeterReading }
	/** The first agent_start of a run; Pi's continuation runs are the same run. */
	| { type: "run_start"; reading: MeterReading }
	/** Context or cost may have changed: an answer, a tool result, a model or tree switch. */
	| { type: "read"; reading: MeterReading; at: number }
	/** The run settled: its cost stays until the next run. */
	| { type: "run_end"; reading: MeterReading; at: number }
	| { type: "compacted"; reading: MeterReading; tokensBefore: number; overflow: boolean; at: number }
	| { type: "compact_failed"; at: number };

function fillOf(reading: MeterReading): number | undefined {
	return reading.context ? meterOf(reading.context.tokens, reading.context.point.point).fill : undefined;
}

function contextOf(reading: MeterReading): MeterView["context"] {
	if (!reading.context) return undefined;
	const fill = fillOf(reading);
	return fill === undefined ? {} : { fill };
}

/** The view with `changes` applied; keys set to undefined are dropped. */
function view(base: MeterView, changes: Partial<MeterView>): MeterView {
	const merged: MeterView = { ...base, ...changes };
	for (const key of Object.keys(merged) as Array<keyof MeterView>) if (merged[key] === undefined) delete merged[key];
	return merged;
}

/** Reads the context with its crossing note and, during a run, the run's cost so far. */
function measured(state: MeterState, reading: MeterReading, at: number): MeterState {
	const fill = fillOf(reading);
	const crossed = crossing(fill, state.noted);
	const point = reading.context?.point.point ?? 0;
	return {
		...state,
		noted: crossed.noted,
		view: view(state.view, {
			context: contextOf(reading),
			...(state.running && state.runBaseline !== undefined ? { runCost: Math.max(0, reading.sessionCost - state.runBaseline) } : {}),
			...(crossed.line && fill !== undefined ? { note: crossingNote(crossed.line, fill, point, at) } : {}),
		}),
	};
}

export function nextMeter(state: MeterState, event: MeterEvent): MeterState {
	switch (event.type) {
		case "reset":
			return { ...METER_IDLE, noted: notedAt(fillOf(event.reading)), view: view({}, { context: contextOf(event.reading) }) };
		case "run_start":
			if (state.running) return state;
			return { ...state, running: true, runBaseline: event.reading.sessionCost, view: view(state.view, { runCost: 0 }) };
		case "read":
			return measured(state, event.reading, event.at);
		case "run_end":
			return { ...measured(state, event.reading, event.at), running: false };
		case "compacted": {
			const after = measured(state, event.reading, event.at);
			return { ...after, view: view(after.view, { note: compactedNote(event.tokensBefore, event.overflow, event.at), sceneAt: event.at }) };
		}
		case "compact_failed":
			return { ...state, view: view(state.view, { note: compactFailedNote(event.at) }) };
	}
}

/** The run `/meter` reports: the one going on, or the last one; undefined before the first run. */
export function runOf(state: MeterState, reading: MeterReading): { cost: number; running: boolean } | undefined {
	if (state.running && state.runBaseline !== undefined) return { cost: Math.max(0, reading.sessionCost - state.runBaseline), running: true };
	return state.view.runCost !== undefined ? { cost: state.view.runCost, running: false } : undefined;
}

// ---------------------------------------------------------------- text

/** Token counts exactly like Pi's footer (`formatTokens` in footer.js): 850, 1.4k, 28k, 249k, 1.0M. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/** Money: three decimals below a dollar, two from a dollar. */
export function formatCost(cost: number): string {
	const cents = cost.toFixed(3);
	return Number(cents) < 1 ? `$${cents}` : `$${cost.toFixed(2)}`;
}

const FOOTER_COLOR: Record<Level, BirdColor> = { ok: "muted", warn: "warning", hot: "error" };

/** The footer's part from 50%: `ctx 64%`, muted, yellow from 70%, red from 90%; nothing below or unknown. */
export function ctxPart(fill: number | undefined, paint: Paint): string | undefined {
	if (fill === undefined || percentOf(fill) < FOOTER_PERCENT) return undefined;
	return paint(FOOTER_COLOR[levelOf(fill)], `ctx ${percentOf(fill)}%`);
}

export type ReportKind = "both" | "context" | "cost";

export const METER_USAGE = "/meter [context|cost]";

/** `/meter`, `/meter context`, `/meter cost`; undefined for anything else. */
export function reportKind(args: string | undefined): ReportKind | undefined {
	const kind = (args ?? "").trim().toLowerCase();
	if (kind === "") return "both";
	return kind === "context" || kind === "cost" ? kind : undefined;
}

function contextText(reading: MeterReading, withSource: boolean): string {
	if (!reading.context) return "context unknown: no model with a context window";
	const { tokens, point } = reading.context;
	const source = withSource ? ` (${point.source})` : "";
	if (noRoom(point)) return `reserve ${formatTokens(point.reserve)} >= window ${formatTokens(point.window)}: Pi compacts before every request${source}`;
	if (tokens === null) return "context unknown until the next answer (just compacted)";
	if (!point.enabled) return `context ${formatTokens(tokens)} of the ${formatTokens(point.window)} window (${percentOf(tokens / point.window)}%), auto-compaction off`;
	return `context ${formatTokens(tokens)} of ${formatTokens(point.point)} before compaction (${percentOf(tokens / point.point)}%), window ${formatTokens(point.window)}, reserve ${formatTokens(point.reserve)}${source}`;
}

function costText(reading: MeterReading, run: { cost: number; running: boolean } | undefined): string {
	const session = `session ${formatCost(reading.sessionCost)}`;
	return run ? `${session}, ${run.running ? "this run" : "last run"} ${formatCost(run.cost)}` : session;
}

/** The line `/meter` prints: counts and money only. */
export function meterReport(kind: ReportKind, reading: MeterReading, run?: { cost: number; running: boolean }): string {
	switch (kind) {
		case "context":
			return contextText(reading, true);
		case "cost":
			return costText(reading, run);
		case "both":
			return `${contextText(reading, false)} - ${costText(reading, run)}`;
	}
}
