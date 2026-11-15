/**
 * Router: the virtual model `router/escalate` runs DeepSeek V4.1 Flash and calls in a stronger
 * model when the work needs it (strategy A: Flash builds, the strong model steps in).
 *
 * - Every prompt you type starts on Flash at high.
 * - The strong model always runs at max: an escalation means Flash is already stuck, and both
 *   vendors publish their coding results at max.
 * - /plan runs on the strong model.
 * - Within a run, the strong model takes over when the quality gate is still red at repair
 *   round 2, when the agent repeats the same tool call three times, fails three edits on one
 *   file, or fails five tool calls in a row. It stays there until your next prompt.
 * - /hard keeps the strong model on for every prompt until /flash.
 * - /strong glm|kimi picks the strong model: GLM 5.3 (default) or Kimi K3.1 Pro. Without an
 *   argument it shows the current choice. Like /hard it only switches and sends no message.
 * - A conversation with images can only escalate when the strong model reads images: GLM 5.3
 *   does not, Kimi K3.1 Pro does. Otherwise the session stays on Flash.
 * - A strong model missing from the registry (ZDR may leave no provider) falls back to GLM 5.3,
 *   then to Flash, with one notice. The router never throws for a missing model.
 * - A strong model that fails at request time for a routing or request-shape reason (OpenRouter
 *   answers "No endpoints found", or the provider rejects the request with HTTP 400) is ruled
 *   out for this process: the run continues on GLM 5.3, then on Flash, with one notice, and
 *   later escalations skip it. `/strong <model>` picks it again. Pi does not retry such errors
 *   itself, so the router drops the failed attempt at `agent_before_settle` and continues; where
 *   Pi does retry ("Provider returned error"), the router switches models in the retry.
 * - Other retries (rate limits, overload) stay on the model and effort that failed; steering and
 *   follow-up messages keep the current tier; requests outside the agent loop (compaction
 *   summaries) use Flash.
 *
 * The tier and the strong choice are router state: Pi stores them on the session branch (custom
 * entries `pi.virtual-model-state`), so they follow /tree, forks and compaction, and the session
 * report can count escalations per reason and per strong model. States written before /strong
 * existed carry `tier: "glm"` and still read as GLM. A model ruled out at request time is
 * recorded too (custom entry `nest-router-fallback`: which model, why, what took over). Switching
 * models costs one prompt-cache miss. Pattern: docs/virtual-models.md in Pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_STRONG,
	decide,
	FALLBACK_ENTRY,
	type FailedRequest,
	type FallbackRecord,
	FLASH,
	hasImages,
	isStrong,
	PROVIDER,
	readState,
	type RouterState,
	ruledOut,
	sameState,
	shortError,
	type Strong,
	STRONG_MODELS,
	strongCandidates,
	strongName,
	strongOf,
} from "./lib/router-logic.ts";
import { isPlanCommand } from "./lib/safety-rules.ts";

export const ROUTER_PROVIDER = "router";
export const ROUTER_ID = "escalate";

export default function (pi: ExtensionAPI) {
	let planRequested = false;
	let keepTier = false;
	let hard: boolean | undefined;
	let strongChoice: Strong | undefined;
	/** The choice the last request saw, so /strong without an argument can report it. */
	let lastStrong: Strong = DEFAULT_STRONG;
	let warnedNoFlash = false;
	const warnedMissing = new Set<string>();
	/** Strong models that failed at request time (no endpoint, rejected request). Kept for the process. */
	const unusable = new Set<Strong>();
	/** The failed response of the latest turn, from turn_end, in case Pi does not retry it. */
	let lastFailure: (FailedRequest & { entryId: string }) | undefined;
	/** The router continued the run after a failed strong request: the next request is no new prompt. */
	let failingOver = false;

	function tell(ctx: ExtensionContext, message: string) {
		if (ctx.hasUI) ctx.ui.notify(`router: ${message}`, "info");
		else process.stderr.write(`[router] ${message}\n`);
	}

	function find(ctx: ExtensionContext, id: string) {
		return ctx.modelRegistry.find(PROVIDER, id);
	}

	/**
	 * Rules the strong model of a failed request out for this process and says so once. Returns
	 * the fallback for the session file, or undefined when the failure is none another model would
	 * fix, or the model is already ruled out.
	 */
	function ruleOut(ctx: ExtensionContext, failed: FailedRequest): FallbackRecord | undefined {
		const out = ruledOut(failed, unusable);
		if (!out) return undefined;
		unusable.add(out.strong);
		// This notice covers the fallback; the registry notices in route() stay quiet for it.
		warnedMissing.add(out.strong);
		warnedMissing.add(lastStrong);
		const next = strongCandidates(lastStrong, unusable).find((candidate) => find(ctx, STRONG_MODELS[candidate].id));
		const why = out.kind === "routing" ? "no endpoint under the routing rules" : "the request was rejected";
		const error = shortError(failed.errorMessage);
		tell(ctx, `${strongName(out.strong)} failed, ${why} (${error}); using ${next ? strongName(next) : "DeepSeek V4.1 Flash"} instead until Pi restarts or /strong ${out.strong}`);
		return { ruledOut: out.strong, kind: out.kind, tookOver: next ?? "flash", error };
	}

	const selected = (ctx: ExtensionContext) => ctx.model?.provider === ROUTER_PROVIDER && ctx.model?.id === ROUTER_ID;

	// Pi retries only errors it takes for transient. "No endpoints found" ends the run, so the
	// router remembers the failed response here and continues the run itself below.
	pi.on("turn_end", (event, ctx) => {
		lastFailure = undefined;
		const message = event.message;
		if (event.outcome !== "error" || message.role !== "assistant" || !selected(ctx)) return undefined;
		lastFailure = { provider: message.provider, modelId: message.model, errorMessage: message.errorMessage, entryId: event.messageEntryId };
		return undefined;
	});
	pi.on("agent_before_settle", (event, ctx) => {
		const failure = lastFailure;
		lastFailure = undefined;
		if (event.outcome !== "error" || !failure || !selected(ctx)) return undefined;
		// Each continuation rules one more model out, so this ends after at most two rounds.
		const fallback = ruleOut(ctx, failure);
		if (!fallback) return undefined;
		failingOver = true;
		// Drop the failed attempt from the model's context, as Pi does for its own retries, and
		// record the fallback for the session report.
		return {
			entries: [
				...event.entries,
				{ type: "context_edit" as const, targetId: failure.entryId, replacement: null },
				{ type: "custom" as const, customType: FALLBACK_ENTRY, data: fallback },
			],
			continue: true,
		};
	});
	pi.on("agent_settled", () => {
		failingOver = false;
		lastFailure = undefined;
	});

	pi.on("input", (event) => {
		// Steering, follow-up and extension messages join the current task and keep its tier.
		if (event.source === "extension" || event.streamingBehavior) {
			keepTier = true;
			return undefined;
		}
		keepTier = false;
		planRequested = isPlanCommand(event.text);
		return undefined;
	});

	pi.registerCommand("hard", {
		description: "Run every prompt on the strong model (max) until /flash",
		handler: async (_args, ctx) => {
			hard = true;
			ctx.ui.notify(
				selected(ctx)
					? `router: ${strongName(strongChoice ?? lastStrong)} from your next prompt until /flash`
					: "router: /hard applies to router/escalate; select it with /model",
				"info",
			);
		},
	});
	pi.registerCommand("flash", {
		description: "Back to DeepSeek V4.1 Flash; the strong model only steps in when the agent is stuck",
		handler: async (_args, ctx) => {
			hard = false;
			ctx.ui.notify("router: DeepSeek V4.1 Flash from your next prompt", "info");
		},
	});
	pi.registerCommand("strong", {
		description: "Pick the model the router calls in for /plan, escalations and /hard: /strong glm|kimi",
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();
			const current = strongChoice ?? lastStrong;
			if (!argument) {
				const names = Object.keys(STRONG_MODELS).join(" | ");
				const failed = unusable.has(current) ? "; it failed earlier in this process and is skipped until you pick it again" : "";
				ctx.ui.notify(`router: strong model is ${strongName(current)} (${PROVIDER}/${STRONG_MODELS[current].id})${failed}; /strong ${names}`, "info");
				return;
			}
			if (!isStrong(argument)) {
				ctx.ui.notify(`router: /strong takes ${Object.keys(STRONG_MODELS).join(" or ")}, not ${argument}`, "error");
				return;
			}
			strongChoice = argument;
			// Picking a model again gives it another chance after a failed request.
			unusable.delete(argument);
			warnedMissing.delete(argument);
			ctx.ui.notify(
				selected(ctx)
					? `router: ${strongName(argument)} from your next prompt (/plan, escalations, /hard)`
					: "router: /strong applies to router/escalate; select it with /model",
				"info",
			);
		},
	});

	pi.registerVirtualModel<RouterState>({
		provider: ROUTER_PROVIDER,
		id: ROUTER_ID,
		name: "Escalate (DeepSeek V4.1 Flash, GLM 5.3 or Kimi K3.1 Pro steps in)",
		// The router decides the effort; the selected level is not used.
		thinkingLevels: ["high"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		route(request, ctx) {
			const flash = find(ctx, FLASH);
			const state = readState(request.state);
			// A request that continues the run after a failed strong request is no new prompt,
			// even when Pi reports it as one (the failed response was the first of its turn).
			const userPrompt = request.reason === "user" && !failingOver;
			failingOver = false;
			const wanted = userPrompt && strongChoice !== undefined ? strongChoice : strongOf(state);
			lastStrong = wanted;

			if (request.reason === "retry" && request.failed) {
				const { model, message, thinkingLevel } = request.failed;
				// Rate limits and overload: same model. A strong model that has no endpoint or
				// rejects the request is ruled out, and the stored state decides again below.
				const fallback = ruleOut(ctx, { provider: model.provider, modelId: model.id, errorMessage: message.errorMessage });
				if (!fallback) return { model, thinkingLevel: thinkingLevel ?? "high" };
				pi.appendEntry(FALLBACK_ENTRY, fallback);
			}

			/**
			 * The strong model that can actually serve: the chosen one, else GLM 5.3, else none
			 * (Flash takes over). Models that failed at request time are skipped; each model
			 * missing from the registry is reported once.
			 */
			const resolveStrong = (): { strong: Strong; model: ReturnType<typeof find> } | undefined => {
				for (const candidate of strongCandidates(wanted, unusable)) {
					const model = find(ctx, STRONG_MODELS[candidate].id);
					if (model) {
						if (candidate !== wanted && !warnedMissing.has(wanted)) {
							warnedMissing.add(wanted);
							tell(ctx, `${PROVIDER}/${STRONG_MODELS[wanted].id} is not available; using ${strongName(candidate)} instead`);
						}
						return { strong: candidate, model };
					}
				}
				if (!warnedMissing.has(wanted)) {
					warnedMissing.add(wanted);
					const missing = strongCandidates(wanted)
						.map((candidate) => `${PROVIDER}/${STRONG_MODELS[candidate].id}`)
						.join(" nor ");
					tell(ctx, `neither ${missing} is available; staying on DeepSeek V4.1 Flash (check /model and your OpenRouter key)`);
				}
				return undefined;
			};

			const resolved = resolveStrong();
			if (!flash && !resolved) {
				// Nothing to route to. Pi needs a model, so hand back the first one the registry
				// has and say why; a thrown error here would end the session.
				// Never the router itself, which would route to itself.
				const chat = ctx.modelRegistry.getAvailable().filter((model) => !(model.provider === ROUTER_PROVIDER && model.id === ROUTER_ID));
				const fallback = chat.find((model) => model.provider === PROVIDER) ?? chat[0];
				const ids = [FLASH, ...Object.values(STRONG_MODELS).map((model) => model.id)].map((id) => `${PROVIDER}/${id}`).join(", ");
				if (!fallback) throw new Error(`router/escalate: no model at all in the registry (expected one of ${ids}; check /model and your OpenRouter key)`);
				if (!warnedNoFlash) {
					warnedNoFlash = true;
					tell(ctx, `none of ${ids} is available; using ${fallback.provider}/${fallback.id} (check /model and your OpenRouter key)`);
				}
				return { model: fallback, thinkingLevel: "high" };
			}
			if (request.reason === "direct") {
				return { model: (flash ?? resolved!.model)!, thinkingLevel: "high" };
			}

			const strongUsable = Boolean(resolved) && (resolved!.model!.input.includes("image") || !hasImages(request.messages));
			const decision = decide({
				reason: userPrompt ? "user" : "continuation",
				state,
				messages: request.messages,
				planRequested: userPrompt && planRequested,
				keepTier: userPrompt && keepTier,
				...(userPrompt && hard !== undefined ? { hard } : {}),
				...(userPrompt && strongChoice !== undefined ? { strong: strongChoice } : {}),
				strongUsable,
				...(resolved && resolved.strong !== wanted ? { strongFallback: resolved.strong } : {}),
			});
			if (userPrompt) {
				planRequested = false;
				hard = undefined;
				strongChoice = undefined;
			}
			if (decision.notice) tell(ctx, decision.notice);
			if (!flash && decision.tier === "flash" && !warnedNoFlash) {
				warnedNoFlash = true;
				tell(ctx, `${PROVIDER}/${FLASH} is not available; using ${strongName(decision.strong)}`);
			}

			const model = decision.tier === "strong" ? resolved!.model! : (flash ?? resolved!.model)!;
			return {
				model,
				thinkingLevel: decision.level,
				...(sameState(state, decision.state) ? {} : { state: decision.state }),
			};
		},
	});
}
