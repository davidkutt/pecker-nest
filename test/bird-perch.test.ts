import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type BirdEvent, type BirdState, IDLE, next, type Paint } from "../extensions/lib/bird.ts";
import { type MeterView, NOTE_MS, type Note, SCENE_MS } from "../extensions/lib/bird-meter.ts";
import {
	advanceClock,
	bubbleFor,
	chipsAt,
	holeFor,
	noteInput,
	PERCH_HEIGHT,
	PERCH_MIN_WIDTH,
	type PerchClock,
	perch,
	perchInterval,
	poseOf,
	SLEEP_AFTER_MS,
	sceneChipsAt,
	startClock,
	WATCH_MS,
} from "../extensions/lib/bird-perch.ts";
import { GLM } from "../extensions/lib/router-logic.ts";

const tag: Paint = (color, text) => `<${color}>${text}</>`;
const plainPaint: Paint = (_color, text) => text;
const untag = (text: string) => text.replace(/<\/?[a-z]*>/g, "");

/** Plays events at times; returns the state and the perch clock as the extension keeps them. */
function play(...steps: Array<[number, BirdEvent]>): { state: BirdState; clock: PerchClock } {
	let state = IDLE;
	let clock = startClock(0);
	for (const [at, event] of steps) {
		const before = state;
		state = next(state, event);
		clock = advanceClock(clock, before, state, at);
	}
	return { state, clock };
}

const start = (at = 1000): Array<[number, BirdEvent]> => [
	[at, { type: "run_start" }],
	[at, { type: "turn_start" }],
];
const tool = (at: number, toolName: string): [number, BirdEvent] => [at, { type: "tool_start", toolName }];
const green = (at: number, seconds = 41): [number, BirdEvent] => [at, { type: "settled", aborted: false, gate: { ok: true, seconds } }];

/** One state for every pose and ending, with its clock. */
function everyState(): Array<{ name: string; state: BirdState; clock: PerchClock }> {
	const named = (name: string, played: { state: BirdState; clock: PerchClock }) => ({ name, ...played });
	return [
		named("idle", play()),
		named("think", play(...start())),
		named("strong", play(...start(), [1100, { type: "model", modelId: GLM }])),
		named("look", play(...start(), tool(1200, "read"), tool(1200, "grep"))),
		named("peck", play(...start(), tool(1200, "edit"), tool(1200, "write"))),
		named("drum", play(...start(), tool(1200, "bash"))),
		named("repair", play(...start(), [1300, { type: "turn_start", repair: { round: 1, of: 2 } }])),
		named("listen", play(...start(), [1400, { type: "settle_check" }])),
		named("green", play(...start(), tool(1200, "edit"), green(2000))),
		named("red", play(...start(), [2000, { type: "settled", aborted: false, gate: { ok: false } }])),
		named("stopped", play(...start(), [2000, { type: "settled", aborted: true }])),
		named("done", play(...start(), tool(1200, "bash"), [2000, { type: "settled", aborted: false }])),
	];
}

