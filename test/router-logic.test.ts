import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_STATE,
	decide,
	gateRound,
	hasImages,
	levelFor,
	type MessageLike,
	type RouteInput,
	type RouterState,
	sameState,
	stuckReason,
	trailingToolSteps,
} from "../extensions/lib/router-logic.ts";

const user = (text = "add a parser"): MessageLike => ({ role: "user", content: text });
const gate = (round: number): MessageLike => ({
	role: "user",
	content: [{ type: "text", text: `[quality-gate] \`npm test\` failed with exit code 1. Repair round ${round} of 2.\nFix the cause…` }],
});
let next = 0;
function call(name: string, args: Record<string, unknown>, isError = false): MessageLike[] {
	const id = `c${next++}`;
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
		{ role: "toolResult", toolCallId: id, toolName: name, isError },
	];
}

function input(overrides: Partial<RouteInput>): RouteInput {
	return { reason: "continuation", state: undefined, messages: [user()], planRequested: false, keepTier: false, glmUsable: true, ...overrides };
}

describe("levelFor", () => {
	it("plans at max and does everything else at high", () => {
		assert.equal(levelFor("plan"), "max");
		for (const why of ["default", "hard", "gate", "loop", "stuck"] as const) assert.equal(levelFor(why), "high");
	});
});

describe("hasImages", () => {
	it("finds images in user messages and tool results", () => {
		assert.equal(hasImages([user()]), false);
		assert.equal(hasImages([{ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] }]), true);
		assert.equal(hasImages([{ role: "toolResult", content: [{ type: "image" }] }]), true);
	});
});

describe("gateRound", () => {
	it("reads the repair round from the latest user-role message", () => {
		assert.equal(gateRound([user()]), 0);
		assert.equal(gateRound([user(), gate(1)]), 1);
		assert.equal(gateRound([user(), gate(1), ...call("edit", { path: "a.ts" }), gate(2)]), 2);
	});
	it("ignores an older gate message once you write again", () => {
		assert.equal(gateRound([gate(2), user("something else")]), 0);
	});
});

describe("trailingToolSteps", () => {
	it("pairs calls with results after the latest user-role message", () => {
		const steps = trailingToolSteps([...call("bash", { command: "ls" }), user(), ...call("edit", { path: "a.ts" }, true)]);
		assert.equal(steps.length, 1);
		assert.equal(steps[0].name, "edit");
		assert.equal(steps[0].path, "a.ts");
		assert.equal(steps[0].isError, true);
	});
	it("treats argument order as irrelevant", () => {
		const [a, b] = trailingToolSteps([user(), ...call("grep", { pattern: "x", path: "src" }), ...call("grep", { path: "src", pattern: "x" })]);
		assert.equal(a.key, b.key);
	});
});

describe("stuckReason", () => {
	it("is quiet for normal work", () => {
		assert.equal(stuckReason([user(), ...call("read", { path: "a.ts" }), ...call("edit", { path: "a.ts" }), ...call("bash", { command: "npm test" })]), undefined);
	});
	it("detects the same call three times in a row", () => {
		const loop = [user(), ...call("bash", { command: "npm test" }), ...call("bash", { command: "npm test" }), ...call("bash", { command: "npm test" })];
		assert.equal(stuckReason(loop)?.why, "loop");
		assert.equal(stuckReason(loop.slice(0, -2)), undefined);
	});
	it("detects three failed edits on one file, even with reads in between", () => {
		const messages = [user()];
		for (let i = 0; i < 3; i++) messages.push(...call("read", { path: "a.ts", offset: i }), ...call("edit", { path: "a.ts", edits: [i] }, true));
		assert.deepEqual(stuckReason(messages), { why: "stuck", detail: "3 failed edits on a.ts" });
	});
	it("does not count failed edits on different files", () => {
		const messages = [user(), ...call("edit", { path: "a.ts" }, true), ...call("edit", { path: "b.ts" }, true), ...call("edit", { path: "c.ts" }, true)];
		assert.equal(stuckReason(messages), undefined);
	});
	it("detects five failed tool calls in a row", () => {
		const messages = [user()];
		for (let i = 0; i < 5; i++) messages.push(...call("bash", { command: `try ${i}` }, true));
		assert.deepEqual(stuckReason(messages), { why: "stuck", detail: "5 failed tool calls in a row" });
	});
	it("starts a fresh window after a gate message", () => {
		const messages = [user(), ...call("bash", { command: "x" }), ...call("bash", { command: "x" }), gate(1), ...call("bash", { command: "x" })];
		assert.equal(stuckReason(messages), undefined);
	});
});

