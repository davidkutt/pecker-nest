import { type BirdColor, type BirdState, birdColor, type Paint } from "./bird.ts";
import { activeNote, compactNudge, formatCost, gaugeCells, type MeterView, overlayHole, SCENE_MS, sceneRunning } from "./bird-meter.ts";
import { STRONG_MODELS } from "./router-logic.ts";

/**
 * The perch: the woodpecker on its trunk in a widget above Pi's editor, five rows high and always
 * visible (docs/tasks/bird-deluxe.md, L1). It is drawn from the same state as the footer (bird.ts)
 * plus a clock that says when the current pose started and when the bird last had something to do.
 * Pure and unit-tested; no Pi imports.
 *
 *     ,^.    |##|      .----------------------------------------.
 *    ( ^ =>  |o#|      < gate green in 41s. pecked 3, drummed 1 )
 *    /)  )   |##|      `----------------------------------------'
 *   /_/ /    |##|
 *    `-`     |##|
 *
 * With a meter view (bird-meter.ts, docs/tasks/bird-meter.md) the trunk's bark is a gauge of the
 * context until compaction, the bubble adds the run's cost, notes and the `/compact` nudge, and a
 * compaction sheds chips off every row. Without one it draws as before.
 *
 * Everything is printable ASCII, every line fits the given width, and the perch is always
 * PERCH_HEIGHT rows when it draws at all, so the editor below never jumps.
 */

export const PERCH_HEIGHT = 5;
/** Below this width the perch draws nothing. */
export const PERCH_MIN_WIDTH = 18;
/** Without a run or a keystroke for this long, the bird falls asleep. */
export const SLEEP_AFTER_MS = 5 * 60_000;
/** After a keystroke the bird looks out at you for this long. */
export const WATCH_MS = 2_000;

/** What the perch shows; between runs the bird is idle. */
export type Pose = "think" | "look" | "peck" | "drum" | "listen" | "idle";

export interface PerchClock {
	/** When the current pose started, so its animation begins at its first frame. */
	since: number;
	/** When the bird last had something to do: session start, start or end of a run, a keystroke. */
	idleSince: number;
	/** The last keystroke. */
	inputAt?: number;
}

export function startClock(now: number): PerchClock {
	return { since: now, idleSince: now };
}

/** The pose for a state. A repair round drums while it thinks. */
export function poseOf(state: BirdState): Pose {
	if (!state.running) return "idle";
	if (state.repair && (state.activity === "think" || state.activity === "drum")) return "drum";
	return state.activity;
}

/** Changes when the perch's animation should start over (a repair round drums at another speed). */
function poseKey(state: BirdState): string {
	return `${poseOf(state)}:${state.repair ? "repair" : ""}`;
}

/** The clock after an event moved the state from `before` to `after`. */
export function advanceClock(clock: PerchClock, before: BirdState, after: BirdState, now: number): PerchClock {
	let next = clock;
	if (poseKey(before) !== poseKey(after)) next = { ...next, since: now };
	if (before.running !== after.running) next = { ...next, idleSince: now };
	return next;
}

/** A keystroke wakes the bird and makes it look out for WATCH_MS. */
export function noteInput(clock: PerchClock, now: number): PerchClock {
	return { ...clock, inputAt: now, idleSince: now };
}

// ---------------------------------------------------------------- timing

const POSE_INTERVAL_MS: Record<Pose, number> = { think: 350, look: 300, peck: 120, drum: 90, listen: 400, idle: 300 };
/** A repair round drums faster. */
const REPAIR_INTERVAL_MS = 60;
/** The rising z's while it sleeps. */
const SLEEP_INTERVAL_MS = 700;

function asleep(state: BirdState, clock: PerchClock, now: number): boolean {
	return !state.running && now - clock.idleSince >= SLEEP_AFTER_MS;
}

function watching(state: BirdState, clock: PerchClock, now: number): boolean {
	return !state.running && clock.inputAt !== undefined && now - clock.inputAt < WATCH_MS;
}

/** The compaction scene's chips move at this rate. */
const SCENE_INTERVAL_MS = 100;