describe("perch drawing", () => {
	it("is printable ASCII, never wider than the terminal and always five rows when it draws", () => {
		for (const { name, state, clock } of everyState()) {
			for (let now = 0; now < 4000; now += 37) {
				for (const width of [0, 10, PERCH_MIN_WIDTH - 1, PERCH_MIN_WIDTH, 19, 24, 27, 30, 40, 60, 80, 120, 200]) {
					const lines = perch(state, clock, now, width, tag);
					if (width < PERCH_MIN_WIDTH) {
						assert.deepEqual(lines, [], `${name} at width ${width}`);
						continue;
					}
					assert.equal(lines.length, PERCH_HEIGHT, `${name} at width ${width}`);
					for (const line of lines.map(untag)) {
						assert.match(line, /^[\x20-\x7e]*$/, `${name}: non-ASCII ${JSON.stringify(line)}`);
						assert.ok(line.length <= width, `${name} at ${now}ms: ${line.length} > ${width}`);
						assert.doesNotMatch(line, / $/, `${name}: trailing space`);
					}
				}
			}
		}
	});

	it("keeps its text when painted and paints crest, trunk, chips and bubble apart", () => {
		const { state, clock } = play(...start(), tool(1200, "edit"));
		const painted = perch(state, clock, 1200 + 3 * 120, 80, tag);
		assert.deepEqual(painted.map(untag), perch(state, clock, 1200 + 3 * 120, 80));
		assert.ok(painted[0].includes("<error>^</>"), "red crest");
		assert.ok(painted[1].includes("<accent>( @ =></><muted>|.</><dim>#</><muted>|</><dim>'"), "bird, trunk with the hole, chip");
		assert.ok(painted[1].endsWith("<</> <muted>tap tap - peck 1</> <dim>)</>"), "bubble in one run per colour");
	});

	it("has a two-column beak that points at the trunk, and the other way when it looks out", () => {
		const { state, clock } = play(...start());
		assert.equal(perch(state, clock, 1000, 80)[1].slice(0, 15), "   ( @ =>  |##|");
		const watching = noteInput(play().clock, 100);
		assert.equal(perch(IDLE, watching, 100, 80)[1].slice(0, 15), "  <= @ )   |##|");
	});

	it("is the same for the same state and time", () => {
		for (const { state, clock } of everyState()) {
			assert.deepEqual(perch(state, clock, 2345, 80), perch(state, clock, 2345, 80));
		}
	});

	it("leaves out the bubble when it would not fit eight characters", () => {
		const { state, clock } = play();
		assert.ok(!perch(state, clock, 100, 32).join("\n").includes("<"));
		assert.ok(perch(state, clock, 100, 33).join("\n").includes("< ready..."));
		assert.ok(perch(state, clock, 100, 80)[1].endsWith("< ready when you are )"));
	});
});

describe("perch poses", () => {
	it("pecks: winds up, strikes the trunk and throws chips off it", () => {
		const { state, clock } = play(...start(), tool(1200, "edit"));
		assert.equal(poseOf(state), "peck");
		const at = (frame: number) => perch(state, clock, 1200 + frame * 120, 80)[1];
		assert.ok(at(0).startsWith("  ( @ =>   |"), "wind-up");
		assert.ok(at(3).startsWith("     ( @ =>|"), "beak on the trunk");
		assert.ok(at(3).includes("|'"), "chip at the strike");
		assert.equal(perchInterval(state, clock, 1200), 120);
	});

	it("drums faster in a repair round and in yellow", () => {
		const { state, clock } = play(...start(), [1300, { type: "turn_start", repair: { round: 1, of: 2 } }]);
		assert.equal(poseOf(state), "drum");
		assert.equal(perchInterval(state, clock, 1300), 60);
		const lines = perch(state, clock, 1300 + 60, 80, tag);
		assert.ok(lines[1].includes("<warning>( @ =></>"), "yellow bird");
		assert.ok(lines[1].includes("<warning>repair 1/2 - hold on</>"));
	});

	it("turns red and names the strong model while it thinks", () => {
		const { state, clock } = play(...start(), [1100, { type: "model", modelId: GLM }]);
		const lines = perch(state, clock, 1100, 80, tag);
		assert.ok(lines[1].includes("<error>( @ =></>"));
		assert.ok(untag(lines[1]).includes("< GLM 5.3 is thinking    )"));
	});

	it("keeps the bubble's width while the thinking dots count up", () => {
		const { state, clock } = play(...start());
		const widths = [0, 1, 2, 3].map((frame) => perch(state, clock, 1000 + frame * 350, 80)[0].length);
		assert.equal(new Set(widths).size, 1);
		assert.ok(perch(state, clock, 1000 + 3 * 350, 80)[1].includes("< hmm... )"));
	});

	it("looks around while reading and counts the looks", () => {
		const { state, clock } = play(...start(), tool(1200, "read"), tool(1200, "grep"));
		assert.ok(perch(state, clock, 1200, 80)[1].includes("( @ =>"));
		assert.ok(perch(state, clock, 1200 + 2 * 300, 80)[1].includes("<= @ )"));
		assert.equal(bubbleFor(state, clock, 1200)?.text, "looking around x2");
	});

	it("listens with the beak on the trunk while the gate runs", () => {
		const { state, clock } = play(...start(), [1400, { type: "settle_check" }]);
		assert.ok(perch(state, clock, 1400 + 400, 80)[1].startsWith("     ( O =>|"));
		assert.equal(bubbleFor(state, clock, 1400)?.text, "listening to the gate...");
	});

	it("restarts a pose's animation when the pose changes, not on every event", () => {
		const { state, clock } = play(...start(), tool(1200, "read"), tool(1500, "grep"));
		assert.equal(clock.since, 1200);
		const edit = play(...start(), tool(1200, "read"), tool(1500, "edit"));
		assert.equal(edit.clock.since, 1500);
		assert.equal(state.tally.look, 2);
	});
});