describe("decide", () => {
	it("starts every typed prompt on Flash at high", () => {
		const result = decide(input({ reason: "user" }));
		assert.equal(result.tier, "flash");
		assert.equal(result.level, "high");
		assert.deepEqual(result.state, DEFAULT_STATE);
		assert.equal(result.notice, undefined);
	});
	it("plans on GLM at max", () => {
		const result = decide(input({ reason: "user", planRequested: true }));
		assert.equal(result.tier, "glm");
		assert.equal(result.level, "max");
		assert.match(result.notice ?? "", /GLM 5\.3 at max \(plan\)/);
	});
	it("keeps the plan run on GLM for its tool calls", () => {
		const plan: RouterState = { tier: "glm", why: "plan" };
		const result = decide(input({ state: plan, messages: [user(), ...call("read", { path: "a.ts" })] }));
		assert.equal(result.tier, "glm");
		assert.equal(result.level, "max");
		assert.equal(result.state, plan);
	});
	it("returns to Flash on the next typed prompt", () => {
		const result = decide(input({ reason: "user", state: { tier: "glm", why: "gate" } }));
		assert.equal(result.tier, "flash");
		assert.equal(result.notice, "back on DeepSeek V4.1 Flash");
	});
	it("escalates at gate repair round 2, not round 1", () => {
		assert.equal(decide(input({ messages: [user(), gate(1)] })).tier, "flash");
		const result = decide(input({ messages: [user(), gate(1), gate(2)] }));
		assert.equal(result.tier, "glm");
		assert.equal(result.level, "high");
		assert.equal(result.state.why, "gate");
		assert.match(result.notice ?? "", /repair round 2/);
	});
	it("escalates on a loop and stays escalated for the rest of the run", () => {
		const loop = [user(), ...call("bash", { command: "a" }), ...call("bash", { command: "a" }), ...call("bash", { command: "a" })];
		const first = decide(input({ messages: loop }));
		assert.equal(first.tier, "glm");
		assert.equal(first.state.why, "loop");
		const later = decide(input({ state: first.state, messages: [...loop, ...call("read", { path: "b.ts" })] }));
		assert.equal(later.tier, "glm");
		assert.equal(later.state, first.state);
	});
	it("keeps the tier for steering and follow-up messages", () => {
		const escalated: RouterState = { tier: "glm", why: "loop" };
		assert.equal(decide(input({ reason: "user", state: escalated, keepTier: true })).tier, "glm");
	});
	it("/hard keeps GLM on across prompts until /flash", () => {
		const hard = decide(input({ reason: "user", hard: true }));
		assert.deepEqual(hard.state, { tier: "glm", why: "hard", sticky: true });
		const again = decide(input({ reason: "user", state: hard.state }));
		assert.equal(again.tier, "glm");
		const plan = decide(input({ reason: "user", state: hard.state, planRequested: true }));
		assert.deepEqual(plan.state, { tier: "glm", why: "plan", sticky: true });
		const afterPlan = decide(input({ reason: "user", state: plan.state }));
		assert.equal(afterPlan.state.why, "hard");
		const flash = decide(input({ reason: "user", state: hard.state, hard: false }));
		assert.deepEqual(flash.state, DEFAULT_STATE);
	});
	it("stays on Flash when GLM cannot take the conversation, and says so once", () => {
		const loop = [user(), ...call("bash", { command: "a" }), ...call("bash", { command: "a" }), ...call("bash", { command: "a" })];
		const result = decide(input({ messages: loop, glmUsable: false }));
		assert.equal(result.tier, "flash");
		assert.equal(result.state.tier, "glm", "the session still records that it wanted GLM");
		assert.match(result.notice ?? "", /staying on DeepSeek V4\.1 Flash/);
		const later = decide(input({ state: result.state, messages: loop, glmUsable: false }));
		assert.equal(later.notice, undefined);
	});
	it("plans on Flash at max when the conversation has images", () => {
		const result = decide(input({ reason: "user", planRequested: true, glmUsable: false }));
		assert.equal(result.tier, "flash");
		assert.equal(result.level, "max");
	});
});

describe("sameState", () => {
	it("compares tier, reason and stickiness", () => {
		assert.equal(sameState(undefined, DEFAULT_STATE), false);
		assert.equal(sameState({ tier: "flash", why: "default" }, DEFAULT_STATE), true);
		assert.equal(sameState({ tier: "glm", why: "hard", sticky: true }, { tier: "glm", why: "hard" }), false);
	});
});