/** The pose's frame length. */
function poseInterval(state: BirdState, clock: PerchClock, now: number): number {
	if (asleep(state, clock, now)) return SLEEP_INTERVAL_MS;
	const pose = poseOf(state);
	return state.repair && pose === "drum" ? REPAIR_INTERVAL_MS : POSE_INTERVAL_MS[pose];
}

/** How often the perch may change; the widget checks its lines at this rate, faster while chips fall in a compaction scene. */
export function perchInterval(state: BirdState, clock: PerchClock, now: number, meter?: MeterView): number {
	const interval = poseInterval(state, clock, now);
	return sceneRunning(meter?.sceneAt, now) ? Math.min(interval, SCENE_INTERVAL_MS) : interval;
}

function frameIndex(state: BirdState, clock: PerchClock, now: number): number {
	return Math.floor(Math.max(0, now - clock.since) / poseInterval(state, clock, now));
}

// ---------------------------------------------------------------- layout

/** The beak row: a see-through column, the head and a two-column beak, at the trunk or turned away. */
const HEAD = (eye: string) => ` ( ${eye} =>`;
const HEAD_AWAY = (eye: string) => `<= ${eye} )`;
const BIRD_WIDTH = 7;

/** Columns: a one-column margin, the bird, the trunk, the chips, the bubble. */
const WINDUP = 1;
const REST = 2;
const RECOIL = 3;
/** At STRIKE the beak touches the trunk. */
const STRIKE = 4;
const TRUNK_X = STRIKE + BIRD_WIDTH;
const CHIPS_X = TRUNK_X + 4;
const CHIPS_END = CHIPS_X + 4;
const BUBBLE_X = CHIPS_END + 2;
/** The beak's row, where the hole is and the chips start. */
const BEAK_ROW = 1;

/** The bird facing the trunk (or turned away, looking out); spaces are see-through. */
function birdSprite(eye: string, away: boolean): string[] {
	return ["  ,^. ", away ? HEAD_AWAY(eye) : HEAD(eye), " /)  )", "/_/ / ", " `-`  "];
}

/** Peck: wind up, rest, recoil, strike, recoil. Drum: recoil, strike. */
const PECK_STEPS = [WINDUP, REST, RECOIL, STRIKE, RECOIL];
const DRUM_STEPS = [RECOIL, STRIKE];

function isStrike(pose: Pose, frame: number): boolean {
	if (frame < 0) return false;
	if (pose === "peck") return PECK_STEPS[frame % PECK_STEPS.length] === STRIKE;
	if (pose === "drum") return DRUM_STEPS[frame % DRUM_STEPS.length] === STRIKE;
	return false;
}

interface BirdPose {
	x: number;
	eye: string;
	away: boolean;
}

function birdPose(state: BirdState, clock: PerchClock, now: number, frame: number): BirdPose {
	switch (poseOf(state)) {
		case "think":
			return { x: REST, eye: frame % 4 === 3 ? "-" : "@", away: false };
		case "look":
			return { x: REST, eye: "@", away: frame % 4 >= 2 };
		case "peck":
			return { x: PECK_STEPS[frame % PECK_STEPS.length], eye: "@", away: false };
		case "drum":
			return { x: DRUM_STEPS[frame % DRUM_STEPS.length], eye: "@", away: false };
		case "listen":
			return { x: STRIKE, eye: frame % 2 === 1 ? "O" : "o", away: false };
		case "idle": {
			if (asleep(state, clock, now)) return { x: REST, eye: "-", away: false };
			if (watching(state, clock, now)) return { x: REST, eye: "@", away: true };
			const mood = state.outcome === "green" ? "^" : state.outcome === "red" ? "x" : state.outcome === "stopped" ? "-" : "@";
			const blink = (mood === "@" || mood === "^") && frame % 13 === 12;
			return { x: REST, eye: blink ? "-" : mood, away: false };
		}
	}
}

/** The hole at beak height grows with the edits of the run: nothing, `.`, `o`, `O`, `()`. */
export function holeFor(pecks: number): string {
	if (pecks >= 10) return "()";
	if (pecks >= 6) return "O#";
	if (pecks >= 3) return "o#";
	if (pecks >= 1) return ".#";
	return "##";
}

// ---------------------------------------------------------------- chips

/** Frames a chip lives at most; it is gone earlier once it leaves the chip area. */
const CHIP_LIFE = 8;
const GRAVITY = 0.45;

