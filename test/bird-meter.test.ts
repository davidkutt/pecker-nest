import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activeNote,
	compactionPoint,
	compactNudge,
	type CostEntryLike,
	crossing,
	crossingNote,
	ctxPart,
	DEFAULT_RESERVE_TOKENS,
	formatCost,
	formatTokens,
	gaugeCells,
	levelOf,
	METER_IDLE,
	METER_USAGE,
	type MeterEvent,
	type MeterReading,
	type MeterState,
	meterOf,
	meterReport,
	NOTE_MS,
	nextMeter,
	notedAt,
	noRoom,
	overlayHole,
	percentOf,
	reportKind,
	runOf,
	SCENE_MS,
	sceneRunning,
	sessionCost,
} from "../extensions/lib/bird-meter.ts";
import type { Paint } from "../extensions/lib/bird.ts";

const tag: Paint = (color, text) => `<${color}>${text}</>`;

/** nest's settings (agent/settings.json) and the 1,048,576-token window of Flash, GLM 5.3 and Kimi K3.1 Pro. */
const NEST = { modelOverrides: { "router/escalate": { reserveTokens: 800_000 } } };
const ROUTER = { provider: "router", id: "escalate" };
const WINDOW = 1_048_576;
const POINT = compactionPoint(NEST, ROUTER, WINDOW);

const reading = (tokens: number | null, cost = 0): MeterReading => ({ context: { tokens, point: POINT }, sessionCost: cost });
/** Tokens for a fill of the nest compaction point. */
const tokensAt = (fill: number) => Math.round(fill * POINT.point);
const play = (...events: MeterEvent[]): MeterState => events.reduce(nextMeter, METER_IDLE);

describe("compaction point", () => {
	it("takes the selected model's override: nest compacts at 248,576 tokens", () => {
		assert.deepEqual(POINT, { window: WINDOW, reserve: 800_000, enabled: true, point: 248_576, source: "router/escalate" });
	});

	it("falls back to reserveTokens, then to Pi's default, like Pi's getCompactionSettings", () => {
		const flash = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017" };
		assert.deepEqual(compactionPoint({ ...NEST, reserveTokens: 50_000 }, flash, WINDOW), {
			window: WINDOW,
			reserve: 50_000,
			enabled: true,
			point: WINDOW - 50_000,
			source: "compaction.reserveTokens",
		});
		assert.equal(compactionPoint(NEST, flash, WINDOW).reserve, DEFAULT_RESERVE_TOKENS);
		assert.equal(compactionPoint(undefined, ROUTER, WINDOW).point, WINDOW - 16_384);
		assert.equal(compactionPoint(NEST, undefined, WINDOW).source, "Pi default");
		// An override without reserveTokens (only keepRecentTokens) falls through.
		assert.equal(compactionPoint({ reserveTokens: 1_000, modelOverrides: { "router/escalate": {} } }, ROUTER, WINDOW).reserve, 1_000);
		// Only the model's own key counts.
		assert.equal(compactionPoint(NEST, { provider: "constructor", id: "" }, WINDOW).source, "Pi default");
	});

	it("is the whole window without auto-compaction", () => {
		const off = compactionPoint({ ...NEST, enabled: false }, ROUTER, WINDOW);
		assert.equal(off.enabled, false);
		assert.equal(off.point, WINDOW);
		assert.equal(noRoom(off), false);
	});

	it("knows when the reserve leaves no room", () => {
		const tight = compactionPoint(NEST, ROUTER, 524_288);
		assert.equal(tight.point, 524_288 - 800_000);
		assert.ok(noRoom(tight));
		assert.ok(noRoom(compactionPoint({ reserveTokens: 1000 }, ROUTER, 1000)));
		assert.ok(!noRoom(POINT));
	});
});

