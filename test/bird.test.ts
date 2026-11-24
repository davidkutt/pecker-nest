import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activityFor,
	allFrames,
	type BirdEvent,
	type BirdState,
	countGateResults,
	type EntryLike,
	FRAME_WIDTH,
	footer,
	gateResultSince,
	IDLE,
	indicator,
	next,
	type Paint,
	repairRound,
} from "../extensions/lib/bird.ts";
import { FLASH, GLM, KIMI } from "../extensions/lib/router-logic.ts";

const run = (...events: BirdEvent[]): BirdState => events.reduce(next, IDLE);
const start: BirdEvent = { type: "run_start" };

/** Marks every painted segment, so tests see which colour each part gets. */
const tag: Paint = (color, text) => `<${color}>${text}</>`;
const untag = (text: string) => text.replace(/<\/?[a-z]*>/g, "");

describe("frames", () => {
	it("are printable ASCII and all the same width", () => {
		for (const frame of allFrames()) {
			assert.match(frame, /^[\x20-\x7e]+$/, `non-ASCII frame ${JSON.stringify(frame)}`);
			assert.equal(frame.length, FRAME_WIDTH, `frame ${JSON.stringify(frame)}`);
		}
	});

	it("keep their text when painted", () => {
		const states = [run(start), run(start, { type: "model", modelId: GLM }), run(start, { type: "turn_start", repair: { round: 1, of: 2 } })];
		for (const state of states) {
			const raw = indicator(state).frames;
			assert.deepEqual(indicator(state, tag).frames.map(untag), raw);
		}
	});

	it("paint bird, trunk and chips separately and leave spaces alone", () => {
		const frames = indicator(run(start, { type: "tool_start", toolName: "bash" }), tag).frames;
		assert.equal(frames[1], "   <accent>(o></><muted>|</><dim>'</>");
	});
});

describe("indicator", () => {
	it("looks around while reading, pecks while writing, drums for bash, blinks while thinking", () => {
		assert.equal(activityFor("read"), "look");
		assert.equal(activityFor("grep"), "look");
		assert.equal(activityFor("edit"), "peck");
		assert.equal(activityFor("write"), "peck");
		assert.equal(activityFor("bash"), "drum");
		assert.equal(activityFor("subagent"), "look");
		assert.ok(indicator(run(start)).frames.some((frame) => frame.includes("(->")));
	});

	it("turns red on a strong model and back on Flash", () => {
		const strong = run(start, { type: "model", modelId: GLM });
		assert.ok(indicator(strong, tag).frames[0].includes("<error>(o></>"));
		const back = next(strong, { type: "model", modelId: FLASH });
		assert.ok(indicator(back, tag).frames[0].includes("<accent>(o></>"));
		assert.equal(back.strongUsed, "glm");
	});

	it("drums fast and yellow in a repair round, red when the strong model repairs", () => {
		const repair = run(start, { type: "turn_start", repair: { round: 1, of: 2 } });
		const flash = indicator(repair, tag);
		assert.equal(flash.intervalMs, 60);
		assert.ok(flash.frames.every((frame) => frame.includes("<warning>")));
		assert.ok(untag(flash.frames[2]).includes("|:"));
		const escalated = indicator(next(repair, { type: "model", modelId: KIMI }), tag);
		assert.ok(escalated.frames.every((frame) => frame.includes("<error>")));
	});

	it("keeps its key while the frames stay the same, so the animation is not reset", () => {
		const a = run(start, { type: "tool_start", toolName: "read" });
		const b = next(a, { type: "tool_start", toolName: "grep" });
		assert.equal(indicator(a).key, indicator(b).key);
		assert.notEqual(indicator(a).key, indicator(next(b, { type: "tool_start", toolName: "edit" })).key);
	});
});

