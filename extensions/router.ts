/**
 * Router: the virtual model `router/escalate` runs DeepSeek V4.1 Flash and calls in GLM 5.3
 * when the work needs it (strategy A: Flash builds, GLM steps in).
 *
 * - Every prompt you type starts on Flash at high.
 * - /plan runs on GLM at max.
 * - Within a run, GLM at high takes over when the quality gate is still red at repair round 2,
 *   when the agent repeats the same tool call three times, fails three edits on one file, or
 *   fails five tool calls in a row. It stays on GLM until your next prompt.
 * - /hard keeps GLM on for every prompt until /flash.
 * - GLM 5.3 reads no images: a conversation with images stays on Flash. So does everything
 *   when GLM is missing from your OpenRouter model list.
 * - Retries stay on the model and effort that failed; steering and follow-up messages keep the
 *   current tier; requests outside the agent loop (compaction summaries) use Flash.
 *
 * The tier is router state: Pi stores it on the session branch (custom entries
 * `pi.virtual-model-state`), so it follows /tree, forks and compaction, and the session report
 * can count escalations. Switching models costs one prompt-cache miss. Pattern:
 * docs/virtual-models.md in Pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decide, FLASH, GLM, hasImages, PROVIDER, type RouterState, sameState } from "./lib/router-logic.ts";
import { isPlanCommand } from "./lib/safety-rules.ts";

export const ROUTER_PROVIDER = "router";
export const ROUTER_ID = "escalate";

export default function (pi: ExtensionAPI) {
	let planRequested = false;
	let keepTier = false;
	let hard: boolean | undefined;
	let warnedNoFlash = false;

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
		description: "Run every prompt on GLM 5.3 (high) until /flash",
		handler: async (_args, ctx) => {
			hard = true;
			ctx.ui.notify(
				selected(ctx) ? "router: GLM 5.3 from your next prompt until /flash" : "router: /hard applies to router/escalate; select it with /model",
				"info",
			);
		},
	});
	pi.registerCommand("flash", {
		description: "Back to DeepSeek V4.1 Flash; GLM 5.3 only steps in when the agent is stuck",
		handler: async (_args, ctx) => {
			hard = false;
			ctx.ui.notify("router: DeepSeek V4.1 Flash from your next prompt", "info");
		},
	});

	pi.registerVirtualModel<RouterState>({
		provider: ROUTER_PROVIDER,
		id: ROUTER_ID,
		name: "Escalate (DeepSeek V4.1 Flash, GLM 5.3 steps in)",
		// The router decides the effort; the selected level is not used.
		thinkingLevels: ["high"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		route(request, ctx) {
			const flash = find(ctx, FLASH);
			const glm = find(ctx, GLM);
			if (!flash && !glm) {
				throw new Error(`router/escalate: neither ${PROVIDER}/${FLASH} nor ${PROVIDER}/${GLM} is available (check /model and your OpenRouter key)`);
			}
			if (request.reason === "retry" && request.failed) {
				return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? "high" };
			}
			if (request.reason === "direct") {
				return { model: (flash ?? glm)!, thinkingLevel: "high" };
			}

			const glmUsable = Boolean(glm) && (glm!.input.includes("image") || !hasImages(request.messages));
			const decision = decide({
				reason: request.reason === "user" ? "user" : "continuation",
				state: request.state,
				messages: request.messages,
				planRequested: request.reason === "user" && planRequested,
				keepTier: request.reason === "user" && keepTier,
				...(request.reason === "user" && hard !== undefined ? { hard } : {}),
				glmUsable,
			});
			if (request.reason === "user") {
				planRequested = false;
				hard = undefined;
			}
			if (decision.notice) tell(ctx, decision.notice);
			if (!flash && decision.tier === "flash" && !warnedNoFlash) {
				warnedNoFlash = true;
				tell(ctx, `${PROVIDER}/${FLASH} is not available; using GLM 5.3`);
			}

			const model = decision.tier === "glm" ? glm! : (flash ?? glm)!;
			return {
				model,
				thinkingLevel: decision.level,
				...(sameState(request.state, decision.state) ? {} : { state: decision.state }),
			};
		},
	});
}