describe("fill", () => {
	it("goes ok, warn from 70% and hot from 90%", () => {
		assert.deepEqual(meterOf(0, POINT.point), { fill: 0, level: "ok" });
		assert.equal(meterOf(tokensAt(0.69), POINT.point).level, "ok");
		assert.equal(meterOf(tokensAt(0.7), POINT.point).level, "warn");
		assert.equal(meterOf(tokensAt(0.89), POINT.point).level, "warn");
		assert.equal(meterOf(tokensAt(0.9), POINT.point).level, "hot");
		const over = meterOf(tokensAt(1.3), POINT.point);
		assert.equal(over.level, "hot");
		assert.ok((over.fill ?? 0) > 1);
	});

	it("is unknown right after a compaction", () => {
		assert.deepEqual(meterOf(null, POINT.point), { level: "ok" });
		assert.equal(levelOf(undefined), "ok");
	});

	it("counts no room before the point as full", () => {
		assert.deepEqual(meterOf(0, 0), { fill: 1, level: "hot" });
		assert.deepEqual(meterOf(null, -275_712), { fill: 1, level: "hot" });
	});

	it("rounds to whole percent like Pi's footer, and the level follows the number", () => {
		// Pi's footer says 2.8% of the window; that is 12% of the way to compaction.
		assert.equal(percentOf(meterOf(Math.round(0.028 * WINDOW), POINT.point).fill ?? 0), 12);
		assert.equal(percentOf(0.694), 69);
		assert.equal(levelOf(0.694), "ok");
		assert.equal(percentOf(0.696), 70);
		assert.equal(levelOf(0.696), "warn");
	});
});

describe("trunk gauge", () => {
	const chars = (fill?: number) => gaugeCells(fill).map((row) => row.map((cell) => cell.char).join(""));

	it("fills bottom-up, left cell first, ten cells in all", () => {
		assert.deepEqual(chars(0), ["::", "::", "::", "::", "::"]);
		assert.deepEqual(chars(0.12), ["::", "::", "::", "::", "#:"]);
		assert.deepEqual(chars(0.2), ["::", "::", "::", "::", "##"]);
		assert.deepEqual(chars(0.3), ["::", "::", "::", "#:", "##"]);
		assert.deepEqual(chars(0.75), ["::", "##", "##", "##", "##"]);
		assert.deepEqual(chars(1), ["##", "##", "##", "##", "##"]);
		assert.deepEqual(chars(2.5), ["##", "##", "##", "##", "##"]);
		for (let tenth = 0; tenth <= 10; tenth++) {
			assert.equal(chars(tenth / 10).join("").replaceAll(":", "").length, tenth);
		}
	});

	it("paints filled cells by level and free cells dim", () => {
		const colors = (fill: number) => new Set(gaugeCells(fill).flat().filter((cell) => cell.char === "#").map((cell) => cell.color));
		assert.deepEqual(colors(0.5), new Set(["accent"]));
		assert.deepEqual(colors(0.7), new Set(["warning"]));
		assert.deepEqual(colors(0.9), new Set(["error"]));
		assert.deepEqual(colors(1.4), new Set(["error"]));
		assert.ok(gaugeCells(0.5).flat().filter((cell) => cell.char === ":").every((cell) => cell.color === "dim"));
	});

	it("is all free and dim when the context is unknown", () => {
		assert.deepEqual(chars(undefined), ["::", "::", "::", "::", "::"]);
		assert.ok(gaugeCells(undefined).flat().every((cell) => cell.color === "dim"));
	});

	it("lays the hole over the gauge: the hole stays muted, its # show the cells", () => {
		const row = gaugeCells(0.75)[1];
		const free = gaugeCells(0.12)[1];
		const shown = (hole: string, cells = row) => overlayHole(cells, hole).map((cell) => `${cell.char}:${cell.color}`);
		assert.deepEqual(shown("##"), ["#:warning", "#:warning"]);
		assert.deepEqual(shown(".#"), [".:muted", "#:warning"]);
		assert.deepEqual(shown("o#"), ["o:muted", "#:warning"]);
		assert.deepEqual(shown("O#"), ["O:muted", "#:warning"]);
		assert.deepEqual(shown("()"), ["(:muted", "):muted"]);
		assert.deepEqual(shown("o#", free), ["o:muted", "::dim"]);
	});
});