describe("perch hole and chips", () => {
	it("deepens the hole with the run's edits and starts over with the next run", () => {
		assert.deepEqual([0, 1, 2, 3, 5, 6, 9, 10, 40].map(holeFor), ["##", ".#", ".#", "o#", "o#", "O#", "O#", "()", "()"]);
		const edits = Array.from({ length: 6 }, (_, i) => tool(1200 + i, "edit"));
		const ended = play(...start(), ...edits, green(3000));
		assert.ok(perch(ended.state, ended.clock, 3000, 80)[1].includes("|O#|"), "the hole stays after the run");
		const again = play(...start(), ...edits, green(3000), ...start(4000));
		assert.ok(perch(again.state, again.clock, 4000, 80)[1].includes("|##|"));
	});

	it("throws chips only at strikes, keeps them right of the trunk and lets them fall away", () => {
		assert.deepEqual(chipsAt("think", 10), []);
		assert.deepEqual(chipsAt("peck", 2), [], "no strike yet");
		assert.ok(chipsAt("peck", 3).length >= 1);
		for (let frame = 0; frame < 200; frame++) {
			for (const chip of [...chipsAt("peck", frame), ...chipsAt("drum", frame)]) {
				assert.ok(chip.x >= 15 && chip.x <= 19, `x ${chip.x}`);
				assert.ok(chip.y >= 0 && chip.y < PERCH_HEIGHT, `y ${chip.y}`);
			}
		}
		assert.ok(chipsAt("peck", 3).every((chip) => chip.x === 15 && chip.y === 1), "chips start at the beak");
		const below = Array.from({ length: 200 }, (_, frame) => chipsAt("peck", frame)).flat().filter((chip) => chip.y > 1);
		assert.ok(below.length > 0 && below.every((chip) => chip.char === "."), "chips fall below the beak");
	});
});

