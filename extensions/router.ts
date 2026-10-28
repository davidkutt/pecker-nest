/**
 * Router: the virtual model `router/phased` plans on Opus and builds on Sonnet.
 *
 * - Phase "plan": Opus 5.5 at the selected thinking level (default high). Opus explores,
 *   plans and makes the first code edit.
 * - After the first successful edit/write of a non-documentation file, the next request
 *   moves to phase "build": Sonnet 5.5, one thinking level lower. The session stays there,
 *   so a task costs a single prompt-cache miss.
 * - Starting a task with /plan returns to phase "plan".
 * - Retries stay on the model that failed and continuations on the phase model, so the
 *   prompt cache holds. Requests outside the agent loop (compaction summaries) use Sonnet.
 *
 * The phase is router state: Pi stores it on the session branch, so it follows /tree,
 * forks and compaction. Pattern: docs/virtual-models.md and examples/extensions/jev-router.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BUILD_MODEL,
	nextPhase,
	type Phase,
	PLAN_MODEL,
	PROVIDER,
	physicalLevel,
	ROUTER_LEVELS,
	type RouterState,
} from "./lib/router-logic.ts";

function physicalModel(ctx: ExtensionContext, id: string) {
	const model = ctx.modelRegistry.find(PROVIDER, id);
	if (!model) throw new Error(`router/phased: ${PROVIDER}/${id} is not in the model catalog`);
	return model;
}

export default function (pi: ExtensionAPI) {
	let planRequested = false;

	pi.on("input", (event) => {
		if (event.source !== "extension" && !event.streamingBehavior && /^\/plan(\s|$)/.test(event.text.trimStart())) {
			planRequested = true;
		}
		return undefined;
	});

	pi.registerVirtualModel<RouterState>({
		provider: "router",
		id: "phased",
		name: "Phased (Opus plans, Sonnet builds)",
		thinkingLevels: ROUTER_LEVELS,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		route(request, ctx) {
			if (request.reason === "direct") {
				return { model: physicalModel(ctx, BUILD_MODEL), thinkingLevel: "medium" };
			}
			if (request.reason === "retry" && request.failed) {
				return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? "medium" };
			}

			const consumePlanRequest = request.reason === "user" && planRequested;
			if (consumePlanRequest) planRequested = false;
			const phase: Phase = nextPhase(request.state, request.messages, consumePlanRequest);
			const changed = request.state?.phase !== phase;
			return {
				model: physicalModel(ctx, phase === "plan" ? PLAN_MODEL : BUILD_MODEL),
				thinkingLevel: physicalLevel(phase, request.thinkingLevel),
				...(changed ? { state: { phase } } : {}),
			};
		},
	});
}