describe("crossing notes", () => {
	it("fires once going up, not again while above, again after dropping below", () => {
		let noted = notedAt(0.5);
		const fills = [0.6, 0.72, 0.8, 0.75, 0.4, 0.71, 0.92, 0.95, 0.85, 0.91];
		const lines = fills.map((fill) => {
			const crossed = crossing(fill, noted);
			noted = crossed.noted;
			return crossed.line;
		});
		assert.deepEqual(lines, [undefined, "warn", undefined, undefined, undefined, "warn", "hot", undefined, undefined, "hot"]);
	});

	it("fires the 90% line when a jump crosses both, and changes nothing while unknown", () => {
		const jump = crossing(0.95, notedAt(0.1));
		assert.equal(jump.line, "hot");
		assert.deepEqual(jump.noted, { warn: true, hot: true });
		const noted = { warn: true, hot: false };
		assert.deepEqual(crossing(undefined, noted), { noted });
		assert.deepEqual(notedAt(undefined), { warn: false, hot: false });
	});

	it("says the percentage and the point at 70%, compaction soon at 90%", () => {
		assert.deepEqual(crossingNote("warn", 0.74, POINT.point, 5), { text: "context 74% of 249k", color: "warning", at: 5 });
		assert.deepEqual(crossingNote("hot", 0.92, POINT.point, 5), { text: "context 92% - compaction soon", color: "error", at: 5 });
	});

	it("keeps a note up for four seconds", () => {
		const note = crossingNote("warn", 0.74, POINT.point, 1000);
		assert.equal(activeNote(note, 999), undefined);
		assert.equal(activeNote(note, 1000), note);
		assert.equal(activeNote(note, 1000 + NOTE_MS - 1), note);
		assert.equal(activeNote(note, 1000 + NOTE_MS), undefined);
		assert.ok(sceneRunning(1000, 1000 + SCENE_MS - 1));
		assert.ok(!sceneRunning(1000, 1000 + SCENE_MS));
		assert.ok(!sceneRunning(undefined, 1000));
	});
});

describe("nudge and footer part", () => {
	it("nudges /compact only after a green gate with a known fill of 70% or more", () => {
		assert.equal(compactNudge("green", 0.78), "/compact? (78%)");
		assert.equal(compactNudge("green", 0.7), "/compact? (70%)");
		assert.equal(compactNudge("green", 0.69), undefined);
		assert.equal(compactNudge("green", undefined), undefined);
		for (const outcome of ["red", "stopped", "done", undefined] as const) assert.equal(compactNudge(outcome, 0.95), undefined);
	});

	it("shows ctx N% from 50%, muted, yellow from 70%, red from 90%", () => {
		assert.equal(ctxPart(0.49, tag), undefined);
		assert.equal(ctxPart(undefined, tag), undefined);
		assert.equal(ctxPart(0.5, tag), "<muted>ctx 50%</>");
		assert.equal(ctxPart(0.7, tag), "<warning>ctx 70%</>");
		assert.equal(ctxPart(0.9, tag), "<error>ctx 90%</>");
		assert.equal(ctxPart(1.04, tag), "<error>ctx 104%</>");
	});
});

