/**
 * scripts/probe-openrouter.ts with fixtures only: the key lookup, the endpoint filter, the reading
 * of raw stream chunks, and the report. The live part runs against the local OpenRouter mock, so
 * these tests also pin that the probe's requests have the shape Pi sends. No real API call.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { FLASH, GLM, KIMI } from "../extensions/lib/router-logic.ts";
import {
	createClient,
	endpointRows,
	type EndpointRow,
	MODELS,
	modelIdsOf,
	parseSections,
	type ProbeReport,
	probe,
	renderReport,
	replayedReasoning,
	type ReplayReport,
	replayVerdict,
	resolveKey,
	routingOf,
	runEndpoints,
	runLoop,
	runReplay,
	summarizeChunks,
	systemPrompt,
	thinkingVariants,
	totalCost,
	type TurnResult,
	zdrProviders,
} from "../scripts/probe-openrouter.ts";
import { MockOpenRouter, type MockRequest, type Reply } from "./e2e/mock-openrouter.ts";

const ROUTING = { zdr: true, data_collection: "deny", require_parameters: true };

describe("resolveKey", () => {
	const noKeychain = () => undefined;
	it("prefers PROBE_OPENROUTER_API_KEY", () => {
		assert.deepEqual(resolveKey({ PROBE_OPENROUTER_API_KEY: " sk-probe ", OPENROUTER_API_KEY: "sk-interactive" }, () => "sk-keychain"), {
			key: "sk-probe",
			source: "PROBE_OPENROUTER_API_KEY",
		});
	});
	it("falls back to the Keychain item of docker/pi-run.sh", () => {
		const asked: string[] = [];
		const result = resolveKey({}, (service) => {
			asked.push(service);
			return "sk-keychain\n";
		});
		assert.deepEqual(result, { key: "sk-keychain", source: "Keychain item pecker-nest-container-key" });
		assert.deepEqual(asked, ["pecker-nest-container-key"]);
		assert.deepEqual(resolveKey({ PI_RUN_KEYCHAIN_SERVICE: "other" }, (service) => (service === "other" ? "sk-other" : undefined)), {
			key: "sk-other",
			source: "Keychain item other",
		});
	});
	it("never uses OPENROUTER_API_KEY on its own, and says how to pass it on purpose", () => {
		const result = resolveKey({ OPENROUTER_API_KEY: "sk-interactive" }, noKeychain);
		assert.ok("error" in result);
		assert.match(result.error, /OPENROUTER_API_KEY is set but not used on its own/);
		assert.match(result.error, /fish: +env PROBE_OPENROUTER_API_KEY=\$OPENROUTER_API_KEY node scripts\/probe-openrouter\.ts/);
		assert.ok(!result.error.includes("sk-interactive"), "the key is not printed");
		const none = resolveKey({}, noKeychain);
		assert.ok("error" in none);
		assert.match(none.error, /security add-generic-password -U -a "\$USER" -s pecker-nest-container-key -w/);
		assert.doesNotMatch(none.error, /OPENROUTER_API_KEY is set/);
	});
});

describe("parseSections", () => {
	it("runs everything by default and a subset with --only", () => {
		assert.deepEqual(parseSections([]), ["endpoints", "loop", "replay", "thinking"]);
		assert.deepEqual(parseSections(["--only", "endpoints, replay"]), ["endpoints", "replay"]);
	});
	it("rejects unknown sections and arguments", () => {
		for (const argv of [["--only"], ["--only", "nope"], ["--only", "loop", "extra"], ["--all"]]) assert.ok("error" in (parseSections(argv) as object), argv.join(" "));
	});
});

// What GET /models/{author}/{slug}/endpoints answers, reduced to the fields the probe reads.
const ENDPOINTS = {
	data: {
		id: KIMI,
		name: "MoonshotAI: Kimi K3.1 Pro",
		endpoints: [
			{
				name: "Moonshot AI | moonshotai/kimi-k3.1-pro",
				model_id: "moonshotai/kimi-k3.1-pro-20261020",
				provider_name: "Moonshot AI",
				tag: "moonshotai",
				quantization: "fp8",
				supported_parameters: ["tools", "tool_choice", "reasoning", "max_tokens"],
				pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000002" },
				status: 0,
			},
			{
				name: "Cheap | moonshotai/kimi-k3.1-pro",
				provider_name: "Cheap Inference",
				tag: "cheap/fp4",
				quantization: "fp4",
				supported_parameters: ["tools", "reasoning"],
				pricing: { prompt: "0.000001", completion: "0.000004" },
				status: 0,
			},
			{
				name: "NoTools | moonshotai/kimi-k3.1-pro",
				provider_name: "NoTools",
				quantization: null,
				supported_parameters: ["max_tokens", "include_reasoning"],
				pricing: { prompt: "0.0000005", completion: "0.000002" },
				status: -2,
			},
		],
	},
};
const ZDR_LIST = {
	data: [
		{ name: "Moonshot AI | kimi", model_id: "moonshotai/kimi-k3.1-pro-20261020", provider_name: "Moonshot AI", tag: "moonshotai" },
		{ name: "Other | glm", model_id: "z-ai/glm-5.3", provider_name: "Cheap Inference", tag: "cheap/fp4" },
	],
};

describe("endpoints", () => {
	const row = (rows: EndpointRow[], provider: string) => rows.find((candidate) => candidate.provider === provider)!;

	it("reads the routing block from models.json", () => {
		assert.deepEqual(routingOf({ providers: { openrouter: { compat: { openRouterRouting: ROUTING } } } }), ROUTING);
		assert.deepEqual(routingOf({}), {});
	});

	it("collects the IDs a model goes by and its providers in the ZDR list", () => {
		const ids = modelIdsOf(KIMI, ENDPOINTS);
		assert.deepEqual(ids, [KIMI, "moonshotai/kimi-k3.1-pro-20261020"]);
		assert.deepEqual(zdrProviders(ZDR_LIST, ids), { providers: ["Moonshot AI", "moonshotai"], total: 2 });
		assert.deepEqual(zdrProviders(ZDR_LIST.data, ids)?.providers, ["Moonshot AI", "moonshotai"], "a bare array is read too");
		assert.equal(zdrProviders({ error: { message: "management keys only" } }, ids), undefined, "no list, no verdict");
		assert.equal(zdrProviders(undefined, ids), undefined);
	});

	it("applies zdr and require_parameters and says why an endpoint is out", () => {
		const rows = endpointRows(ENDPOINTS, ROUTING, zdrProviders(ZDR_LIST, modelIdsOf(KIMI, ENDPOINTS)));
		assert.equal(rows.length, 3);
		assert.deepEqual(row(rows, "Moonshot AI"), {
			provider: "Moonshot AI",
			quantization: "fp8",
			tools: true,
			reasoning: true,
			input: 2,
			output: 10,
			cacheRead: 0.19999999999999998,
			status: "0",
			zdr: "yes",
			remains: "yes",
			note: "",
		});
		assert.equal(row(rows, "Cheap Inference").remains, "no");
		assert.equal(row(rows, "Cheap Inference").note, "not ZDR", "listed as ZDR for another model only");
		assert.equal(row(rows, "NoTools").note, "no tools, not ZDR");
		assert.equal(row(rows, "NoTools").reasoning, true, "include_reasoning counts as reasoning support");
		assert.equal(row(rows, "NoTools").quantization, "unknown");
		assert.equal(row(rows, "NoTools").cacheRead, undefined);
	});

	it("leaves ZDR undecided when the ZDR list is not available", () => {
		const rows = endpointRows(ENDPOINTS, ROUTING, undefined);
		assert.deepEqual(rows.map((candidate) => [candidate.zdr, candidate.remains, candidate.note]), [
			["unknown", "unknown", "ZDR not known"],
			["unknown", "unknown", "ZDR not known"],
			["unknown", "no", "no tools"],
		]);
		const withoutZdr = endpointRows(ENDPOINTS, { require_parameters: true }, undefined);
		assert.deepEqual(withoutZdr.map((candidate) => candidate.remains), ["yes", "yes", "no"], "without zdr in the routing block nothing is undecided");
	});

	it("applies only, ignore and quantizations should David add them", () => {
		const zdr = { providers: ["Moonshot AI", "Cheap Inference", "NoTools"] };
		assert.equal(row(endpointRows(ENDPOINTS, { quantizations: ["fp8", "bf16"] }, zdr), "Cheap Inference").note, "quantization fp4 not allowed");
		assert.equal(row(endpointRows(ENDPOINTS, { only: ["moonshotai"] }, zdr), "Cheap Inference").note, "not in only");
		assert.equal(row(endpointRows(ENDPOINTS, { only: ["moonshotai"] }, zdr), "Moonshot AI").remains, "yes", "a provider slug matches its tag");
		assert.equal(row(endpointRows(ENDPOINTS, { ignore: ["cheap"] }, zdr), "Cheap Inference").note, "in ignore");
	});

	it("tolerates an unexpected response", () => {
		assert.deepEqual(endpointRows({ data: {} }, ROUTING, undefined), []);
		assert.deepEqual(endpointRows(undefined, ROUTING, undefined), []);
	});
});

describe("summarizeChunks", () => {
	it("reads provider, reasoning fields, finish reason and usage from the raw stream", () => {
		const summary = summarizeChunks([
			{ provider: "DeepInfra", choices: [{ delta: { role: "assistant", content: "" } }] },
			{ provider: "DeepInfra", choices: [{ delta: { reasoning: "Let me add.", reasoning_details: [{ type: "reasoning.text", text: "Let me add." }] } }] },
			{ choices: [{ delta: { reasoning: "" } }] },
			{ choices: [{ delta: { tool_calls: [{ index: 0 }] }, finish_reason: "tool_calls" }] },
			{
				choices: [],
				usage: { prompt_tokens: 2100, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 2048 }, completion_tokens_details: { reasoning_tokens: 41 }, cost: 0.00031 },
			},
		]);
		assert.deepEqual(summary, {
			provider: "DeepInfra",
			reasoningFields: ["reasoning", "reasoning_details"],
			usage: { prompt: 2100, cached: 2048, completion: 60, reasoning: 41, cost: 0.00031 },
			finishReason: "tool_calls",
		});
	});
	it("reports reasoning_content when a provider uses that field, and nothing for an empty stream", () => {
		assert.deepEqual(summarizeChunks([{ choices: [{ delta: { reasoning_content: "hm" } }] }]).reasoningFields, ["reasoning_content"]);
		assert.deepEqual(summarizeChunks([]), { reasoningFields: [], usage: {} });
		assert.deepEqual(summarizeChunks([{ usage: { prompt_tokens: 5 } }]).usage, { prompt: 5, cached: undefined, completion: undefined, reasoning: undefined, cost: undefined });
	});
});

describe("replayedReasoning", () => {
	it("lists the reasoning fields of each replayed assistant message", () => {
		const payload = {
			messages: [
				{ role: "system", content: "s" },
				{ role: "user", content: "u" },
				{ role: "assistant", content: null, tool_calls: [{}], reasoning: "thought", reasoning_content: "" },
				{ role: "tool", content: "5" },
				{ role: "assistant", content: null, tool_calls: [{}] },
				{ role: "assistant", content: "x", reasoning_details: [{ type: "reasoning.text" }] },
			],
		};
		assert.deepEqual(replayedReasoning(payload), ['reasoning+reasoning_content=""', "none", "reasoning_details"]);
		assert.deepEqual(replayedReasoning(undefined), []);
	});
});

const turn = (overrides: Partial<TurnResult>): TurnResult => ({ label: "turn 1", status: 200, reasoningFields: [], replayed: [], usage: {}, toolCalls: 0, ...overrides });

describe("replayVerdict", () => {
	const replay = (withError?: string, withoutError?: string): ReplayReport => ({
		model: KIMI,
		modelName: "Kimi K3.1 Pro",
		withField: turn({ ...(withError ? { error: withError } : {}) }),
		withoutField: turn({ ...(withoutError ? { error: withoutError } : {}) }),
	});
	it("confirms, relaxes or refutes the compat flag", () => {
		assert.match(replayVerdict(replay(undefined, "400: reasoning_content is missing")), /^needs the empty `reasoning_content`.*flag in `agent\/models\.json` is required/);
		assert.match(replayVerdict(replay()), /^accepts the history both ways/);
		assert.match(replayVerdict(replay("400: unexpected field")), /flag must not be set/);
		assert.match(replayVerdict(replay("404: No endpoints found", "404: No endpoints found")), /^failed both ways/);
	});
});

describe("thinkingVariants", () => {
	it("compares Pi's request with Z.ai's native field, plus PROBE_EXTRA_BODY when given", () => {
		assert.deepEqual(thinkingVariants(undefined), [
			{ variant: "A: as Pi sends it" },
			{ variant: "B: Z.ai's native field", extraBody: { thinking: { type: "enabled", clear_thinking: false } } },
		]);
		assert.deepEqual(thinkingVariants('{"reasoning":{"context":"keep"}}')[2], { variant: "C: PROBE_EXTRA_BODY", extraBody: { reasoning: { context: "keep" } } });
		assert.throws(() => thinkingVariants("{nope"), SyntaxError);
	});
});

const REPORT: ProbeReport = {
	startedAt: "2026-11-10T12:00:00.000Z",
	keySource: "Keychain item pecker-nest-container-key",
	baseUrl: "https://openrouter.ai/api/v1",
	routing: ROUTING,
	maxTokens: 1024,
	piVersion: "1.5.0",
	endpoints: {
		reports: [
			{ model: KIMI, modelName: "Kimi K3.1 Pro", rows: endpointRows(ENDPOINTS, ROUTING, zdrProviders(ZDR_LIST, modelIdsOf(KIMI, ENDPOINTS))), zdrList: { total: 2, forModel: 2 } },
			{ model: GLM, modelName: "GLM 5.3", rows: [], error: '404 {"error":{"message":"Model not found"}}' },
		],
	},
	loop: [
		{
			model: FLASH,
			modelName: "DeepSeek V4.1 Flash 1017",
			effort: "high",
			turns: [
				turn({ provider: "DeepInfra", reasoningFields: ["reasoning"], usage: { prompt: 2100, cached: 0, completion: 50, reasoning: 30, cost: 0.00035 }, finishReason: "tool_calls", toolCalls: 1 }),
				turn({
					label: "turn 2",
					provider: "DeepInfra",
					reasoningFields: ["reasoning"],
					replayed: ['reasoning+reasoning_content=""'],
					usage: { prompt: 2150, cached: 2048, completion: 40, reasoning: 20, cost: 0.00009 },
					finishReason: "tool_calls",
					toolCalls: 1,
				}),
			],
		},
		{
			model: KIMI,
			modelName: "Kimi K3.1 Pro",
			effort: "max",
			turns: [turn({ status: 404, error: '404: {"message":"No endpoints found matching your data policy (Zero data retention).","code":404}' })],
		},
	],
	replay: [
		{
			model: KIMI,
			modelName: "Kimi K3.1 Pro",
			withField: turn({ label: 'with reasoning_content=""', provider: "Moonshot AI", replayed: ['reasoning_content=""'], usage: { cost: 0.004 } }),
			withoutField: turn({ label: "without the field", status: 400, replayed: ["none"], error: '400: {"message":"Provider returned error","code":400}\nreasoning_content is missing | in tool call' }),
		},
	],
	thinking: [
		{ variant: "A: as Pi sends it", extraBody: "", turns: [turn({ usage: { prompt: 2100, cached: 0, reasoning: 300 }, estimatedCost: 0.0021 })] },
		{ variant: "B: Z.ai's native field", extraBody: '{"thinking":{"type":"enabled","clear_thinking":false}}', turns: [turn({ usage: { prompt: 2100, cached: 0, reasoning: 280, cost: 0.002 } })] },
	],
};

describe("renderReport", () => {
	const markdown = renderReport(REPORT);

	it("starts with the key source, the routing block and the cost OpenRouter reported", () => {
		assert.match(markdown, /^# OpenRouter probe 2026-11-10T12:00:00\.000Z\n/);
		assert.match(markdown, /- Key: Keychain item pecker-nest-container-key\n/);
		assert.match(markdown, /sent as `provider`: `\{"zdr":true,"data_collection":"deny","require_parameters":true\}`/);
		assert.deepEqual(totalCost(REPORT), { reported: 0.00035 + 0.00009 + 0.004 + 0.002, estimated: 0.0021, calls: 7 });
		assert.match(markdown, /- Cost: \$0\.0064 reported by OpenRouter for 7 chat request\(s\) plus about \$0\.0021 estimated by Pi/);
	});

	it("lists endpoints with quantization, tool and reasoning support, price and what remains", () => {
		assert.match(markdown, /### Kimi K3\.1 Pro \(`moonshotai\/kimi-k3\.1-pro`\)\n\n3 endpoint\(s\), 1 remain\. ZDR list: 2 entries, 2 for this model\./);
		assert.match(markdown, /\| Moonshot AI \| fp8 \| yes \| yes \| yes \| 2\.00 \/ 10\.00 \/ 0\.200 \| 0 \| yes \| – \|/);
		assert.match(markdown, /\| NoTools \| unknown \| no \| yes \| no \| 0\.50 \/ 2\.00 \/ – \| -2 \| no \| no tools, not ZDR \|/);
		assert.match(markdown, /### GLM 5\.3 \(`z-ai\/glm-5\.3`\)\n\nLookup failed, verbatim:\n\n```text\n404 \{"error":\{"message":"Model not found"\}\}\n```/);
	});

	it("shows provider, reasoning field, replay, cached and reasoning tokens per turn", () => {
		assert.match(markdown, /### DeepSeek V4\.1 Flash 1017 \(`deepseek\/deepseek-v4\.1-flash-1017`, `high`\)/);
		assert.match(markdown, /\| turn 1 \| 200 tool_calls \| DeepInfra \| reasoning \| – \| 2100 \| 0 \| 30 \| 50 \| \$0\.00035 \|/);
		assert.match(markdown, /\| turn 2 \| 200 tool_calls \| DeepInfra \| reasoning \| reasoning\+reasoning_content="" \| 2150 \| 2048 \| 20 \| 40 \| \$0\.00009 \|/);
	});

	it("prints errors verbatim", () => {
		assert.match(markdown, /\| turn 1 \| \*\*error\*\* 404 \| – \| none \|/);
		assert.match(markdown, /Error in turn 1, verbatim:\n\n```text\n404: \{"message":"No endpoints found matching your data policy \(Zero data retention\)\.","code":404\}\n```/);
		assert.match(markdown, /Error in without the field, verbatim:\n\n```text\n400: \{"message":"Provider returned error","code":400\}\nreasoning_content is missing \| in tool call\n```/);
	});

	it("gives a verdict on the replay and compares the thinking variants", () => {
		assert.match(markdown, /\| with reasoning_content="" \| 200 \| Moonshot AI \| reasoning_content="" \| \$0\.00400 \|/);
		assert.match(markdown, /Verdict: Kimi K3\.1 Pro needs the empty `reasoning_content`/);
		assert.match(markdown, /### B: Z\.ai's native field\n\nExtra body: `\{"thinking":\{"type":"enabled","clear_thinking":false\}\}`/);
		assert.match(markdown, /### A: as Pi sends it\n\nNo extra body: the request as Pi sends it\.\n\n[^\n]+\n[^\n]+\n\| turn 1 \| 200 \| – \| none \| – \| 2100 \| 0 \| 300 \| – \| ~\$0\.00210 \(Pi's estimate\) \|/);
		assert.match(markdown, /Report only: `agent\/models\.json` is unchanged\./);
	});

	it("renders only the sections that ran, and says when the ZDR list is missing", () => {
		const only = renderReport({ ...REPORT, loop: undefined, replay: undefined, thinking: undefined, endpoints: { reports: [], zdrError: "403 management keys only" } });
		assert.match(only, /## 1\. Endpoints/);
		assert.match(only, /The ZDR preview list could not be read, so ZDR is “unknown” below: `403 management keys only`/);
		assert.doesNotMatch(only, /## 2\.|## 3\.|## 4\.|- Cost:/);
	});
});

describe("the probe's requests against the mock", () => {
	// Two tool calls, then the answer: the loop the probe asks for.
	const respond = (request: MockRequest): Reply => {
		const answered = request.messages.filter((message) => message.role === "assistant").length;
		if (request.model === GLM && request.messages.some((message) => message.role === "assistant") && refuseGlmReplay) {
			return { error: { status: 400, message: "Provider returned error" } };
		}
		if (answered === 0) return { reasoning: "add first", tools: [{ name: "add", input: { a: 2, b: 3 } }] };
		if (answered === 1) return { reasoning: "add again", tools: [{ name: "add", input: { a: 5, b: 4 } }] };
		return { text: "9" };
	};
	let refuseGlmReplay = false;
	const gets: { path: string; authorization: string | undefined }[] = [];
	const mock = new MockOpenRouter(respond, {
		get: (path, headers) => {
			gets.push({ path, authorization: headers.authorization });
			if (path === `/models/${KIMI}/endpoints`) return ENDPOINTS;
			if (path === "/endpoints/zdr") return ZDR_LIST;
			return undefined;
		},
	});
	let client: Awaited<ReturnType<typeof createClient>>;
	before(async () => {
		const port = await mock.start();
		client = await createClient("sk-or-mock", { maxTokens: 256, baseUrl: `http://127.0.0.1:${port}/api/v1` });
	});
	after(async () => {
		client.dispose();
		await mock.stop();
	});

	it("sends the routing block, the router's effort and one session id, like Pi", async () => {
		mock.requests.length = 0;
		const turns = await runLoop(client, KIMI, "max", "n1");
		assert.deepEqual(turns.map((result) => [result.label, result.status, result.toolCalls, result.error]), [
			["turn 1", 200, 1, undefined],
			["turn 2", 200, 1, undefined],
			["turn 3", 200, 0, undefined],
		]);
		assert.equal(mock.requests.length, 3);
		for (const request of mock.requests) {
			assert.equal(request.model, KIMI);
			assert.equal(request.effort, "max");
			assert.deepEqual(request.routing, ROUTING, "the routing block of agent/models.json");
			assert.equal(request.sessionId, "probe-n1", "one x-session-id for the loop, for sticky routing");
			assert.deepEqual(request.toolNames, ["add"]);
		}
		assert.ok(mock.requests[0].system.startsWith("Probe n1."), "the nonce comes first, so every run starts with a cold cache");
		assert.deepEqual(turns[0].reasoningFields, ["reasoning"]);
		assert.deepEqual(turns[0].replayed, []);
		assert.deepEqual(turns[2].replayed, ['reasoning+reasoning_content=""', 'reasoning+reasoning_content=""'], "Kimi's own turns go back with their reasoning");
		assert.equal(turns[2].usage.prompt, 100);
		assert.equal(turns[2].finishReason, "stop");
		assert.equal(mock.requests[2].messages.at(-1)?.content, "9", "the tool result of 5 + 4");
	});

	it("uses high for Flash, as the router does", async () => {
		mock.requests.length = 0;
		await runLoop(client, FLASH, "high", "n2");
		assert.ok(mock.requests.every((request) => request.model === FLASH && request.effort === "high"));
		assert.deepEqual(MODELS.map((model) => [model.id, model.effort]), [
			[FLASH, "high"],
			[GLM, "max"],
			[KIMI, "max"],
		]);
	});

	it("merges an extra body field into the request without dropping what Pi sends", async () => {
		mock.requests.length = 0;
		const extra = { thinking: { type: "enabled", clear_thinking: false } };
		const turns = await runLoop(client, GLM, "max", "n3", extra);
		assert.equal(turns[0].status, 200);
		assert.equal(mock.requests.length, 3);
		for (const request of mock.requests) {
			assert.deepEqual(request.body.thinking, extra.thinking, "the extra field is in every request of the loop");
			assert.deepEqual(request.routing, ROUTING);
			assert.equal(request.effort, "max");
		}
		mock.requests.length = 0;
		await runLoop(client, GLM, "max", "n3b");
		assert.ok(mock.requests.every((request) => !("thinking" in request.body)), "the baseline sends no such field");
	});

	it("replays a Flash tool call with and without an empty reasoning_content, and reports errors verbatim", async () => {
		mock.requests.length = 0;
		refuseGlmReplay = true;
		try {
			const kimi = await runReplay(client, KIMI, "max", "n4");
			const [withField, withoutField] = mock.requests;
			const assistants = (request: MockRequest) => request.messages.filter((message) => message.role === "assistant");
			assert.equal(assistants(withField).length, 1);
			assert.ok("reasoning_content" in assistants(withField)[0], "with the compat flag Pi adds the empty field");
			assert.ok(!("reasoning_content" in assistants(withoutField)[0]), "without the flag the field is absent");
			assert.ok(!JSON.stringify(assistants(withField)).includes("I should call add"), "Flash's thinking is dropped, as after a real switch");
			assert.deepEqual(kimi.withField.replayed, ['reasoning_content=""']);
			assert.deepEqual(kimi.withoutField.replayed, ["none"]);
			assert.equal(kimi.withField.error, undefined);
			assert.notEqual(withField.sessionId, withoutField.sessionId, "the two requests do not share a session");

			const glm = await runReplay(client, GLM, "max", "n5");
			assert.equal(glm.withField.status, 400);
			assert.match(glm.withField.error ?? "", /^400: \{"message":"Provider returned error","code":400\}/);
			assert.match(replayVerdict({ model: GLM, modelName: "GLM 5.3", ...glm }), /^failed both ways/);
		} finally {
			refuseGlmReplay = false;
		}
	});

	it("reads the endpoint lists with the key and reports a failed lookup verbatim", async () => {
		gets.length = 0;
		const result = await runEndpoints(client, ROUTING);
		assert.deepEqual(gets.map((get) => get.path), ["/endpoints/zdr", ...MODELS.map((model) => `/models/${model.id}/endpoints`)]);
		assert.ok(gets.every((get) => get.authorization === "Bearer sk-or-mock"));
		assert.equal(result.zdrError, undefined);
		const kimi = result.reports.find((report) => report.model === KIMI)!;
		assert.deepEqual(kimi.rows.map((row) => row.remains), ["yes", "no", "no"]);
		assert.deepEqual(kimi.zdrList, { total: 2, forModel: 2 });
		const glm = result.reports.find((report) => report.model === GLM)!;
		assert.equal(glm.error, '404 {"error":"not found"}');
	});

	it("runs the chosen sections and renders them", async () => {
		mock.requests.length = 0;
		const stderr = process.stderr.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
		let report: ProbeReport;
		try {
			report = await probe(client, ["loop", "replay", "thinking"], { keySource: "test", maxTokens: 256, routing: ROUTING, piVersion: "1.5.0" });
		} finally {
			process.stderr.write = stderr;
		}
		assert.equal(report.endpoints, undefined);
		assert.deepEqual(report.loop?.map((loop) => [loop.model, loop.turns.length]), [
			[FLASH, 3],
			[GLM, 3],
			[KIMI, 3],
		]);
		assert.deepEqual(report.replay?.map((replay) => replay.model), [GLM, KIMI], "Flash does not take over from itself");
		assert.deepEqual(report.thinking?.map((variant) => [variant.variant, variant.turns.length]), [
			["A: as Pi sends it", 3],
			["B: Z.ai's native field", 3],
		]);
		assert.equal(mock.requests.length, 9 + 4 + 6, "19 small requests for a full run");
		const sessions = new Set(mock.requests.map((request) => request.sessionId));
		assert.equal(sessions.size, 3 + 4 + 2, "one session per loop and per replay request");
		const markdown = renderReport(report);
		for (const heading of ["## 2. Tool loop", "## 3. Cross-model replay", "## 4. GLM preserved thinking"]) assert.ok(markdown.includes(heading), heading);
		assert.doesNotMatch(markdown, /## 1\. Endpoints/);
	});

	it("keeps the system prompt long enough for provider caching", () => {
		const prompt = systemPrompt("x");
		assert.ok(prompt.length > 8000, "about 2,000 tokens");
		assert.equal(systemPrompt("x"), prompt, "the same nonce gives the same prefix, so turns 2 and 3 can hit the cache");
		assert.notEqual(systemPrompt("y").slice(0, 20), prompt.slice(0, 20));
	});
});