/** A deterministic hash in [0, 1), so chips need no random state and tests see fixed frames. */
function unit(...values: number[]): number {
	let h = 0x5eed;
	for (const value of values) {
		h = Math.imul(h ^ value, 0x9e3779b1);
		h ^= h >>> 15;
	}
	h = Math.imul(h ^ (h >>> 13), 0x85ebca6b);
	h ^= h >>> 16;
	return (h >>> 0) / 0x1_0000_0000;
}

interface Chip {
	x: number;
	y: number;
	char: string;
}

/** The chips in the air at `frame`: each strike throws one (drum) or one or two (peck). */
export function chipsAt(pose: Pose, frame: number): Chip[] {
	const chips: Chip[] = [];
	for (let strike = Math.max(0, frame - CHIP_LIFE + 1); strike <= frame; strike++) {
		if (!isStrike(pose, strike)) continue;
		const count = pose === "peck" && unit(strike, 99) < 0.5 ? 2 : 1;
		for (let k = 0; k < count; k++) {
			const age = frame - strike;
			const vx = 0.5 + unit(strike, k, 1) * 0.7;
			const vy = 0.6 + unit(strike, k, 2) * 0.6;
			const x = CHIPS_X + Math.round(vx * age);
			const y = BEAK_ROW + Math.round(-vy * age + (GRAVITY * age * age) / 2);
			if (x > CHIPS_END || y < 0 || y >= PERCH_HEIGHT) continue;
			const rising = GRAVITY * age < vy;
			chips.push({ x, y, char: age === 0 ? (pose === "drum" ? ":" : "'") : rising ? "'" : "." });
		}
	}
	return chips;
}

/** Chips each trunk row sheds in a compaction scene. */
const SCENE_WAVES = 3;
/** The scene's frames: 15 at SCENE_INTERVAL_MS. */
const SCENE_FRAMES = SCENE_MS / SCENE_INTERVAL_MS;

/**
 * The chips of the compaction scene at `frame` (SCENE_INTERVAL_MS each): every trunk row sheds
 * SCENE_WAVES chips to the left or right of the trunk, which drop off the perch before the scene
 * ends. Deterministic like `chipsAt`.
 */
export function sceneChipsAt(frame: number): Chip[] {
	const chips: Chip[] = [];
	if (frame < 0 || frame >= SCENE_FRAMES) return chips;
	for (let row = 0; row < PERCH_HEIGHT; row++) {
		for (let wave = 0; wave < SCENE_WAVES; wave++) {
			const shed = wave * 3 + Math.floor(unit(row, wave, 5) * 3);
			const age = frame - shed;
			if (age < 0) continue;
			const y = row + Math.floor(0.25 * age * age + 0.5 * age);
			if (y >= PERCH_HEIGHT) continue;
			const drift = age >= 2 ? 1 : 0;
			const x = unit(row, wave, 6) < 0.5 ? TRUNK_X - 1 - drift : CHIPS_X + drift;
			chips.push({ x, y, char: age === 0 ? "'" : age % 2 === 1 ? "." : "'" });
		}
	}
	return chips;
}

// ---------------------------------------------------------------- bubble

export interface Bubble {
	text: string;
	color: BirdColor;
}

/** What the bird did in the run: `pecked 3, drummed 5`; empty when it neither pecked nor drummed. */
function tallyText(state: BirdState): string {
	const parts: string[] = [];
	if (state.tally.peck) parts.push(`pecked ${state.tally.peck}`);
	if (state.tally.drum) parts.push(`drummed ${state.tally.drum}`);
	return parts.join(", ");
}

/** The cost of the run when it is more than nothing: `$0.012`. */
function runCostText(meter: MeterView | undefined): string | undefined {
	return meter?.runCost !== undefined && meter.runCost > 0 ? formatCost(meter.runCost) : undefined;
}

/**
 * The result of the last run, most important first, so cutting it to the width drops the least:
 * the outcome, the `/compact` nudge, the run's cost, the tally.
 */