describe("cost", () => {
	const usage = (total: number) => ({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
	const entries: CostEntryLike[] = [
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "assistant", usage: usage(0.02) } },
		{ type: "usage", usage: usage(0.01) },
		{ type: "message", message: { role: "toolResult", usage: usage(0.004) } },
		{ type: "message", message: { role: "toolResult" } },
		{ type: "compaction", usage: usage(0.003) },
		{ type: "compaction" },
		{ type: "branch_summary", usage: usage(0.002) },
		{ type: "branch_summary" },
		{ type: "custom" },
		{ type: "model_change" },
		// Only the entries Pi's footer counts, whatever else carries a usage.
		{ type: "message", message: { role: "user", usage: usage(5) } },
		{ type: "custom_message", usage: usage(5) },
	];

	it("sums like Pi's footer: usage entries, answers, subagent results, compactions and branch summaries", () => {
		assert.ok(Math.abs(sessionCost(entries) - 0.039) < 1e-12, String(sessionCost(entries)));
		assert.equal(sessionCost([]), 0);
		assert.equal(sessionCost([{ type: "message", message: { role: "toolResult" } }]), 0);
	});

	it("takes the run's cost as the difference to its start, and keeps it after the run", () => {
		const running = play({ type: "reset", reading: reading(0, 0.1) }, { type: "run_start", reading: reading(0, 0.1) }, { type: "read", reading: reading(1000, 0.112), at: 1 });
		assert.ok(Math.abs((running.view.runCost ?? 0) - 0.012) < 1e-12);
		const now = runOf(running, reading(1000, 0.13));
		assert.equal(now?.running, true);
		assert.ok(Math.abs((now?.cost ?? 0) - 0.03) < 1e-12);
		const ended = nextMeter(running, { type: "run_end", reading: reading(1000, 0.12), at: 2 });
		assert.ok(Math.abs((ended.view.runCost ?? 0) - 0.02) < 1e-12);
		assert.equal(ended.running, false);
		// A manual /compact between runs costs the session, not the last run.
		const compacted = nextMeter(ended, { type: "compacted", reading: reading(null, 0.15), tokensBefore: 1000, overflow: false, at: 3 });
		assert.ok(Math.abs((compacted.view.runCost ?? 0) - 0.02) < 1e-12);
		assert.ok(Math.abs((runOf(compacted, reading(null, 0.15))?.cost ?? 0) - 0.02) < 1e-12);
		assert.equal(runOf(compacted, reading(null, 0.15))?.running, false);
		assert.equal(runOf(play({ type: "reset", reading: reading(0, 0.1) }), reading(0, 0.1)), undefined);
	});

	it("formats money with three decimals below a dollar and two from a dollar", () => {
		assert.equal(formatCost(0), "$0.000");
		assert.equal(formatCost(0.0412), "$0.041");
		assert.equal(formatCost(0.0004), "$0.000");
		assert.equal(formatCost(0.9996), "$1.00");
		assert.equal(formatCost(1.234), "$1.23");
		assert.equal(formatCost(12.5), "$12.50");
	});

	it("formats tokens exactly like Pi's footer", () => {
		assert.deepEqual([850, 1_400, 9_999, 28_000, 248_576, 1_048_576, 12_400_000].map(formatTokens), ["850", "1.4k", "10.0k", "28k", "249k", "1.0M", "12M"]);
	});
});

describe("meter state", () => {
	it("starts a session without a note, even above a line", () => {
		const state = play({ type: "reset", reading: reading(tokensAt(0.8), 0.3) });
		assert.deepEqual(state.view, { context: { fill: tokensAt(0.8) / POINT.point } });
		assert.deepEqual(state.noted, { warn: true, hot: false });
		assert.equal(nextMeter(state, { type: "read", reading: reading(tokensAt(0.85)), at: 1 }).view.note, undefined);
		assert.equal(nextMeter(state, { type: "read", reading: reading(tokensAt(0.91)), at: 1 }).view.note?.text, "context 91% - compaction soon");
	});

	it("has no gauge without context usage, and an unknown one right after a compaction", () => {
		assert.deepEqual(play({ type: "reset", reading: { sessionCost: 0 } }).view, {});
		assert.deepEqual(play({ type: "reset", reading: reading(null) }).view, { context: {} });
	});

	it("puts up the crossing note with its time", () => {
		const state = play({ type: "reset", reading: reading(0) }, { type: "run_start", reading: reading(0) }, { type: "read", reading: reading(tokensAt(0.74)), at: 7000 });
		assert.deepEqual(state.view.note, { text: "context 74% of 249k", color: "warning", at: 7000 });
	});

	it("keeps the run's start through Pi's continuation runs", () => {
		const state = play({ type: "reset", reading: reading(0, 0.1) }, { type: "run_start", reading: reading(0, 0.1) }, { type: "run_start", reading: reading(0, 0.2) });
		assert.equal(state.runBaseline, 0.1);
	});

	it("starts the compaction scene with its note and forgets the fill until the next answer", () => {
		const before = play({ type: "reset", reading: reading(0) }, { type: "read", reading: reading(tokensAt(0.95)), at: 1 });
		assert.equal(before.view.note?.text, "context 95% - compaction soon");
		const after = nextMeter(before, { type: "compacted", reading: reading(null), tokensBefore: 241_000, overflow: false, at: 2000 });
		assert.deepEqual(after.view.context, {});
		assert.equal(after.view.sceneAt, 2000);
		assert.deepEqual(after.view.note, { text: "compacted from 241k", color: "accent", at: 2000 });
		assert.equal(nextMeter(before, { type: "compacted", reading: reading(null), tokensBefore: 241_000, overflow: true, at: 2000 }).view.note?.text, "compacted from 241k (overflow)");
		// The next answer is low again, which re-arms both lines.
		const low = nextMeter(after, { type: "read", reading: reading(tokensAt(0.1)), at: 3000 });
		assert.deepEqual(low.noted, { warn: false, hot: false });
		assert.equal(nextMeter(low, { type: "read", reading: reading(tokensAt(0.72)), at: 4000 }).view.note?.text, "context 72% of 249k");
	});

	it("says when a compaction failed", () => {
		assert.deepEqual(play({ type: "compact_failed", at: 9 }).view.note, { text: "compaction failed", color: "error", at: 9 });
	});
});