describe("next", () => {
	it("goes back to thinking only when every parallel tool call has ended", () => {
		let state = run(start, { type: "tool_start", toolName: "read" }, { type: "tool_start", toolName: "bash" });
		state = next(state, { type: "tool_end" });
		assert.equal(state.activity, "drum");
		state = next(state, { type: "tool_end" });
		assert.equal(state.activity, "think");
		assert.equal(next(state, { type: "tool_end" }).tools, 0);
	});

	it("keeps the run's model and repair round across Pi's continuation runs", () => {
		const state = run(start, { type: "model", modelId: GLM }, { type: "turn_start", repair: { round: 2, of: 2 } }, start);
		assert.equal(state.strong, "glm");
		assert.deepEqual(state.repair, { round: 2, of: 2 });
	});

	it("starts a new run fresh but keeps the last outcome until it ends", () => {
		const ended = run(start, { type: "model", modelId: GLM }, { type: "settled", aborted: false, gate: { ok: false } });
		const again = next(ended, start);
		assert.equal(again.strongUsed, undefined);
		assert.equal(again.outcome, "red");
		assert.equal(again.running, true);
	});

	it("ends green, red, stopped or done", () => {
		const settle = (event: Extract<BirdEvent, { type: "settled" }>) => run(start, event);
		assert.equal(settle({ type: "settled", aborted: false, gate: { ok: true, seconds: 14 } }).outcome, "green");
		assert.equal(settle({ type: "settled", aborted: false, gate: { ok: true, seconds: 14 } }).seconds, 14);
		assert.equal(settle({ type: "settled", aborted: false, gate: { ok: false } }).outcome, "red");
		assert.equal(settle({ type: "settled", aborted: true, gate: { ok: true } }).outcome, "stopped");
		assert.equal(settle({ type: "settled", aborted: false }).outcome, "done");
	});

	it("listens at the trunk while the run settles", () => {
		assert.equal(run(start, { type: "settle_check" }).activity, "listen");
	});
});

describe("footer", () => {
	it("shows the bird before the first run", () => {
		assert.equal(footer(IDLE), "(o> |");
	});

	it("shows the strong model and the repair round while running", () => {
		const state = run(start, { type: "model", modelId: GLM }, { type: "turn_start", repair: { round: 1, of: 2 } });
		assert.equal(footer(state), "(o> | GLM 5.3 repair 1/2");
		assert.equal(footer(state, tag), "<error>(o></> <muted>|</> <error>GLM 5.3</> <warning>repair 1/2</>");
	});

	it("keeps the result of the last run, with the strong model that worked in it", () => {
		const green = run(start, { type: "model", modelId: KIMI }, { type: "model", modelId: FLASH }, { type: "settled", aborted: false, gate: { ok: true, seconds: 14 } });
		assert.equal(footer(green), "(o>| gate ok 14s Kimi K3.1 Pro");
		assert.equal(footer(run(start, { type: "settled", aborted: false, gate: { ok: false } })), "(x>| gate red");
		assert.equal(footer(run(start, { type: "settled", aborted: true })), "(-> | stopped");
		assert.equal(footer(run(start, { type: "settled", aborted: false })), "(o> | done");
	});

	it("listens at the trunk while the gate runs, when Pi hides the working indicator", () => {
		assert.equal(footer(run(start, { type: "settle_check" })), "(O>|");
	});

	it("leaves out seconds the gate did not round up to", () => {
		assert.equal(footer(run(start, { type: "settled", aborted: false, gate: { ok: true, seconds: 0 } })), "(o>| gate ok");
	});

	it("never uses double spaces, which Pi's footer collapses", () => {
		const states = [IDLE, run(start, { type: "model", modelId: GLM }), run(start, { type: "settled", aborted: false, gate: { ok: true } })];
		for (const state of states) assert.doesNotMatch(footer(state), / {2}/);
	});
});

describe("session entries", () => {
	const gate = (ok: boolean, seconds = 3): EntryLike => ({ type: "custom", customType: "quality-gate", data: { ok, seconds, rounds: 0 } });
	const message = (role: string): EntryLike => ({ type: "message", data: { role } });
	const repairMessage = (round: number, content: unknown = `[quality-gate] \`npm test\` failed with exit code 1. Repair round ${round} of 2.\nFix…`): EntryLike => ({
		type: "custom_message",
		customType: "quality-gate",
		content,
	});

	it("reads only the gate result written in this run", () => {
		const before = [message("user"), gate(false)];
		const baseline = countGateResults(before);
		assert.equal(baseline, 1);
		assert.equal(gateResultSince(before, baseline), undefined);
		assert.deepEqual(gateResultSince([...before, message("assistant"), gate(true, 9)], baseline), { ok: true, seconds: 9 });
	});

	it("ignores gate entries without a boolean ok", () => {
		assert.equal(gateResultSince([{ type: "custom", customType: "quality-gate", data: { command: "npm test" } }], 0), undefined);
	});

	it("finds the repair round when the branch ends with the gate's repair message", () => {
		assert.deepEqual(repairRound([message("assistant"), gate(false), repairMessage(1)]), { round: 1, of: 2 });
		assert.deepEqual(repairRound([repairMessage(2, [{ type: "text", text: "[quality-gate] x. Repair round 2 of 2." }])]), { round: 2, of: 2 });
		// Plain custom entries after the message (router state, provider log) do not hide it.
		assert.deepEqual(repairRound([repairMessage(1), { type: "custom", customType: "pi.virtual-model-state" }]), { round: 1, of: 2 });
		assert.equal(repairRound([repairMessage(1), message("assistant")]), undefined);
		assert.equal(repairRound([]), undefined);
	});
});
