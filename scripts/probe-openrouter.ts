/**
 * Live probe of the three configured models through OpenRouter. Nothing in this repo has been
 * tested against the real models; this turns the open questions into one report. It sends real
 * requests and costs a few cents, so David runs it, not the tests.
 *
 *   node scripts/probe-openrouter.ts                       # all four sections
 *   node scripts/probe-openrouter.ts --only endpoints      # endpoints, loop, replay, thinking (comma-separated)
 *
 * Key: PROBE_OPENROUTER_API_KEY, else the macOS Keychain item of docker/pi-run.sh
 * (pecker-nest-container-key, or PI_RUN_KEYCHAIN_SERVICE). OPENROUTER_API_KEY is never used on its
 * own; to probe with it, pass it on purpose: PROBE_OPENROUTER_API_KEY="$OPENROUTER_API_KEY".
 *
 * The chat requests go through Pi's own client (@earendil-works/pi-coding-agent's ModelRuntime
 * with agent/models.json applied), so the routing block, the reasoning effort, the session header
 * and the replay of earlier turns are exactly what Pi sends. Only the output cap is the probe's
 * (PROBE_MAX_TOKENS, default 1024) to keep the cost down. Model IDs come from router-logic.ts.
 *
 * Report: Markdown on stdout and in runs/probe-<timestamp>.md (runs/ is git-ignored).
 *   1. Endpoints: the providers OpenRouter lists per model, and which remain under the routing block
 *   2. Tool loop: three turns with one trivial tool per model
 *   3. Cross-model replay: Kimi and GLM take over a tool call Flash made, with and without an
 *      empty reasoning_content on the replayed assistant message
 *   4. GLM preserved thinking: the same loop with and without Z.ai's `clear_thinking: false`
 *
 * Environment: PROBE_OPENROUTER_API_KEY, PROBE_MAX_TOKENS, PROBE_EXTRA_BODY (JSON merged into the
 * request body as one more variant in section 4, to try a field without editing this file),
 * PROBE_BASE_URL (another API base, for tests).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, Context, Message, Model, Tool } from "@earendil-works/pi-ai";
import { FLASH, GLM, KIMI, PROVIDER } from "../extensions/lib/router-logic.ts";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SECTIONS = ["endpoints", "loop", "replay", "thinking"] as const;
export type Section = (typeof SECTIONS)[number];

/** The models as the router uses them: Flash at high, the strong tier at max. */
export const MODELS = [
	{ id: FLASH, name: "DeepSeek V4.1 Flash 1017", effort: "high" },
	{ id: GLM, name: "GLM 5.3", effort: "max" },
	{ id: KIMI, name: "Kimi K3.1 Pro", effort: "max" },
] as const;
export type Effort = "high" | "max";

// ---------------------------------------------------------------- key

export const KEYCHAIN_SERVICE = "pecker-nest-container-key";

/**
 * The probe's key: PROBE_OPENROUTER_API_KEY, else the Keychain item. An exported
 * OPENROUTER_API_KEY is not used; the error says how to pass it on purpose.
 */
export function resolveKey(
	env: Record<string, string | undefined>,
	readKeychain: (service: string) => string | undefined,
): { key: string; source: string } | { error: string } {
	const explicit = env.PROBE_OPENROUTER_API_KEY?.trim();
	if (explicit) return { key: explicit, source: "PROBE_OPENROUTER_API_KEY" };
	const service = env.PI_RUN_KEYCHAIN_SERVICE?.trim() || KEYCHAIN_SERVICE;
	const stored = readKeychain(service)?.trim();
	if (stored) return { key: stored, source: `Keychain item ${service}` };
	const lines = [
		`no key for the probe: set PROBE_OPENROUTER_API_KEY, or store the container key in the macOS Keychain:`,
		`  security add-generic-password -U -a "$USER" -s ${service} -w`,
	];
	if (env.OPENROUTER_API_KEY) {
		lines.push(
			"OPENROUTER_API_KEY is set but not used on its own. To probe with it on purpose:",
			'  bash/zsh: PROBE_OPENROUTER_API_KEY="$OPENROUTER_API_KEY" node scripts/probe-openrouter.ts',
			"  fish:     env PROBE_OPENROUTER_API_KEY=$OPENROUTER_API_KEY node scripts/probe-openrouter.ts",
		);
	}
	return { error: lines.join("\n") };
}