describe("perch between runs", () => {
	it("says it is ready before the first run", () => {
		assert.deepEqual(bubbleFor(IDLE, startClock(0), 0), { text: "ready when you are", color: "muted" });
	});

	it("keeps the run's result with its tally", () => {
		const clockOf = (...steps: Array<[number, BirdEvent]>) => {
			const { state, clock } = play(...start(), ...steps);
			return bubbleFor(state, clock, 5000);
		};
		assert.deepEqual(clockOf(tool(1200, "edit"), tool(1300, "bash"), tool(1400, "bash"), green(2000)), {
			text: "gate green in 41s. pecked 1, drummed 2",
			color: "success",
		});
		assert.equal(clockOf(green(2000, 0))?.text, "gate green. tap tap!");
		assert.deepEqual(clockOf([2000, { type: "settled", aborted: false, gate: { ok: false } }]), { text: "gate red. ouch.", color: "error" });
		assert.equal(clockOf([2000, { type: "settled", aborted: true }])?.text, "stopped. I'll wait here.");
		assert.equal(clockOf(tool(1200, "edit"), [2000, { type: "settled", aborted: false }])?.text, "done. pecked 1");
		assert.equal(clockOf([2000, { type: "settled", aborted: false }])?.text, "done.");
	});

	it("shows the result in its eye: happy after green, crossed after red", () => {
		const happy = play(...start(), green(2000));
		assert.ok(perch(happy.state, happy.clock, 2000, 80)[1].includes("( ^ =>"));
		assert.ok(perch(happy.state, happy.clock, 2000, 80, tag)[1].includes("<accent>( ^ =></>"), "the eye is not painted like the crest");
		const red = play(...start(), [2000, { type: "settled", aborted: false, gate: { ok: false } }]);
		assert.ok(perch(red.state, red.clock, 2000, 80)[1].includes("( x =>"));
	});

	it("blinks now and then", () => {
		const { state, clock } = play();
		const eyes = Array.from({ length: 13 }, (_, frame) => perch(state, clock, frame * 300, 80)[1]);
		assert.equal(eyes.filter((row) => row.includes("( - =>")).length, 1);
	});

	it("falls asleep after five minutes without a run or a keystroke, and a keystroke wakes it", () => {
		const { state, clock } = play(...start(), green(2000));
		const awake = perch(state, clock, 2000 + SLEEP_AFTER_MS - 1, 80);
		assert.ok(awake[1].includes("< gate green"));
		const sleeping = perch(state, clock, 2000 + SLEEP_AFTER_MS + 2 * 700, 80);
		assert.ok(sleeping[1].includes("( - =>"));
		assert.ok(sleeping.join("\n").includes("z"), "snores");
		assert.ok(!sleeping.join("\n").includes("<"), "no bubble while asleep");
		assert.equal(bubbleFor(state, clock, 2000 + SLEEP_AFTER_MS), undefined);
		assert.equal(perchInterval(state, clock, 2000 + SLEEP_AFTER_MS), 700);

		const woken = noteInput(clock, 2000 + SLEEP_AFTER_MS + 5000);
		const looking = perch(state, woken, 2000 + SLEEP_AFTER_MS + 5100, 80);
		assert.ok(looking[1].includes("<= @ )"), "looks out at you while you type");
		assert.ok(perch(state, woken, 2000 + SLEEP_AFTER_MS + 5000 + WATCH_MS, 80)[1].includes("( ^ =>"), "then back to the trunk");
	});

	it("never sleeps during a run", () => {
		const { state, clock } = play(...start());
		assert.ok(!perch(state, clock, 1000 + 2 * SLEEP_AFTER_MS, 80).join("\n").includes("z"));
	});

	it("goes idle from the end of the run", () => {
		const { clock } = play(...start(), green(2000));
		assert.equal(clock.idleSince, 2000);
		assert.equal(clock.since, 2000);
	});
});

// ---------------------------------------------------------------- the meter on the perch

/** A meter view as bird.ts hands it over; `fill` null is unknown. */
const view = (fill: number | null, extra: Partial<MeterView> = {}): MeterView => ({ context: fill === null ? {} : { fill }, ...extra });
const trunk = (lines: string[]) => lines.map((line) => line.slice(11, 15));