function resultBubble(state: BirdState, meter: MeterView | undefined): Bubble {
	const cost = runCostText(meter);
	const text = (head: string, nudge?: string, tail?: string) => [head, nudge && `${nudge}.`, cost && (tail ? `${cost}.` : cost), tail].filter(Boolean).join(" ");
	const tally = tallyText(state);
	switch (state.outcome) {
		case "green": {
			const seconds = state.seconds ? ` in ${state.seconds}s` : "";
			return { text: text(`gate green${seconds}.`, compactNudge(state.outcome, meter?.context?.fill), tally || "tap tap!"), color: "success" };
		}
		case "red":
			return { text: text("gate red. ouch."), color: "error" };
		case "stopped":
			return { text: text("stopped. I'll wait here."), color: "muted" };
		case "done":
			return { text: text("done.", undefined, tally || undefined), color: "muted" };
		default:
			return { text: "ready when you are", color: "muted" };
	}
}

/**
 * The speech bubble's text, counts and money only; undefined while the bird sleeps. While a
 * compaction scene runs its note comes first; then, during a run, listening, the repair round, a
 * note and the activity; between runs a note and then the result.
 */
export function bubbleFor(state: BirdState, clock: PerchClock, now: number, meter?: MeterView): Bubble | undefined {
	const pose = poseOf(state);
	if (pose === "idle" && asleep(state, clock, now)) return undefined;
	const note = activeNote(meter?.note, now);
	const noteBubble = note ? { text: note.text, color: note.color } : undefined;
	if (noteBubble && sceneRunning(meter?.sceneAt, now)) return noteBubble;
	if (pose === "idle") return noteBubble ?? resultBubble(state, meter);
	if (pose === "listen") return { text: "listening to the gate...", color: "muted" };
	if (state.repair) return { text: `repair ${state.repair.round}/${state.repair.of} - hold on`, color: "warning" };
	if (noteBubble) return noteBubble;
	const frame = frameIndex(state, clock, now);
	switch (pose) {
		case "think": {
			// Padded dots, so the bubble keeps its width while they count up.
			const dots = ".".repeat(frame % 4).padEnd(3);
			const cost = runCostText(meter);
			return state.strong
				? { text: `${STRONG_MODELS[state.strong].name} is thinking${dots}${cost ? ` ${cost}` : ""}`, color: "error" }
				: { text: `hmm${dots}`, color: "muted" };
		}
		case "look":
			return { text: `looking around${state.tally.look > 1 ? ` x${state.tally.look}` : ""}`, color: "muted" };
		case "peck":
			return { text: `tap tap - peck ${state.tally.peck}`, color: "muted" };
		case "drum":
			return { text: `drrrr - drum ${state.tally.drum}`, color: "muted" };
	}
}

/** The bubble's three rows for a text, or nothing when fewer than `room` columns fit 8 characters. */
function bubbleRows(text: string, room: number): string[] {
	const fits = room - 4;
	if (fits < 8) return [];
	const shown = text.length > fits ? `${text.slice(0, fits - 3)}...` : text;
	const line = "-".repeat(shown.length + 2);
	return [`.${line}.`, `< ${shown} )`, `\`${line}'`];
}

/** The z's rising beside the trunk while the bird sleeps: a cycle of six steps. */
const SNORE: Array<Array<[number, number, string]>> = [
	[[0, 3, "z"]],
	[
		[0, 3, "z"],
		[2, 2, "z"],
	],
	[
		[0, 3, "z"],
		[2, 2, "z"],
		[4, 1, "Z"],
	],
	[
		[2, 2, "z"],
		[4, 1, "Z"],
		[6, 0, "Z"],
	],
	[
		[4, 1, "Z"],
		[6, 0, "Z"],
	],
	[],
];

// ---------------------------------------------------------------- drawing

interface Cell {
	char: string;
	color?: BirdColor;
}

/** A grid of cells, cut to its width; spaces stay unpainted, trailing spaces are dropped. */
class Canvas {
	private readonly rows: Cell[][];
	private readonly width: number;