describe("/meter", () => {
	const at30k = reading(30_000, 0.041);
	const run = { cost: 0.012, running: true };

	it("prints context and cost, or one of them", () => {
		assert.equal(meterReport("both", at30k, run), "context 30k of 249k before compaction (12%), window 1.0M, reserve 800k - session $0.041, this run $0.012");
		assert.equal(meterReport("context", at30k, run), "context 30k of 249k before compaction (12%), window 1.0M, reserve 800k (router/escalate)");
		assert.equal(meterReport("cost", at30k, run), "session $0.041, this run $0.012");
	});

	it("says last run between runs and leaves the run out before the first", () => {
		assert.equal(meterReport("cost", at30k, { cost: 0.012, running: false }), "session $0.041, last run $0.012");
		assert.equal(meterReport("cost", at30k), "session $0.041");
	});

	it("explains an unknown context, auto-compaction off, no room and no model", () => {
		assert.equal(meterReport("context", reading(null)), "context unknown until the next answer (just compacted)");
		const off = compactionPoint({ ...NEST, enabled: false }, ROUTER, WINDOW);
		assert.equal(meterReport("both", { context: { tokens: 30_000, point: off }, sessionCost: 0 }), "context 30k of the 1.0M window (3%), auto-compaction off - session $0.000");
		const tight = compactionPoint(NEST, ROUTER, 524_288);
		assert.equal(meterReport("both", { context: { tokens: 30_000, point: tight }, sessionCost: 0 }), "reserve 800k >= window 524k: Pi compacts before every request - session $0.000");
		assert.equal(meterReport("context", { context: { tokens: null, point: tight }, sessionCost: 0 }), "reserve 800k >= window 524k: Pi compacts before every request (router/escalate)");
		assert.equal(meterReport("context", { sessionCost: 0 }), "context unknown: no model with a context window");
	});

	it("names the reserve's source", () => {
		const flash = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017" };
		const point = compactionPoint(undefined, flash, WINDOW);
		assert.match(meterReport("context", { context: { tokens: 0, point }, sessionCost: 0 }), /reserve 16k \(Pi default\)$/);
	});

	it("takes context or cost and answers anything else with the usage line", () => {
		assert.equal(reportKind(""), "both");
		assert.equal(reportKind(undefined), "both");
		assert.equal(reportKind(" Context "), "context");
		assert.equal(reportKind("cost"), "cost");
		assert.equal(reportKind("budget"), undefined);
		assert.equal(METER_USAGE, "/meter [context|cost]");
	});

	it("holds counts and money only", () => {
		const texts = [meterReport("both", at30k, run), meterReport("context", at30k), meterReport("cost", at30k, run)];
		for (const text of texts) assert.match(text, /^[\x20-\x7e]+$/);
	});
});