describe("perch meter", () => {
	it("keeps every rule with a meter view: ASCII, never wider than the terminal, five rows", () => {
		const note = (at: number): Note => ({ text: "context 92% - compaction soon", color: "error", at });
		const views: MeterView[] = [
			{},
			view(null),
			view(0),
			view(0.12, { runCost: 0.004 }),
			view(0.74, { runCost: 1.5, note: note(1500) }),
			view(0.95, { runCost: 0.02, note: note(2500), sceneAt: 2500 }),
			view(3.2, { runCost: 12.345 }),
			view(null, { note: { text: "compacted from 241k (overflow)", color: "warning", at: 1000 }, sceneAt: 1000 }),
		];
		for (const { name, state, clock } of everyState()) {
			for (const meter of views) {
				for (let now = 0; now < 4000; now += 97) {
					for (const width of [0, 10, PERCH_MIN_WIDTH - 1, PERCH_MIN_WIDTH, 19, 24, 33, 40, 60, 80, 120, 200]) {
						const lines = perch(state, clock, now, width, tag, meter);
						if (width < PERCH_MIN_WIDTH) {
							assert.deepEqual(lines, [], `${name} at width ${width}`);
							continue;
						}
						assert.equal(lines.length, PERCH_HEIGHT, `${name} at width ${width}`);
						for (const line of lines.map(untag)) {
							assert.match(line, /^[\x20-\x7e]*$/, `${name}: non-ASCII ${JSON.stringify(line)}`);
							assert.ok(line.length <= width, `${name} at ${now}ms: ${line.length} > ${width}`);
							assert.doesNotMatch(line, / $/, `${name}: trailing space`);
						}
					}
				}
			}
		}
	});

	it("draws exactly as before without a view or without context usage", () => {
		for (const { state, clock } of everyState()) {
			assert.deepEqual(perch(state, clock, 2345, 80, tag, {}), perch(state, clock, 2345, 80, tag));
			assert.deepEqual(perch(state, clock, 2345, 80, tag, undefined), perch(state, clock, 2345, 80, tag));
		}
	});

	it("turns the bark into the gauge, bottom-up, with the run's hole at beak height", () => {
		const edits = play(...start(), tool(1100, "edit"), tool(1101, "edit"), tool(1102, "edit"), green(2000));
		assert.deepEqual(trunk(perch(edits.state, edits.clock, 2000, 80, plainPaint, view(0.12))), ["|::|", "|o:|", "|::|", "|::|", "|#:|"]);
		assert.deepEqual(trunk(perch(edits.state, edits.clock, 2000, 80, plainPaint, view(0.75))), ["|::|", "|o#|", "|##|", "|##|", "|##|"]);
		assert.deepEqual(trunk(perch(IDLE, startClock(0), 0, 80, plainPaint, view(null))), ["|::|", "|::|", "|::|", "|::|", "|::|"]);
	});

	it("paints filled cells by level, free cells dim, walls and hole muted", () => {
		const edits = play(...start(), tool(1100, "edit"), green(2000));
		const rows = perch(edits.state, edits.clock, 2000, 80, tag, view(0.75));
		assert.ok(rows[1].includes("<muted>|.</><warning>#</><muted>|</>"), rows[1]);
		assert.ok(rows[4].includes("<muted>|</><warning>##</><muted>|</>"), rows[4]);
		assert.ok(rows[0].includes("<muted>|</><dim>::</><muted>|</>"), rows[0]);
		assert.ok(perch(IDLE, startClock(0), 0, 80, tag, view(0.95))[4].includes("<error>##</>"));
		assert.ok(perch(IDLE, startClock(0), 0, 80, tag, view(0.3))[4].includes("<accent>##</>"));
	});
});