function readKeychain(service: string): string | undefined {
	try {
		return execFileSync("security", ["find-generic-password", "-a", process.env.USER ?? userInfo().username, "-s", service, "-w"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------- endpoints (pure)

/** The `openRouterRouting` block of agent/models.json, sent as the `provider` request field. */
export interface Routing {
	zdr?: boolean;
	data_collection?: string;
	require_parameters?: boolean;
	only?: string[];
	ignore?: string[];
	quantizations?: string[];
}

export function routingOf(modelsJson: unknown): Routing {
	const providers = (modelsJson as { providers?: Record<string, { compat?: { openRouterRouting?: Routing } }> })?.providers;
	return providers?.[PROVIDER]?.compat?.openRouterRouting ?? {};
}

export interface EndpointRow {
	provider: string;
	quantization: string;
	tools: boolean;
	reasoning: boolean;
	/** USD per million tokens. */
	input?: number;
	output?: number;
	cacheRead?: number;
	status: string;
	zdr: "yes" | "no" | "unknown";
	/** Whether the routing block leaves this endpoint; "unknown" when only ZDR is undecided. */
	remains: "yes" | "no" | "unknown";
	/** Why it is out, or what is undecided. */
	note: string;
}

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {});
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** OpenRouter prices are USD per token, as strings. */
function perMillion(value: unknown): number | undefined {
	const number = typeof value === "string" || typeof value === "number" ? Number(value) : Number.NaN;
	return Number.isFinite(number) ? number * 1_000_000 : undefined;
}

const sameName = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Which providers of a model the ZDR preview (GET /endpoints/zdr) lists. The schema of that list
 * is read loosely: an entry belongs to the model when one of its string fields is one of the
 * model's IDs. Undefined when the list could not be fetched.
 */
export function zdrProviders(zdrList: unknown, modelIds: readonly string[]): { providers: string[]; total: number } | undefined {
	const entries = Array.isArray(zdrList) ? zdrList : asRecord(zdrList).data;
	if (!Array.isArray(entries)) return undefined;
	const ids = new Set(modelIds);
	const providers: string[] = [];
	for (const entry of entries) {
		const record = asRecord(entry);
		if (!Object.values(record).some((value) => typeof value === "string" && ids.has(value))) continue;
		for (const name of [text(record.provider_name), text(record.tag)]) if (name) providers.push(name);
	}
	return { providers, total: entries.length };
}

/** The IDs under which a model appears: the requested one plus what its endpoints response names. */
export function modelIdsOf(modelId: string, endpointsResponse: unknown): string[] {
	const data = asRecord(asRecord(endpointsResponse).data);
	const ids = [modelId, text(data.id), text(data.canonical_slug), ...asArray(data.endpoints).map((endpoint) => text(asRecord(endpoint).model_id))];
	return [...new Set(ids.filter((id): id is string => id !== undefined))];
}

/**
 * One row per endpoint of GET /models/{author}/{slug}/endpoints, with the routing block applied.
 * `require_parameters` needs the parameters Pi sends (tools, reasoning); `data_collection: deny`
 * cannot be read from this list and is left to OpenRouter.
 */
export function endpointRows(endpointsResponse: unknown, routing: Routing, zdr: { providers: string[] } | undefined): EndpointRow[] {
	const endpoints = asArray(asRecord(asRecord(endpointsResponse).data).endpoints);
	return endpoints.map((endpoint) => {
		const record = asRecord(endpoint);
		const provider = text(record.provider_name) ?? text(record.tag) ?? text(record.name) ?? "?";
		const tag = text(record.tag);
		const names = [provider, ...(tag ? [tag, tag.split("/")[0]] : [])];
		const supported = asArray(record.supported_parameters).filter((value): value is string => typeof value === "string");
		const pricing = asRecord(record.pricing);
		const quantization = text(record.quantization) ?? "unknown";
		const tools = supported.includes("tools");
		const reasoning = supported.includes("reasoning") || supported.includes("include_reasoning");
		const zdrState: EndpointRow["zdr"] = !zdr ? "unknown" : zdr.providers.some((name) => names.some((own) => sameName(own, name))) ? "yes" : "no";

		const out: string[] = [];
		if (routing.require_parameters && !tools) out.push("no tools");
		if (routing.require_parameters && !reasoning) out.push("no reasoning");
		if (routing.quantizations?.length && !routing.quantizations.includes(quantization)) out.push(`quantization ${quantization} not allowed`);
		if (routing.only?.length && !routing.only.some((name) => names.some((own) => sameName(own, name)))) out.push("not in only");
		if (routing.ignore?.some((name) => names.some((own) => sameName(own, name)))) out.push("in ignore");
		if (routing.zdr && zdrState === "no") out.push("not ZDR");
		const undecided = routing.zdr && zdrState === "unknown" && out.length === 0;
		return {
			provider,
			quantization,
			tools,
			reasoning,
			input: perMillion(pricing.prompt),
			output: perMillion(pricing.completion),
			cacheRead: perMillion(pricing.input_cache_read),
			status: record.status === undefined ? "?" : String(record.status),
			zdr: zdrState,
			remains: out.length ? "no" : undecided ? "unknown" : "yes",
			note: out.length ? out.join(", ") : undecided ? "ZDR not known" : "",
		};
	});
}

// ---------------------------------------------------------------- one request (pure parts)

export interface TurnUsage {
	prompt?: number;
	cached?: number;
	completion?: number;
	reasoning?: number;
	/** USD as OpenRouter reports it in `usage.cost`. */
	cost?: number;
}

export interface ChunkSummary {
	/** The provider that served the request, from the `provider` field of the stream. */
	provider?: string;
	/** Delta fields that carried reasoning, e.g. `reasoning`, `reasoning_content`, `reasoning_details`. */
	reasoningFields: string[];
	usage: TurnUsage;
	finishReason?: string;
}

const REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text", "reasoning_details"] as const;

/** Reads the raw stream chunks of one chat completion as OpenRouter sent them. */
export function summarizeChunks(chunks: readonly unknown[]): ChunkSummary {
	const summary: ChunkSummary = { reasoningFields: [], usage: {} };
	for (const chunk of chunks) {
		const record = asRecord(chunk);
		summary.provider ??= text(record.provider);
		for (const choice of asArray(record.choices)) {
			const delta = asRecord(asRecord(choice).delta);
			for (const field of REASONING_FIELDS) {
				const value = delta[field];
				const filled = typeof value === "string" ? value.length > 0 : Array.isArray(value) && value.length > 0;
				if (filled && !summary.reasoningFields.includes(field)) summary.reasoningFields.push(field);
			}
			summary.finishReason = text(asRecord(choice).finish_reason) ?? summary.finishReason;
		}
		const usage = asRecord(record.usage);
		if (Object.keys(usage).length) {
			const number = (value: unknown) => (typeof value === "number" ? value : undefined);
			summary.usage = {
				prompt: number(usage.prompt_tokens),
				cached: number(asRecord(usage.prompt_tokens_details).cached_tokens),
				completion: number(usage.completion_tokens),
				reasoning: number(asRecord(usage.completion_tokens_details).reasoning_tokens),
				cost: number(usage.cost),
			};
		}
	}
	return summary;
}

/**
 * How the request replays earlier assistant turns: for each assistant message of the payload, the
 * reasoning fields it carries, with `=""` for an empty one. `none` means no such field.
 */
export function replayedReasoning(payload: unknown): string[] {
	return asArray(asRecord(payload).messages)
		.map(asRecord)
		.filter((message) => message.role === "assistant")
		.map((message) => {
			const fields = REASONING_FIELDS.filter((field) => field in message).map((field) => {
				const value = message[field];
				const empty = value === "" || (Array.isArray(value) && value.length === 0);
				return empty ? `${field}=""` : field;
			});
			return fields.length ? fields.join("+") : "none";
		});
}

export interface TurnResult {
	label: string;
	/** HTTP status of the response, when one arrived. */
	status?: number;
	provider?: string;
	reasoningFields: string[];
	replayed: string[];
	usage: TurnUsage;
	/** Pi's cost estimate from its catalog prices, when OpenRouter reported none. */
	estimatedCost?: number;
	finishReason?: string;
	toolCalls: number;
	/** The error, verbatim. */
	error?: string;
}

// ---------------------------------------------------------------- report (pure)

export interface EndpointsReport {
	model: string;
	modelName: string;
	rows: EndpointRow[];
	/** Entries in the ZDR preview list, in total and for this model. */
	zdrList?: { total: number; forModel: number };
	error?: string;
}

export interface LoopReport {
	model: string;
	modelName: string;
	effort: string;
	turns: TurnResult[];
}

export interface ReplayReport {
	model: string;
	modelName: string;
	withField: TurnResult;
	withoutField: TurnResult;
}

export interface ThinkingReport {
	variant: string;
	/** What was merged into the request body, as JSON; empty for the baseline. */
	extraBody: string;
	turns: TurnResult[];
}

export interface ProbeReport {
	startedAt: string;
	keySource: string;
	baseUrl: string;
	routing: Routing;
	maxTokens: number;
	piVersion: string;
	endpoints?: { reports: EndpointsReport[]; zdrError?: string };
	loop?: LoopReport[];
	replay?: ReplayReport[];
	thinking?: ThinkingReport[];
}

const cell = (value: string) => value.replaceAll("|", "\\|").replace(/\s+/g, " ").trim();
const dash = (value: number | undefined, digits?: number) => (value === undefined ? "–" : digits === undefined ? String(value) : value.toFixed(digits));
const yesNo = (value: boolean) => (value ? "yes" : "no");

function table(header: string[], rows: string[][]): string[] {
	return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)];
}

function costOf(turn: TurnResult): string {
	if (turn.usage.cost !== undefined) return `$${turn.usage.cost.toFixed(5)}`;
	if (turn.estimatedCost !== undefined) return `~$${turn.estimatedCost.toFixed(5)} (Pi's estimate)`;
	return "–";
}

function outcome(turn: TurnResult): string {
	if (turn.error) return `**error** ${turn.status ?? ""}`.trim();
	return `${turn.status ?? "ok"}${turn.finishReason ? ` ${turn.finishReason}` : ""}`;
}

function turnTable(turns: readonly TurnResult[]): string[] {
	return table(
		["Turn", "Result", "Provider", "Reasoning came in", "Earlier turns replayed as", "Prompt", "Cached", "Reasoning", "Output", "Cost"],
		turns.map((turn) => [
			turn.label,
			outcome(turn),
			turn.provider ?? "–",
			turn.reasoningFields.join(", ") || "none",
			turn.replayed.join("; ") || "–",
			dash(turn.usage.prompt),
			dash(turn.usage.cached),
			dash(turn.usage.reasoning),
			dash(turn.usage.completion),
			costOf(turn),
		]),
	);
}

function errorsOf(turns: readonly TurnResult[]): string[] {
	return turns.filter((turn) => turn.error).flatMap((turn) => ["", `Error in ${turn.label}, verbatim:`, "", "```text", turn.error ?? "", "```"]);
}

/** What the two replay requests say about `requiresReasoningContentOnAssistantMessages`. */
export function replayVerdict(report: ReplayReport): string {
	const withOk = !report.withField.error;
	const withoutOk = !report.withoutField.error;
	if (withOk && !withoutOk) return "needs the empty `reasoning_content`: the request without it failed. The flag in `agent/models.json` is required.";
	if (withOk && withoutOk) return "accepts the history both ways. The flag is not needed for this provider, and it does no harm.";
	if (!withOk && withoutOk) return "rejects the empty `reasoning_content` and accepts the history without it. The flag must not be set for this model.";
	return "failed both ways. Read the errors: the cause is something other than `reasoning_content`.";
}

export function totalCost(report: ProbeReport): { reported: number; estimated: number; calls: number } {
	const turns = [
		...(report.loop ?? []).flatMap((loop) => loop.turns),
		...(report.replay ?? []).flatMap((replay) => [replay.withField, replay.withoutField]),
		...(report.thinking ?? []).flatMap((variant) => variant.turns),
	];
	let reported = 0;
	let estimated = 0;
	for (const turn of turns) {
		if (turn.usage.cost !== undefined) reported += turn.usage.cost;
		else estimated += turn.estimatedCost ?? 0;
	}
	return { reported, estimated, calls: turns.length };
}

export function renderReport(report: ProbeReport): string {
	const lines: string[] = [
		`# OpenRouter probe ${report.startedAt}`,
		"",
		`- Key: ${report.keySource}`,
		`- API: ${report.baseUrl}`,
		`- Routing block from \`agent/models.json\`, sent as \`provider\`: \`${JSON.stringify(report.routing)}\``,
		`- Client: Pi ${report.piVersion} (\`ModelRuntime\` with \`agent/models.json\`); output cap ${report.maxTokens} tokens per call`,
	];
	const cost = totalCost(report);
	if (cost.calls) {
		const estimate = cost.estimated > 0 ? ` plus about $${cost.estimated.toFixed(4)} estimated by Pi where OpenRouter reported none` : "";
		lines.push(`- Cost: $${cost.reported.toFixed(4)} reported by OpenRouter for ${cost.calls} chat request(s)${estimate}`);
	}

	if (report.endpoints) {
		lines.push("", "## 1. Endpoints", "");
		lines.push(
			"Providers OpenRouter lists per model (`GET /models/{author}/{slug}/endpoints`). “Remains” applies the routing block:",
			"`require_parameters` needs `tools` and `reasoning`, `zdr` needs the provider in the ZDR preview list (`GET /endpoints/zdr`).",
			"`data_collection: deny` cannot be read from these lists. Section 2 shows which provider actually served a request.",
		);
		if (report.endpoints.zdrError) {
			lines.push("", `The ZDR preview list could not be read, so ZDR is “unknown” below: \`${cell(report.endpoints.zdrError)}\``);
		}
		for (const model of report.endpoints.reports) {
			lines.push("", `### ${model.modelName} (\`${model.model}\`)`, "");
			if (model.error) {
				lines.push("Lookup failed, verbatim:", "", "```text", model.error, "```");
				continue;
			}
			const remaining = model.rows.filter((row) => row.remains === "yes").length;
			const undecided = model.rows.filter((row) => row.remains === "unknown").length;
			const zdrNote = model.zdrList ? ` ZDR list: ${model.zdrList.total} entries, ${model.zdrList.forModel} for this model.` : "";
			lines.push(`${model.rows.length} endpoint(s), ${remaining} remain${undecided ? `, ${undecided} undecided (ZDR not known)` : ""}.${zdrNote}`, "");
			lines.push(
				...table(
					["Provider", "Quantization", "Tools", "Reasoning", "ZDR", "Price in / out / cache read (USD per M)", "Status", "Remains", "Why not"],
					model.rows.map((row) => [
						row.provider,
						row.quantization,
						yesNo(row.tools),
						yesNo(row.reasoning),
						row.zdr,
						`${dash(row.input, 2)} / ${dash(row.output, 2)} / ${dash(row.cacheRead, 3)}`,
						row.status,
						row.remains,
						row.note || "–",
					]),
				),
			);
		}
	}

	if (report.loop) {
		lines.push("", "## 2. Tool loop", "");
		lines.push(
			"Three turns with one trivial tool, as Pi sends them. “Reasoning came in” is the stream field that carried the model's thinking;",
			"“Earlier turns replayed as” lists, per earlier assistant message, the reasoning fields Pi sent back (`=\"\"` is an empty field).",
			"The system prompt is padded so that provider caching can apply; “Cached” on turns 2 and 3 shows whether it did.",
		);
		for (const loop of report.loop) {
			lines.push("", `### ${loop.modelName} (\`${loop.model}\`, \`${loop.effort}\`)`, "", ...turnTable(loop.turns), ...errorsOf(loop.turns));
		}
	}

	if (report.replay) {
		lines.push("", "## 3. Cross-model replay", "");
		lines.push(
			"The history holds a tool call that Flash made and its result; Pi drops Flash's thinking when another model takes over.",
			"Each model gets it twice: with an empty `reasoning_content` on the replayed assistant message",
			"(`requiresReasoningContentOnAssistantMessages: true`) and without the field.",
		);
		for (const replay of report.replay) {
			lines.push("", `### ${replay.modelName} (\`${replay.model}\`)`, "");
			lines.push(
				...table(
					["Request", "Result", "Provider", "Assistant message replayed as", "Cost"],
					[replay.withField, replay.withoutField].map((turn) => [turn.label, outcome(turn), turn.provider ?? "–", turn.replayed.join("; ") || "–", costOf(turn)]),
				),
			);
			lines.push("", `Verdict: ${replay.modelName} ${replayVerdict(replay)}`, ...errorsOf([replay.withField, replay.withoutField]));
		}
	}

	if (report.thinking) {
		lines.push("", "## 4. GLM preserved thinking", "");
		lines.push(
			"Z.ai's own API drops reasoning from earlier turns unless `thinking.clear_thinking` is `false`, and recommends keeping it for",
			"coding agents. Pi sends that field only for `thinkingFormat: \"zai\"`, not through OpenRouter. No OpenRouter request field for",
			"this was found in its documentation on 10 Nov 2026 (web search only; the docs were not reachable from the build environment).",
			"The variants below send the same loop with extra body fields. Compare reasoning tokens and cached tokens on turns 2 and 3.",
			"Report only: `agent/models.json` is unchanged.",
		);
		for (const variant of report.thinking) {
			lines.push("", `### ${variant.variant}`, "", variant.extraBody ? `Extra body: \`${variant.extraBody}\`` : "No extra body: the request as Pi sends it.", "");
			lines.push(...turnTable(variant.turns), ...errorsOf(variant.turns));
		}
	}
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- live requests

const ADD_TOOL = {
	name: "add",
	description: "Add two integers and return the sum.",
	parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false },
} as unknown as Tool;

/**
 * The system prompt: a nonce first, so every run and variant starts with a cold cache, then
 * enough fixed text (about 2,000 tokens) for providers that only cache longer prompts.
 */
export function systemPrompt(nonce: string): string {
	const rules = Array.from({ length: 120 }, (_, index) => `Reference line ${index + 1}: the add tool takes two integers named a and b and returns their sum as a decimal number.`);
	return [`Probe ${nonce}.`, "You are a calculator that may only compute with the add tool. Never add in your head.", ...rules].join("\n");
}

const LOOP_TASK = "Use the add tool to compute 2 + 3. Then use the add tool again to add 4 to that result. Then answer with the final number only.";

interface Client {
	model(id: string): Model<Api>;
	complete(model: Model<Api>, context: Context, options: { effort: Effort; sessionId: string; extraBody?: Json }): Promise<{ message: AssistantMessage; turn: Omit<TurnResult, "label"> }>;
	baseUrl: string;
	fetchJson(path: string): Promise<{ ok: boolean; status: number; body: unknown; raw: string }>;
	dispose(): void;
}

/** Pi's model runtime with this repo's agent/models.json, and nothing from ~/.pi/agent. */
export async function createClient(key: string, options: { maxTokens: number; baseUrl?: string }): Promise<Client> {
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const scratch = mkdtempSync(join(tmpdir(), "nest-probe-"));
	let modelsPath = join(NEST, "agent/models.json");
	if (options.baseUrl) {
		const models = JSON.parse(readFileSync(modelsPath, "utf-8"));
		models.providers[PROVIDER].baseUrl = options.baseUrl;
		modelsPath = join(scratch, "models.json");
		writeFileSync(modelsPath, JSON.stringify(models));
	}
	// No auth.json and no saved model list: the probe must not pick up the interactive login.
	const runtime = await ModelRuntime.create({ modelsPath, authPath: join(scratch, "auth.json"), modelsStorePath: join(scratch, "models-store.json"), refreshOnCreate: false });
	const configError = runtime.getError();
	if (configError) throw new Error(`agent/models.json: ${configError}`);
	const baseUrl = options.baseUrl ?? runtime.getModel(PROVIDER, FLASH)?.baseUrl ?? "https://openrouter.ai/api/v1";

	return {
		baseUrl,
		model(id) {
			const model = runtime.getModel(PROVIDER, id);
			if (!model) throw new Error(`${PROVIDER}/${id} is not in Pi's catalog`);
			return model;
		},
		async complete(model, context, { effort, sessionId, extraBody }) {
			const chunks: unknown[] = [];
			let status: number | undefined;
			let payload: unknown;
			const message = await runtime.completeSimple(model, context, {
				apiKey: key,
				reasoning: effort,
				sessionId,
				maxTokens: options.maxTokens,
				maxRetries: 0,
				timeoutMs: 180_000,
				onPayload: (body) => {
					payload = extraBody ? { ...asRecord(body), ...extraBody } : body;
					return extraBody ? payload : undefined;
				},
				onResponse: (response) => {
					status = response.status;
				},
				onProviderStreamEvent: (data) => {
					chunks.push(data);
				},
			});
			const summary = summarizeChunks(chunks);
			const failed = message.stopReason === "error" || message.stopReason === "aborted";
			const statusFromError = /^\s*(\d{3})(?!\d)/.exec(message.errorMessage ?? "")?.[1];
			return {
				message,
				turn: {
					status: status ?? (statusFromError ? Number(statusFromError) : undefined),
					provider: summary.provider,
					reasoningFields: summary.reasoningFields,
					replayed: replayedReasoning(payload),
					usage: summary.usage,
					...(summary.usage.cost === undefined && message.usage?.cost?.total ? { estimatedCost: message.usage.cost.total } : {}),
					finishReason: summary.finishReason,
					toolCalls: message.content.filter((block) => block.type === "toolCall").length,
					...(failed ? { error: message.errorMessage ?? `stopped: ${message.stopReason}` } : {}),
				},
			};
		},
		async fetchJson(path) {
			const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${key}` } });
			const raw = await response.text();
			let body: unknown;
			try {
				body = JSON.parse(raw);
			} catch {
				body = undefined;
			}
			return { ok: response.ok, status: response.status, body, raw };
		},
		dispose() {
			rmSync(scratch, { recursive: true, force: true });
		},
	};
}

const now = () => Date.now();
const user = (content: string): Message => ({ role: "user", content, timestamp: now() }) as Message;

function toolResults(message: AssistantMessage): Message[] {
	return message.content.flatMap((block) => {
		if (block.type !== "toolCall") return [];
		const args = block.arguments as { a?: unknown; b?: unknown };
		const sum = Number(args?.a) + Number(args?.b);
		const answer = Number.isFinite(sum) ? String(sum) : "error: a and b must be integers";
		return [{ role: "toolResult", toolCallId: block.id, toolName: block.name, content: [{ type: "text", text: answer }], isError: !Number.isFinite(sum), timestamp: now() } as Message];
	});
}

/** Up to three turns: each tool call is answered and sent back. Stops at an error or a final answer. */
export async function runLoop(client: Client, modelId: string, effort: Effort, nonce: string, extraBody?: Json): Promise<TurnResult[]> {
	const model = client.model(modelId);
	const context: Context = { systemPrompt: systemPrompt(nonce), messages: [user(LOOP_TASK)], tools: [ADD_TOOL] };
	const turns: TurnResult[] = [];
	for (let index = 1; index <= 3; index++) {
		const { message, turn } = await client.complete(model, context, { effort, sessionId: `probe-${nonce}`, ...(extraBody ? { extraBody } : {}) });
		turns.push({ label: `turn ${index}`, ...turn });
		if (turn.error) break;
		const results = toolResults(message);
		context.messages.push(message, ...results);
		if (!results.length) break;
	}
	return turns;
}

/**
 * A history as after a switch from Flash: Flash thought, called the tool, the tool answered. Sent
 * to `modelId` once with and once without the compat flag that adds an empty reasoning_content.
 */
export async function runReplay(client: Client, modelId: string, effort: Effort, nonce: string): Promise<{ withField: TurnResult; withoutField: TurnResult }> {
	const flash = client.model(FLASH);
	const flashTurn = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "I should call add with 2 and 3.", thinkingSignature: "reasoning" },
			{ type: "toolCall", id: "call_probe_1", name: "add", arguments: { a: 2, b: 3 } },
		],
		api: flash.api,
		provider: flash.provider,
		model: flash.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse",
		timestamp: now(),
	} as unknown as AssistantMessage;
	const send = async (flag: boolean, label: string): Promise<TurnResult> => {
		const base = client.model(modelId);
		const model = { ...base, compat: { ...base.compat, requiresReasoningContentOnAssistantMessages: flag } } as Model<Api>;
		const context: Context = {
			systemPrompt: systemPrompt(`${nonce}-${flag ? "with" : "without"}`),
			messages: [user(LOOP_TASK), flashTurn, ...toolResults(flashTurn)],
			tools: [ADD_TOOL],
		};
		const { turn } = await client.complete(model, context, { effort, sessionId: `probe-${nonce}-${flag ? "with" : "without"}` });
		return { label, ...turn };
	};
	return {
		withField: await send(true, 'with reasoning_content=""'),
		withoutField: await send(false, "without the field"),
	};
}

export async function runEndpoints(client: Client, routing: Routing): Promise<NonNullable<ProbeReport["endpoints"]>> {
	const zdr = await client.fetchJson("/endpoints/zdr").catch((error: unknown) => ({ ok: false, status: 0, body: undefined, raw: String(error) }));
	const zdrError = zdr.ok ? undefined : `${zdr.status} ${zdr.raw.slice(0, 300)}`;
	const reports: EndpointsReport[] = [];
	for (const model of MODELS) {
		try {
			const response = await client.fetchJson(`/models/${model.id}/endpoints`);
			if (!response.ok) {
				reports.push({ model: model.id, modelName: model.name, rows: [], error: `${response.status} ${response.raw.slice(0, 500)}` });
				continue;
			}
			const listed = zdr.ok ? zdrProviders(zdr.body, modelIdsOf(model.id, response.body)) : undefined;
			reports.push({
				model: model.id,
				modelName: model.name,
				rows: endpointRows(response.body, routing, listed),
				...(listed ? { zdrList: { total: listed.total, forModel: listed.providers.length } } : {}),
			});
		} catch (error) {
			reports.push({ model: model.id, modelName: model.name, rows: [], error: String(error) });
		}
	}
	return { reports, ...(zdrError ? { zdrError } : {}) };
}

/** The variants of section 4. Z.ai's native field is passed through as it is. */
export function thinkingVariants(extraBodyJson: string | undefined): { variant: string; extraBody?: Json }[] {
	const variants: { variant: string; extraBody?: Json }[] = [
		{ variant: "A: as Pi sends it" },
		{ variant: "B: Z.ai's native field", extraBody: { thinking: { type: "enabled", clear_thinking: false } } },
	];
	if (extraBodyJson?.trim()) variants.push({ variant: "C: PROBE_EXTRA_BODY", extraBody: asRecord(JSON.parse(extraBodyJson)) });
	return variants;
}

export function parseSections(argv: readonly string[]): Section[] | { error: string } {
	const index = argv.indexOf("--only");
	if (index < 0) return argv.length ? { error: `unknown argument ${argv[0]}` } : [...SECTIONS];
	const names = (argv[index + 1] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
	const unknown = names.filter((name) => !(SECTIONS as readonly string[]).includes(name));
	if (!names.length || unknown.length || argv.length !== 2) return { error: `--only takes ${SECTIONS.join(", ")} (comma-separated)${unknown.length ? `, not ${unknown.join(", ")}` : ""}` };
	return names as Section[];
}

export async function probe(client: Client, sections: readonly Section[], settings: Pick<ProbeReport, "keySource" | "maxTokens" | "routing" | "piVersion">, extraBodyJson?: string): Promise<ProbeReport> {
	const startedAt = new Date().toISOString();
	const nonce = startedAt.replace(/[^0-9]/g, "").slice(0, 14);
	const report: ProbeReport = { startedAt, baseUrl: client.baseUrl, ...settings };
	const progress = (message: string) => process.stderr.write(`probe: ${message}\n`);
	if (sections.includes("endpoints")) {
		progress("endpoints");
		report.endpoints = await runEndpoints(client, settings.routing);
	}
	if (sections.includes("loop")) {
		report.loop = [];
		for (const model of MODELS) {
			progress(`tool loop on ${model.name}`);
			report.loop.push({ model: model.id, modelName: model.name, effort: model.effort, turns: await runLoop(client, model.id, model.effort, `${nonce}-loop-${model.id.split("/")[0]}`) });
		}
	}
	if (sections.includes("replay")) {
		report.replay = [];
		for (const model of MODELS.filter((candidate) => candidate.id !== FLASH)) {
			progress(`cross-model replay on ${model.name}`);
			report.replay.push({ model: model.id, modelName: model.name, ...(await runReplay(client, model.id, model.effort, `${nonce}-replay-${model.id.split("/")[0]}`)) });
		}
	}
	if (sections.includes("thinking")) {
		report.thinking = [];
		for (const [index, variant] of thinkingVariants(extraBodyJson).entries()) {
			progress(`GLM preserved thinking, variant ${variant.variant}`);
			report.thinking.push({
				variant: variant.variant,
				extraBody: variant.extraBody ? JSON.stringify(variant.extraBody) : "",
				turns: await runLoop(client, GLM, "max", `${nonce}-thinking-${index}`, variant.extraBody),
			});
		}
	}
	return report;
}

async function main(argv: string[]) {
	if (argv.includes("-h") || argv.includes("--help")) {
		console.log(`usage: probe-openrouter.ts [--only ${SECTIONS.join(",")}]`);
		return;
	}
	const sections = parseSections(argv);
	if ("error" in sections) {
		console.error(sections.error);
		process.exit(2);
	}
	const resolved = resolveKey(process.env, readKeychain);
	if ("error" in resolved) {
		console.error(resolved.error);
		process.exit(64);
	}
	const maxTokens = Number(process.env.PROBE_MAX_TOKENS ?? 1024);
	if (!Number.isInteger(maxTokens) || maxTokens < 64) {
		console.error("PROBE_MAX_TOKENS must be an integer of at least 64");
		process.exit(2);
	}
	const routing = routingOf(JSON.parse(readFileSync(join(NEST, "agent/models.json"), "utf-8")));
	const piVersion = JSON.parse(readFileSync(join(NEST, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf-8")).version as string;
	const client = await createClient(resolved.key, { maxTokens, ...(process.env.PROBE_BASE_URL ? { baseUrl: process.env.PROBE_BASE_URL } : {}) });
	try {
		const report = await probe(client, sections, { keySource: resolved.source, maxTokens, routing, piVersion }, process.env.PROBE_EXTRA_BODY);
		const markdown = renderReport(report);
		const file = join(NEST, "runs", `probe-${report.startedAt.replace(/[:.]/g, "-")}.md`);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, markdown);
		process.stdout.write(markdown);
		process.stderr.write(`probe: report written to ${file}\n`);
	} finally {
		client.dispose();
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
