/**
 * Router: the virtual model `router/phased` runs GLM 5.3 on OpenRouter and changes only the
 * reasoning effort between phases.
 *
 * - Phase "plan": GLM 5.3 at `max`. It explores, plans and makes the first code edit.
 * - After the first successful edit/write of a non-documentation file, the next request
 *   moves to phase "build": GLM 5.3 at `high`. The session stays there.
 * - Starting a task with /plan returns to phase "plan".
 * - Retries stay on the model and effort that failed. Requests outside the agent loop
 *   (compaction summaries) use `high`.
 *
 * The model never changes, so the prompt prefix and OpenRouter's sticky provider routing stay
 * the same across the switch. The phase is router state: Pi stores it on the session branch,
 * so it follows /tree, forks and compaction. Pattern: docs/virtual-models.md.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODEL, nextPhase, type Phase, PHASE_LEVEL, PROVIDER, type RouterState } from "./lib/router-logic.ts";

function glm(ctx: ExtensionContext) {
	const model = ctx.modelRegistry.find(PROVIDER, MODEL);
	if (!model) throw new Error(`router/phased: ${PROVIDER}/${MODEL} is not available (check /model and your OpenRouter key)`);
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
		name: "Phased (GLM 5.3: max plans, high builds)",
		// The phase decides the effort; the selected level is not used.
		thinkingLevels: ["high"],
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		route(request, ctx) {
			if (request.reason === "direct") {
				return { model: glm(ctx), thinkingLevel: PHASE_LEVEL.build };
			}
			if (request.reason === "retry" && request.failed) {
				return { model: request.failed.model, thinkingLevel: request.failed.thinkingLevel ?? PHASE_LEVEL.build };
			}

			const consumePlanRequest = request.reason === "user" && planRequested;
			if (consumePlanRequest) planRequested = false;
			const phase: Phase = nextPhase(request.state, request.messages, consumePlanRequest);
			const changed = request.state?.phase !== phase;
			return {
				model: glm(ctx),
				thinkingLevel: PHASE_LEVEL[phase],
				...(changed ? { state: { phase } } : {}),
			};
		},
	});
}