describe("perch meter bubbles", () => {
	const note = (text: string, at: number): Note => ({ text, color: "warning", at });

	it("puts a note over the activity, but not over listening or a repair round", () => {
		const reading = play(...start(), tool(1200, "read"));
		const up = view(0.74, { note: note("context 74% of 249k", 1300) });
		assert.equal(bubbleFor(reading.state, reading.clock, 1300, up)?.text, "context 74% of 249k");
		assert.equal(bubbleFor(reading.state, reading.clock, 1300 + 4000, up)?.text, "looking around", "gone after four seconds");
		const listen = play(...start(), [1250, { type: "settle_check" }]);
		assert.equal(bubbleFor(listen.state, listen.clock, 1300, up)?.text, "listening to the gate...");
		const repair = play(...start(), [1250, { type: "turn_start", repair: { round: 1, of: 2 } }]);
		assert.equal(bubbleFor(repair.state, repair.clock, 1300, up)?.text, "repair 1/2 - hold on");
	});

	it("shows a note between runs before the result, and none while asleep", () => {
		const ended = play(...start(), green(2000));
		const failed = view(0.4, { note: { text: "compaction failed", color: "error", at: 3000 } });
		assert.deepEqual(bubbleFor(ended.state, ended.clock, 3000, failed), { text: "compaction failed", color: "error" });
		assert.equal(bubbleFor(ended.state, ended.clock, 7000, failed)?.text, "gate green in 41s. tap tap!");
		const late = view(0.4, { note: { text: "compaction failed", color: "error", at: 2000 + SLEEP_AFTER_MS } });
		assert.equal(bubbleFor(ended.state, ended.clock, 2000 + SLEEP_AFTER_MS + 1, late), undefined);
	});

	it("adds the run's cost to the strong model's thinking", () => {
		const { state, clock } = play(...start(), [1100, { type: "model", modelId: GLM }]);
		assert.deepEqual(bubbleFor(state, clock, 1100 + 3 * 350, view(0.2, { runCost: 0.012 })), { text: "GLM 5.3 is thinking... $0.012", color: "error" });
		assert.equal(bubbleFor(state, clock, 1100, view(0.2, { runCost: 0.012 }))?.text, "GLM 5.3 is thinking    $0.012", "the dots keep the width");
		assert.equal(bubbleFor(state, clock, 1100, view(0.2, { runCost: 0 }))?.text, "GLM 5.3 is thinking   ");
		const flash = play(...start());
		assert.equal(bubbleFor(flash.state, flash.clock, 1000, view(0.2, { runCost: 0.012 }))?.text, "hmm   ");
	});

	it("says the result with the nudge, the cost and the tally, in that order", () => {
		const result = (meter: MeterView, ...steps: Array<[number, BirdEvent]>) => {
			const { state, clock } = play(...start(), ...steps);
			return bubbleFor(state, clock, 9000, meter)?.text;
		};
		const tally: Array<[number, BirdEvent]> = [tool(1100, "edit"), tool(1101, "edit"), tool(1102, "edit"), tool(1103, "bash")];
		assert.equal(result(view(0.78, { runCost: 0.012 }), ...tally, green(2000)), "gate green in 41s. /compact? (78%). $0.012. pecked 3, drummed 1");
		assert.equal(result(view(0.78), ...tally, green(2000)), "gate green in 41s. /compact? (78%). pecked 3, drummed 1");
		assert.equal(result(view(0.5, { runCost: 0.012 }), ...tally, green(2000)), "gate green in 41s. $0.012. pecked 3, drummed 1");
		assert.equal(result(view(0.78, { runCost: 0.012 }), green(2000)), "gate green in 41s. /compact? (78%). $0.012. tap tap!");
		assert.equal(result(view(null, { runCost: 0.012 }), green(2000)), "gate green in 41s. $0.012. tap tap!", "no nudge while unknown");
		assert.equal(result(view(0.95, { runCost: 0.02 }), [2000, { type: "settled", aborted: false, gate: { ok: false } }]), "gate red. ouch. $0.020");
		assert.equal(result(view(0.95), [2000, { type: "settled", aborted: false, gate: { ok: false } }]), "gate red. ouch.");
		assert.equal(result(view(0.95, { runCost: 0.004 }), [2000, { type: "settled", aborted: true }]), "stopped. I'll wait here. $0.004");
		assert.equal(result(view(0.95, { runCost: 0.004 }), tool(1100, "edit"), [2000, { type: "settled", aborted: false }]), "done. $0.004. pecked 1");
		assert.equal(result(view(0.95, { runCost: 0.004 }), [2000, { type: "settled", aborted: false }]), "done. $0.004");
		assert.equal(result(view(0.95, { runCost: 0 }), [2000, { type: "settled", aborted: false }]), "done.");
	});

	it("cuts the result from the end, so the tally goes first and the nudge last", () => {
		const { state, clock } = play(...start(), tool(1100, "edit"), tool(1101, "bash"), green(2000));
		const meter = view(0.78, { runCost: 0.012 });
		const bubble = (width: number) => perch(state, clock, 9000, width, plainPaint, meter)[1].slice(21);
		assert.equal(bubble(200), "< gate green in 41s. /compact? (78%). $0.012. pecked 1, drummed 1 )");
		assert.equal(bubble(75), "< gate green in 41s. /compact? (78%). $0.012. pec... )");
		assert.equal(bubble(63), "< gate green in 41s. /compact? (78%).... )");
	});
});