	constructor(width: number, height: number) {
		this.width = width;
		this.rows = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ char: " " })));
	}

	/** Writes text at (x, y); with `seeThrough`, its spaces leave what is below. */
	put(x: number, y: number, text: string, color: BirdColor | ((char: string) => BirdColor), seeThrough = false): void {
		const row = this.rows[y];
		if (!row) return;
		[...text].forEach((char, i) => {
			const column = x + i;
			if (column < 0 || column >= this.width || (seeThrough && char === " ")) return;
			row[column] = { char, color: typeof color === "function" ? color(char) : color };
		});
	}

	/** Paints runs of one colour; spaces join a run when the next character has its colour. */
	lines(paint: Paint): string[] {
		return this.rows.map((row) => {
			const cells = row.slice(0, row.findLastIndex((cell) => cell.char !== " ") + 1);
			let out = "";
			let run = "";
			let runColor: BirdColor | undefined;
			const flush = () => {
				if (run) out += runColor ? paint(runColor, run) : run;
				run = "";
			};
			cells.forEach((cell, i) => {
				let color = cell.color;
				if (cell.char === " ") {
					const nextColor = cells.slice(i + 1).find((later) => later.char !== " ")?.color;
					color = runColor !== undefined && nextColor === runColor ? runColor : undefined;
				}
				if (color !== runColor) {
					flush();
					runColor = color;
				}
				run += cell.char;
			});
			flush();
			return out;
		});
	}
}

const plain: Paint = (_color, text) => text;

/**
 * The perch's lines for a terminal `width` at time `now`: PERCH_HEIGHT lines, each at most `width`
 * columns, or none below PERCH_MIN_WIDTH. With a meter view the trunk is the context gauge.
 */
export function perch(state: BirdState, clock: PerchClock, now: number, width: number, paint: Paint = plain, meter?: MeterView): string[] {
	if (width < PERCH_MIN_WIDTH) return [];
	const canvas = new Canvas(width, PERCH_HEIGHT);
	const frame = frameIndex(state, clock, now);
	const pose = poseOf(state);
	const scene = sceneRunning(meter?.sceneAt, now);
	const hole = holeFor(state.tally.peck);

	// The trunk, with the run's hole at beak height: the gauge when the meter knows the context
	// (all free while chips fall in a compaction scene), the plain bark otherwise.
	if (meter?.context) {
		gaugeCells(scene ? undefined : meter.context.fill).forEach((row, y) => {
			canvas.put(TRUNK_X, y, "|", "muted");
			(y === BEAK_ROW ? overlayHole(row, hole) : row).forEach((cell, i) => canvas.put(TRUNK_X + 1 + i, y, cell.char, cell.color));
			canvas.put(TRUNK_X + 3, y, "|", "muted");
		});
	} else {
		for (let y = 0; y < PERCH_HEIGHT; y++) {
			canvas.put(TRUNK_X, y, `|${y === BEAK_ROW ? hole : "##"}|`, (char) => (char === "|" ? "muted" : char === "#" ? "dim" : "muted"));
		}
	}

	// Chips shed in a compaction scene; the bird is drawn over them.
	if (scene && meter?.sceneAt !== undefined) {
		for (const chip of sceneChipsAt(Math.floor((now - meter.sceneAt) / SCENE_INTERVAL_MS))) canvas.put(chip.x, chip.y, chip.char, "dim");
	}

	// The bird; the crest is always red.
	const bird = birdPose(state, clock, now, frame);
	const body = birdColor(state);
	birdSprite(bird.eye, bird.away).forEach((row, y) => {
		canvas.put(bird.x, y, row, (char) => (y === 0 && char === "^" ? "error" : body), true);
	});

	for (const chip of chipsAt(pose, frame)) canvas.put(chip.x, chip.y, chip.char, "dim");

	if (asleep(state, clock, now)) {
		const step = Math.floor((now - clock.idleSince - SLEEP_AFTER_MS) / SLEEP_INTERVAL_MS) % SNORE.length;
		for (const [dx, y, z] of SNORE[step]) canvas.put(BUBBLE_X + dx, y, z, "muted");
	} else {
		const bubble = bubbleFor(state, clock, now, meter);
		const rows = bubble ? bubbleRows(bubble.text, width - BUBBLE_X) : [];
		rows.forEach((row, y) => {
			const walls = y === 1 ? [row.slice(0, 2), row.slice(2, -2), row.slice(-2)] : [row];
			canvas.put(BUBBLE_X, y, walls[0], "dim");
			if (walls.length === 3 && bubble) {
				canvas.put(BUBBLE_X + 2, y, walls[1], bubble.color);
				canvas.put(BUBBLE_X + row.length - 2, y, walls[2], "dim");
			}
		});
	}

	return canvas.lines(paint);
}
