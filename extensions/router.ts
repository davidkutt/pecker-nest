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
 * - Retries stay on the model and effort that failed; steering and follow-up messages keep the
 *   current tier; requests outside the agent loop (compaction summaries) use Flash.
 *
 * The tier and the strong choice are router state: Pi stores them on the session branch (custom
 * entries `pi.virtual-model-state`), so they follow /tree, forks and compaction, and the session
 * report can count escalations per reason and per strong model. States written before /strong
 * existed carry `tier: "glm"` and still read as GLM. Switching models costs one prompt-cache
 * miss. Pattern: docs/virtual-models.md in Pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_STRONG,
	decide,
	FLASH,
	hasImages,
	isStrong,
	PROVIDER,
	readState,
	type RouterState,
	sameState,
	type Strong,
	STRONG_MODELS,
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

	function tell(ctx: ExtensionContext, message: string) {
		if (ctx.hasUI) ctx.ui.notify(`router: ${message}`, "info");
		else process.stderr.write(`[router] ${message}\n`);
	}

	function find(ctx: ExtensionContext, id: string) {
		return ctx.modelRegistry.find(PROVIDER, id);
	}

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

	const selected = (ctx: ExtensionContext) => ctx.model?.provider === ROUTER_PROVIDER && ctx.model?.id === ROUTER_ID;

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
				ctx.ui.notify(`router: strong model is ${strongName(current)} (${PROVIDER}/${STRONG_MODELS[current].id}); /strong ${names}`, "info");
				return;
			}
			if (!isStrong(argument)) {
				ctx.ui.notify(`router: /strong takes ${Object.keys(STRONG_MODELS).join(" or ")}, not ${argument}`, "error");
				return;
			}
			strongChoice = argument;
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
			const wanted = request.reason === "user" && strongChoice !== undefined ? strongChoice : strongOf(state);
			lastStrong = wanted;

			if (request.reason === "retry" && request.failed) {
				return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? "high" };
			}

			/**
			 * The strong model the registry can actually serve: the chosen one, else GLM 5.3,
			 * else none (Flash takes over). Each missing model is reported once.
			 */
			const resolveStrong = (): { strong: Strong; model: ReturnType<typeof find> } | undefined => {
				const order: Strong[] = wanted === DEFAULT_STRONG ? [DEFAULT_STRONG] : [wanted, DEFAULT_STRONG];
				for (const candidate of order) {
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
					const missing = order.map((candidate) => `${PROVIDER}/${STRONG_MODELS[candidate].id}`).join(" nor ");
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
				reason: request.reason === "user" ? "user" : "continuation",
				state,
				messages: request.messages,
				planRequested: request.reason === "user" && planRequested,
				keepTier: request.reason === "user" && keepTier,
				...(request.reason === "user" && hard !== undefined ? { hard } : {}),
				...(request.reason === "user" && strongChoice !== undefined ? { strong: strongChoice } : {}),
				strongUsable,
				...(resolved && resolved.strong !== wanted ? { strongFallback: resolved.strong } : {}),
			});
			if (request.reason === "user") {
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