describe("perch compaction scene", () => {
	const scene = view(null, { note: { text: "compacted from 241k", color: "accent", at: 5000 }, sceneAt: 5000 });

	it("sheds chips off every trunk row for one and a half seconds, the same every time", () => {
		const frames = Array.from({ length: 20 }, (_, frame) => sceneChipsAt(frame));
		assert.deepEqual(frames, Array.from({ length: 20 }, (_, frame) => sceneChipsAt(frame)));
		const rows = new Set(frames.flatMap((chips) => chips.filter((chip) => chip.char === "'").map((chip) => chip.y)));
		assert.deepEqual(rows, new Set([0, 1, 2, 3, 4]), "every row sheds");
		for (const chip of frames.flat()) {
			assert.ok([9, 10, 15, 16].includes(chip.x), `beside the trunk: ${chip.x}`);
			assert.ok(chip.y >= 0 && chip.y < PERCH_HEIGHT);
		}
		assert.deepEqual(sceneChipsAt(-1), []);
		assert.deepEqual(sceneChipsAt(15), [], "over after 1.5 s");
	});

	it("shows the trunk free, the chips and the note, then the trunk stays unknown", () => {
		const ended = play(...start(), tool(1100, "edit"), green(2000));
		const during = perch(ended.state, ended.clock, 5000 + 300, 80, plainPaint, { ...scene, context: { fill: 0.9 } });
		assert.deepEqual(trunk(during), ["|::|", "|.:|", "|::|", "|::|", "|::|"], "all free while chips fall");
		assert.ok(during[1].includes("< compacted from 241k )"));
		assert.ok(during.join("\n").match(/['.]/g)!.length > 1, "chips in the air");
		const after = perch(ended.state, ended.clock, 5000 + SCENE_MS, 80, plainPaint, scene);
		assert.deepEqual(trunk(after), ["|::|", "|.:|", "|::|", "|::|", "|::|"]);
		assert.ok(after[1].includes("< compacted from 241k )"), "the note stays up for its four seconds");
		assert.ok(perch(ended.state, ended.clock, 5000 + NOTE_MS, 80, plainPaint, scene)[1].includes("< gate green in 41s. pecked 1 )"));
	});

	it("puts the scene's note over everything while the chips fall", () => {
		const repair = play(...start(), [4000, { type: "turn_start", repair: { round: 1, of: 2 } }]);
		assert.equal(bubbleFor(repair.state, repair.clock, 5100, scene)?.text, "compacted from 241k");
		assert.equal(bubbleFor(repair.state, repair.clock, 5000 + SCENE_MS, scene)?.text, "repair 1/2 - hold on");
	});

	it("draws at the chips' rate while the scene runs, then at the pose's", () => {
		const { state, clock } = play();
		assert.equal(perchInterval(state, clock, 5100, scene), 100);
		assert.equal(perchInterval(state, clock, 5000 + SCENE_MS, scene), 300);
		const drum = play(...start(), [4000, { type: "turn_start", repair: { round: 1, of: 2 } }]);
		assert.equal(perchInterval(drum.state, drum.clock, 5100, scene), 60, "never slower than the pose");
	});

	it("keeps the bird whole over the chips", () => {
		const { state, clock } = play(...start(), [4900, { type: "tool_start", toolName: "edit" }]);
		for (let now = 5000; now < 5000 + SCENE_MS; now += 20) {
			const row = perch(state, clock, now, 80, plainPaint, scene)[1];
			assert.match(row, /\( @ =>/, `${now}: ${row}`);
		}
	});
});
