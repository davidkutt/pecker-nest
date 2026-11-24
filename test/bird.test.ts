import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	activityFor,
	type BirdEvent,
	type BirdState,
	birdColor,
	countGateResults,
	type EntryLike,
	footer,
	gateResultSince,
	IDLE,
	next,
	type Paint,
	repairRound,
} from "../extensions/lib/bird.ts";
import { FLASH, GLM, KIMI } from "../extensions/lib/router-logic.ts";

const run = (...events: BirdEvent[]): BirdState => events.reduce(next, IDLE);
const start: BirdEvent = { type: "run_start" };

/** Marks every painted segment, so tests see which colour each part gets. */
const tag: Paint = (color, text) => `<${color}>${text}</>`;

describe("activity and colour", () => {
	it("looks around while reading, pecks while writing, drums for bash", () => {
		assert.equal(activityFor("read"), "look");
		assert.equal(activityFor("grep"), "look");
		assert.equal(activityFor("edit"), "peck");
		assert.equal(activityFor("write"), "peck");
		assert.equal(activityFor("bash"), "drum");
		assert.equal(activityFor("subagent"), "look");
	});

	it("turns red on a strong model and back on Flash, yellow in a repair round, red when the strong model repairs", () => {
		const strong = run(start, { type: "model", modelId: GLM });
		assert.equal(birdColor(strong), "error");
		const back = next(strong, { type: "model", modelId: FLASH });
		assert.equal(birdColor(back), "accent");
		assert.equal(back.strongUsed, "glm");
		const repair = run(start, { type: "turn_start", repair: { round: 1, of: 2 } });
		assert.equal(birdColor(repair), "warning");
		assert.equal(birdColor(next(repair, { type: "model", modelId: KIMI })), "error");
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

	it("counts the run's tool calls, keeps them after the run and starts over with the next", () => {
		const tools = ["read", "grep", "edit", "write", "edit", "bash", "subagent"].map((toolName): BirdEvent => ({ type: "tool_start", toolName }));
		const ended = run(start, ...tools, { type: "settled", aborted: false });
		assert.deepEqual(ended.tally, { look: 3, peck: 3, drum: 1 });
		assert.deepEqual(next(ended, start).tally, { look: 0, peck: 0, drum: 0 });
		// Pi's continuation runs (retries, repair rounds) belong to the same run.
		assert.deepEqual(run(start, ...tools, start).tally, { look: 3, peck: 3, drum: 1 });
	});
});

describe("footer", () => {
	it("says nothing before the first run and on Flash without a repair round", () => {
		assert.equal(footer(IDLE), undefined);
		assert.equal(footer(run(start, { type: "tool_start", toolName: "edit" })), undefined);
		assert.equal(footer(run(start, { type: "settle_check" })), undefined);
	});

	it("shows the strong model and the repair round while running, without a bird", () => {
		const state = run(start, { type: "model", modelId: GLM }, { type: "turn_start", repair: { round: 1, of: 2 } });
		assert.equal(footer(state), "GLM 5.3 repair 1/2");
		assert.equal(footer(state, tag), "<error>GLM 5.3</> <warning>repair 1/2</>");
		assert.equal(footer(run(start, { type: "turn_start", repair: { round: 2, of: 2 } })), "repair 2/2");
	});

	it("keeps the result of the last run, with the strong model that worked in it", () => {
		const green = run(start, { type: "model", modelId: KIMI }, { type: "model", modelId: FLASH }, { type: "settled", aborted: false, gate: { ok: true, seconds: 14 } });
		assert.equal(footer(green), "gate ok 14s Kimi K3.1 Pro");
		assert.equal(footer(green, tag), "<success>gate ok 14s</> <error>Kimi K3.1 Pro</>");
		assert.equal(footer(run(start, { type: "settled", aborted: false, gate: { ok: false } })), "gate red");
		assert.equal(footer(run(start, { type: "settled", aborted: true })), "stopped");
		assert.equal(footer(run(start, { type: "settled", aborted: false })), "done");
	});

	it("leaves out seconds the gate did not round up to", () => {
		assert.equal(footer(run(start, { type: "settled", aborted: false, gate: { ok: true, seconds: 0 } })), "gate ok");
	});

	it("never uses double spaces, which Pi's footer collapses", () => {
		const states = [run(start, { type: "model", modelId: GLM }, { type: "turn_start", repair: { round: 1, of: 2 } }), run(start, { type: "settled", aborted: false, gate: { ok: true } })];
		for (const state of states) {
			for (const fill of [undefined, 0.3, 0.64, 0.75, 0.95]) assert.doesNotMatch(footer(state, undefined, fill) ?? "", / {2}/);
		}
		assert.doesNotMatch(footer(IDLE, undefined, 0.64) ?? "", / {2}|^ | $/);
	});

	it("adds the context until compaction from 50%, at the end", () => {
		assert.equal(footer(IDLE, tag, 0.49), undefined);
		assert.equal(footer(IDLE, tag, undefined), undefined);
		assert.equal(footer(IDLE, tag, 0.64), "<muted>ctx 64%</>");
		assert.equal(footer(run(start, { type: "tool_start", toolName: "edit" }), tag, 0.74), "<warning>ctx 74%</>", "also on Flash while running");
		const strong = run(start, { type: "model", modelId: GLM }, { type: "turn_start", repair: { round: 1, of: 2 } });
		assert.equal(footer(strong, tag, 0.92), "<error>GLM 5.3</> <warning>repair 1/2</> <error>ctx 92%</>");
		const green = run(start, { type: "settled", aborted: false, gate: { ok: true, seconds: 14 } });
		assert.equal(footer(green, undefined, 0.5), "gate ok 14s ctx 50%");
		assert.equal(footer(green, undefined, 0.3), "gate ok 14s");
		assert.equal(footer(green, undefined, undefined), "gate ok 14s", "nothing while the context is unknown");
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
