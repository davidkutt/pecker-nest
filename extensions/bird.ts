/**
 * The woodpecker: an ASCII bird in Pi's working indicator and footer that shows what the agent is
 * doing (lib/bird.ts holds the logic).
 *
 * - It looks around while the agent reads, pecks while it edits or writes, drums while bash runs,
 *   blinks while it thinks, and listens at the trunk while the run settles.
 * - It turns red while the strong model (GLM 5.3 or Kimi K3.1 Pro) answers, and drums fast and
 *   yellow in a repair round of the quality gate. The footer names the strong model and the round.
 * - After a run the footer keeps the result: gate ok with its seconds, gate red, stopped, or done.
 * - /bird on|off switches it for this process; PI_NEST_BIRD=off starts Pi without it.
 * - Without a UI (print and JSON mode, headless runs in the container) it does nothing.
 *
 * It only reads: Pi's events, the model of each answer and quality-gate.ts's session entries.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BirdEvent, countGateResults, footer, gateResultSince, IDLE, indicator, next, type Paint, repairRound } from "./lib/bird.ts";

const STATUS_KEY = "nest-bird";

export default function (pi: ExtensionAPI) {
	let enabled = process.env.PI_NEST_BIRD !== "off";
	let state = IDLE;
	/** The indicator key last handed to Pi; setting the same frames again would restart the animation. */
	let shownKey: string | undefined;
	/** The footer text last handed to Pi; RPC mode sends every setStatus to the client, so only changes go out. */
	let shownFooter: string | undefined;
	/** Gate results on the branch when the run started, so an older result is not taken for this run's. */
	let gateBaseline = 0;

	function draw(ctx: ExtensionContext) {
		if (!enabled || !ctx.hasUI) return;
		const paint: Paint = (color, text) => ctx.ui.theme.fg(color, text);
		const current = indicator(state, paint);
		if (current.key !== shownKey) {
			shownKey = current.key;
			ctx.ui.setWorkingIndicator({ frames: current.frames, intervalMs: current.intervalMs });
		}
		const line = footer(state, paint);
		if (line !== shownFooter) {
			shownFooter = line;
			ctx.ui.setStatus(STATUS_KEY, line);
		}
	}

	function hide(ctx: ExtensionContext) {
		shownKey = undefined;
		shownFooter = undefined;
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingIndicator();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function apply(ctx: ExtensionContext, event: BirdEvent) {
		state = next(state, event);
		draw(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		state = IDLE;
		shownKey = undefined;
		shownFooter = undefined;
		draw(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (!state.running) gateBaseline = countGateResults(ctx.sessionManager.getBranch());
		apply(ctx, { type: "run_start" });
	});

	pi.on("turn_start", (_event, ctx) => {
		const repair = repairRound(ctx.sessionManager.getBranch());
		apply(ctx, { type: "turn_start", ...(repair ? { repair } : {}) });
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "assistant") apply(ctx, { type: "model", modelId: event.message.model });
	});

	pi.on("tool_execution_start", (event, ctx) => apply(ctx, { type: "tool_start", toolName: event.toolName }));
	pi.on("tool_execution_end", (_event, ctx) => apply(ctx, { type: "tool_end" }));

	// Observation only: returning nothing leaves the entries and the continuation to the gate.
	// package.json loads this extension before quality-gate.ts, so the footer bird listens while
	// the gate's check runs instead of after it.
	pi.on("agent_before_settle", (_event, ctx) => {
		apply(ctx, { type: "settle_check" });
		return undefined;
	});

	pi.on("agent_settled", (event, ctx) => {
		const gate = gateResultSince(ctx.sessionManager.getBranch(), gateBaseline);
		apply(ctx, { type: "settled", aborted: event.aborted, ...(gate ? { gate } : {}) });
	});

	pi.registerCommand("bird", {
		description: "Show or hide the woodpecker in the working indicator and footer: /bird on|off",
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();
			if (argument !== "on" && argument !== "off") {
				ctx.ui.notify(`bird: ${enabled ? "on" : "off"}; /bird on|off`, "info");
				return;
			}
			enabled = argument === "on";
			if (enabled) draw(ctx);
			else hide(ctx);
			ctx.ui.notify(`bird: ${argument}`, "info");
		},
	});
}
