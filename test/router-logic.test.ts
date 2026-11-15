import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_STATE,
	DEFAULT_STRONG,
	decide,
	failureKind,
	gateRound,
	hasImages,
	isStrong,
	levelFor,
	type MessageLike,
	readState,
	type RouteInput,
	type RouterState,
	ruledOut,
	sameState,
	shortError,
	strongByModelId,
	strongCandidates,
	strongName,
	strongOf,
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
	return { reason: "continuation", state: undefined, messages: [user()], planRequested: false, keepTier: false, strongUsable: true, ...overrides };
}

describe("levelFor", () => {
	it("runs the strong tier at max for every reason", () => {
		for (const why of ["plan", "gate", "loop", "stuck", "hard"] as const) assert.equal(levelFor("strong", why), "max", why);
	});
	it("keeps Flash at high, except for a plan that has to stay on Flash", () => {
		for (const why of ["default", "hard", "gate", "loop", "stuck"] as const) assert.equal(levelFor("flash", why), "high", why);
		assert.equal(levelFor("flash", "plan"), "max");
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
	it("plans on the strong model at max", () => {
		const result = decide(input({ reason: "user", planRequested: true }));
		assert.equal(result.tier, "strong");
		assert.equal(result.level, "max");
		assert.match(result.notice ?? "", /GLM 5\.3 at max \(plan\)/);
	});
	it("keeps the plan run on the strong model for its tool calls", () => {
		const plan: RouterState = { tier: "strong", why: "plan" };
		const result = decide(input({ state: plan, messages: [user(), ...call("read", { path: "a.ts" })] }));
		assert.equal(result.tier, "strong");
		assert.equal(result.level, "max");
		assert.equal(result.state, plan);
	});
	it("returns to Flash on the next typed prompt", () => {
		const result = decide(input({ reason: "user", state: { tier: "strong", why: "gate" } }));
		assert.equal(result.tier, "flash");
		assert.equal(result.notice, "back on DeepSeek V4.1 Flash");
	});
	it("escalates at gate repair round 2, not round 1", () => {
		assert.equal(decide(input({ messages: [user(), gate(1)] })).tier, "flash");
		const result = decide(input({ messages: [user(), gate(1), gate(2)] }));
		assert.equal(result.tier, "strong");
		assert.equal(result.level, "max");
		assert.equal(result.state.why, "gate");
		assert.match(result.notice ?? "", /GLM 5\.3 at max \(gate: quality gate still red at repair round 2\)/);
	});
	it("escalates on a loop and stays escalated for the rest of the run", () => {
		const loop = [user(), ...call("bash", { command: "a" }), ...call("bash", { command: "a" }), ...call("bash", { command: "a" })];
		const first = decide(input({ messages: loop }));
		assert.equal(first.tier, "strong");
		assert.equal(first.level, "max");
		assert.equal(first.state.why, "loop");
		const later = decide(input({ state: first.state, messages: [...loop, ...call("read", { path: "b.ts" })] }));
		assert.equal(later.tier, "strong");
		assert.equal(later.level, "max");
		assert.equal(later.state, first.state);
	});
	it("escalates at max when the agent is stuck on failed edits", () => {
		const messages = [user()];
		for (let i = 0; i < 3; i++) messages.push(...call("edit", { path: "a.ts", edits: [i] }, true));
		const result = decide(input({ messages }));
		assert.equal(result.state.why, "stuck");
		assert.equal(result.level, "max");
		assert.match(result.notice ?? "", /GLM 5\.3 at max \(stuck: 3 failed edits on a\.ts\)/);
	});
	it("keeps the tier for steering and follow-up messages", () => {
		const escalated: RouterState = { tier: "strong", why: "loop" };
		assert.equal(decide(input({ reason: "user", state: escalated, keepTier: true })).tier, "strong");
	});
	it("/hard keeps the strong model on across prompts until /flash", () => {
		const hard = decide(input({ reason: "user", hard: true }));
		assert.deepEqual(hard.state, { tier: "strong", why: "hard", sticky: true });
		assert.equal(hard.level, "max");
		assert.match(hard.notice ?? "", /GLM 5\.3 at max \(hard\)/);
		const again = decide(input({ reason: "user", state: hard.state }));
		assert.equal(again.tier, "strong");
		assert.equal(again.level, "max");
		const plan = decide(input({ reason: "user", state: hard.state, planRequested: true }));
		assert.deepEqual(plan.state, { tier: "strong", why: "plan", sticky: true });
		const afterPlan = decide(input({ reason: "user", state: plan.state }));
		assert.equal(afterPlan.state.why, "hard");
		const flash = decide(input({ reason: "user", state: hard.state, hard: false }));
		assert.deepEqual(flash.state, DEFAULT_STATE);
	});
	it("stays on Flash when the strong model cannot take the conversation, and says so once", () => {
		const loop = [user(), ...call("bash", { command: "a" }), ...call("bash", { command: "a" }), ...call("bash", { command: "a" })];
		const result = decide(input({ messages: loop, strongUsable: false }));
		assert.equal(result.tier, "flash");
		assert.equal(result.state.tier, "strong", "the session still records that it wanted the strong model");
		assert.equal(result.level, "high", "Flash stays at high when it has to take an escalation itself");
		assert.match(result.notice ?? "", /staying on DeepSeek V4\.1 Flash/);
		const later = decide(input({ state: result.state, messages: loop, strongUsable: false }));
		assert.equal(later.notice, undefined);
	});
	it("plans on Flash at max when the conversation has images", () => {
		const result = decide(input({ reason: "user", planRequested: true, strongUsable: false }));
		assert.equal(result.tier, "flash");
		assert.equal(result.level, "max");
	});
});

describe("strong model selection", () => {
	it("knows the two choices and their names", () => {
		assert.equal(DEFAULT_STRONG, "glm");
		assert.ok(isStrong("glm") && isStrong("kimi"));
		for (const bad of ["GLM", "flash", "", undefined, null, 1]) assert.equal(isStrong(bad), false, String(bad));
		assert.equal(strongName("glm"), "GLM 5.3");
		assert.equal(strongName("kimi"), "Kimi K3.1 Pro");
	});
	it("defaults to GLM and reads back an explicit choice", () => {
		assert.equal(strongOf(undefined), "glm");
		assert.equal(strongOf({ tier: "flash", why: "default" }), "glm");
		assert.equal(strongOf({ tier: "strong", why: "hard", strong: "kimi" }), "kimi");
	});
});

describe("readState", () => {
	it("reads a state written before /strong existed, where the tier was named glm", () => {
		assert.deepEqual(readState({ tier: "glm", why: "gate" }), { tier: "strong", why: "gate" });
		assert.deepEqual(readState({ tier: "glm", why: "hard", sticky: true }), { tier: "strong", why: "hard", sticky: true });
		assert.equal(strongOf(readState({ tier: "glm", why: "plan" })), "glm");
	});
	it("reads a current state unchanged", () => {
		assert.deepEqual(readState({ tier: "strong", why: "plan", strong: "kimi" }), { tier: "strong", why: "plan", strong: "kimi" });
		assert.deepEqual(readState({ tier: "flash", why: "default" }), { tier: "flash", why: "default" });
	});
	it("is undefined for nothing and tolerates junk", () => {
		assert.equal(readState(undefined), undefined);
		assert.equal(readState(null), undefined);
		assert.equal(readState("glm"), undefined);
		assert.deepEqual(readState({}), { tier: "flash", why: "default" });
		assert.deepEqual(readState({ tier: "kimi", why: "nonsense", strong: "other" }), { tier: "flash", why: "default" });
	});
});

describe("decide with /strong kimi", () => {
	it("plans on Kimi at max and names it in the notice", () => {
		const result = decide(input({ reason: "user", planRequested: true, strong: "kimi" }));
		assert.equal(result.tier, "strong");
		assert.equal(result.level, "max");
		assert.equal(result.strong, "kimi");
		assert.deepEqual(result.state, { tier: "strong", why: "plan", strong: "kimi" });
		assert.match(result.notice ?? "", /Kimi K3\.1 Pro at max \(plan\)/);
	});
	it("remembers the choice across prompts, so an escalation also uses it", () => {
		const chosen = decide(input({ reason: "user", strong: "kimi" }));
		assert.equal(chosen.tier, "flash", "/strong alone does not escalate");
		assert.deepEqual(chosen.state, { tier: "flash", why: "default", strong: "kimi" });
		const loop = [user(), ...call("bash", { command: "a" }), ...call("bash", { command: "a" }), ...call("bash", { command: "a" })];
		const escalated = decide(input({ state: chosen.state, messages: loop }));
		assert.equal(escalated.tier, "strong");
		assert.equal(escalated.strong, "kimi");
		assert.equal(escalated.state.strong, "kimi");
		assert.equal(escalated.level, "max");
		assert.match(escalated.notice ?? "", /Kimi K3\.1 Pro at max \(loop:/);
	});
	it("/strong glm goes back and drops the marker from the state", () => {
		const kimi: RouterState = { tier: "flash", why: "default", strong: "kimi" };
		const back = decide(input({ reason: "user", state: kimi, strong: "glm" }));
		assert.deepEqual(back.state, DEFAULT_STATE);
		assert.equal(back.strong, "glm");
		const plan = decide(input({ reason: "user", state: kimi, strong: "glm", planRequested: true }));
		assert.deepEqual(plan.state, { tier: "strong", why: "plan" });
		assert.match(plan.notice ?? "", /GLM 5\.3 at max \(plan\)/);
	});
	it("keeps the choice through /hard and the plan that follows it", () => {
		const hard = decide(input({ reason: "user", hard: true, strong: "kimi" }));
		assert.deepEqual(hard.state, { tier: "strong", why: "hard", sticky: true, strong: "kimi" });
		const plan = decide(input({ reason: "user", state: hard.state, planRequested: true }));
		assert.deepEqual(plan.state, { tier: "strong", why: "plan", sticky: true, strong: "kimi" });
		const afterPlan = decide(input({ reason: "user", state: plan.state }));
		assert.deepEqual(afterPlan.state, { tier: "strong", why: "hard", sticky: true, strong: "kimi" });
		const flash = decide(input({ reason: "user", state: hard.state, hard: false }));
		assert.deepEqual(flash.state, { tier: "flash", why: "default", strong: "kimi" }, "/flash ends /hard but keeps the model choice");
	});
	it("escalates a conversation with images, because Kimi reads them", () => {
		// router.ts passes strongUsable from the chosen model's `input`; with kimi it stays true.
		const loop = [
			{ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] } as MessageLike,
			...call("bash", { command: "a" }),
			...call("bash", { command: "a" }),
			...call("bash", { command: "a" }),
		];
		const kimi = decide(input({ state: { tier: "flash", why: "default", strong: "kimi" }, messages: loop, strongUsable: true }));
		assert.equal(kimi.tier, "strong");
		assert.equal(kimi.strong, "kimi");
		const glm = decide(input({ state: DEFAULT_STATE, messages: loop, strongUsable: false }));
		assert.equal(glm.tier, "flash");
		assert.match(glm.notice ?? "", /staying on DeepSeek V4\.1 Flash: GLM 5\.3 cannot take this conversation/);
	});
	it("names the fallback model when the chosen one is missing", () => {
		const result = decide(input({ reason: "user", planRequested: true, strong: "kimi", strongFallback: "glm" }));
		assert.equal(result.tier, "strong");
		assert.equal(result.strong, "glm", "the fallback runs");
		assert.equal(result.state.strong, "kimi", "the choice is kept, in case Kimi comes back");
		assert.match(result.notice ?? "", /GLM 5\.3 at max \(plan\)/);
	});
	it("a steering message keeps the tier but a /strong switch still lands", () => {
		const escalated: RouterState = { tier: "strong", why: "loop" };
		const steered = decide(input({ reason: "user", state: escalated, keepTier: true }));
		assert.equal(steered.state, escalated);
		const switched = decide(input({ reason: "user", state: escalated, keepTier: true, strong: "kimi" }));
		assert.equal(switched.state.strong, "kimi");
	});
});

describe("sameState", () => {
	it("compares tier, reason, stickiness and the strong model", () => {
		assert.equal(sameState(undefined, DEFAULT_STATE), false);
		assert.equal(sameState({ tier: "flash", why: "default" }, DEFAULT_STATE), true);
		assert.equal(sameState({ tier: "strong", why: "hard", sticky: true }, { tier: "strong", why: "hard" }), false);
		assert.equal(sameState({ tier: "flash", why: "default", strong: "kimi" }, DEFAULT_STATE), false);
		assert.equal(sameState({ tier: "flash", why: "default", strong: "glm" }, DEFAULT_STATE), true, "an explicit glm equals the default");
	});
});

// Error messages as Pi 1.5.0 formats them for OpenRouter: "<status>: <error body>".
const NO_ENDPOINTS = '404: {"message":"No endpoints found matching your data policy (Zero data retention). Configure: https://openrouter.ai/settings/privacy","code":404}';
const PROVIDER_400 = '400: {"message":"Provider returned error","code":400}';

describe("failureKind", () => {
	it("reads a missing endpoint as a routing failure", () => {
		assert.equal(failureKind(NO_ENDPOINTS), "routing");
		assert.equal(failureKind("No endpoints found that support tool use."), "routing");
		assert.equal(failureKind('404: {"message":"No allowed providers are available for the selected model.","code":404}'), "routing");
		assert.equal(failureKind("400: moonshotai/kimi-k9 is not a valid model ID"), "routing");
	});
	it("reads a rejected request as a request-shape failure", () => {
		assert.equal(failureKind(PROVIDER_400), "request");
		assert.equal(failureKind('400: {"message":"thinking is enabled but reasoning_content is missing in assistant tool call message at index 3","code":400}'), "request");
		assert.equal(failureKind("422 Unprocessable Entity"), "request");
		assert.equal(failureKind("Invalid request: unsupported parameter"), "request");
	});
	it("leaves rate limits, overload and server errors to Pi's retry on the same model", () => {
		assert.equal(failureKind('429: {"message":"Rate limit exceeded","code":429}'), "transient");
		assert.equal(failureKind('429: {"message":"Provider returned error","code":429}'), "transient");
		assert.equal(failureKind('502: {"message":"Provider returned error","code":502}'), "transient");
		assert.equal(failureKind("503 Service Unavailable"), "transient");
		assert.equal(failureKind("The model is overloaded"), "transient");
		assert.equal(failureKind("fetch failed"), "transient");
		assert.equal(failureKind('{"error":{"message":"Provider returned error","code":502}}'), "transient", "the status inside the error body counts");
	});
	it("does not blame the model for what another model would not fix", () => {
		assert.equal(failureKind('401: {"message":"No auth credentials found","code":401}'), "other");
		assert.equal(failureKind('402: {"message":"Insufficient credits","code":402}'), "other");
		assert.equal(failureKind('403: {"message":"Input was flagged by moderation","code":403}'), "other");
		assert.equal(failureKind("400: This endpoint's maximum context length is 1048576 tokens. However, you requested about 1200000 tokens"), "other");
		assert.equal(failureKind(undefined), "other");
		assert.equal(failureKind(""), "other");
		assert.equal(failureKind("Provider finish_reason: content_filter"), "other");
	});
});

describe("ruledOut", () => {
	const kimi = { provider: "openrouter", modelId: "moonshotai/kimi-k3.1-pro" };
	const glm = { provider: "openrouter", modelId: "z-ai/glm-5.3" };
	it("rules a strong model out for a routing or request-shape failure", () => {
		assert.deepEqual(ruledOut({ ...kimi, errorMessage: NO_ENDPOINTS }, new Set()), { strong: "kimi", kind: "routing" });
		assert.deepEqual(ruledOut({ ...glm, errorMessage: PROVIDER_400 }, new Set()), { strong: "glm", kind: "request" });
	});
	it("keeps the model for rate limits, overload and account problems", () => {
		assert.equal(ruledOut({ ...kimi, errorMessage: '429: {"message":"Rate limit exceeded","code":429}' }, new Set()), undefined);
		assert.equal(ruledOut({ ...kimi, errorMessage: "The model is overloaded" }, new Set()), undefined);
		assert.equal(ruledOut({ ...kimi, errorMessage: '402: {"message":"Insufficient credits","code":402}' }, new Set()), undefined);
	});
	it("never rules out Flash, a model of another provider, or a model twice", () => {
		assert.equal(ruledOut({ provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash-1017", errorMessage: NO_ENDPOINTS }, new Set()), undefined);
		assert.equal(ruledOut({ provider: "moonshotai", modelId: "moonshotai/kimi-k3.1-pro", errorMessage: NO_ENDPOINTS }, new Set()), undefined);
		assert.equal(ruledOut({ ...kimi, errorMessage: NO_ENDPOINTS }, new Set(["kimi"] as const)), undefined, "a second failure must not start another continuation");
	});
});

describe("strongCandidates", () => {
	it("tries the selected model, then GLM 5.3", () => {
		assert.deepEqual(strongCandidates("glm"), ["glm"]);
		assert.deepEqual(strongCandidates("kimi"), ["kimi", "glm"]);
	});
	it("skips models that were ruled out; none left means Flash", () => {
		assert.deepEqual(strongCandidates("kimi", new Set(["kimi"] as const)), ["glm"]);
		assert.deepEqual(strongCandidates("kimi", new Set(["glm"] as const)), ["kimi"]);
		assert.deepEqual(strongCandidates("kimi", new Set(["kimi", "glm"] as const)), []);
		assert.deepEqual(strongCandidates("glm", new Set(["glm"] as const)), [], "GLM never falls back to Kimi");
	});
	it("maps model IDs back to the strong choice", () => {
		assert.equal(strongByModelId("z-ai/glm-5.3"), "glm");
		assert.equal(strongByModelId("moonshotai/kimi-k3.1-pro"), "kimi");
		assert.equal(strongByModelId("deepseek/deepseek-v4.1-flash-1017"), undefined);
	});
});

describe("shortError", () => {
	it("unwraps OpenRouter's error body and keeps the status", () => {
		assert.equal(shortError(PROVIDER_400), "400: Provider returned error");
		assert.match(shortError(NO_ENDPOINTS), /^404: No endpoints found matching your data policy \(Zero data retention\)\./);
	});
	it("keeps plain messages, on one line and bounded", () => {
		assert.equal(shortError("fetch failed"), "fetch failed");
		assert.equal(shortError("a\n  b"), "a b");
		assert.equal(shortError(undefined), "no error message");
		const long = shortError("x".repeat(500), 40);
		assert.equal(long.length, 40);
		assert.ok(long.endsWith("…"));
	});
});

describe("decide after a strong model was ruled out", () => {
	it("continues a plan on the fallback at max without a second notice", () => {
		// router.ts replays the stored state as a continuation and passes the model that serves now.
		const state: RouterState = { tier: "strong", why: "plan", strong: "kimi" };
		const result = decide(input({ state, strongFallback: "glm" }));
		assert.equal(result.tier, "strong");
		assert.equal(result.level, "max");
		assert.equal(result.strong, "glm");
		assert.equal(result.state, state, "the choice is kept");
		assert.equal(result.notice, undefined, "the failure notice already said it");
	});
	it("continues an escalation on Flash at high when no strong model is left", () => {
		const state: RouterState = { tier: "strong", why: "loop", strong: "kimi" };
		const result = decide(input({ state, strongUsable: false }));
		assert.equal(result.tier, "flash");
		assert.equal(result.level, "high");
		assert.equal(result.notice, undefined);
	});
});
