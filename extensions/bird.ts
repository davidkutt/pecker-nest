/**
 * The woodpecker: an ASCII bird in Pi's working indicator and footer, and on its own perch above
 * the editor, that shows what the agent is doing (lib/bird.ts and lib/bird-perch.ts hold the logic).
 *
 * - It looks around while the agent reads, pecks while it edits or writes, drums while bash runs,
 *   blinks while it thinks, and listens at the trunk while the run settles.
 * - It turns red while the strong model (GLM 5.3 or Kimi K3.1 Pro) answers, and drums fast and
 *   yellow in a repair round of the quality gate. The footer names the strong model and the round.
 * - After a run the footer keeps the result: gate ok with its seconds, gate red, stopped, or done.
 * - The perch (interactive mode only) is five rows above the editor and always visible: every edit
 *   deepens a hole in the trunk, strikes throw chips, a speech bubble says what is going on with
 *   counts only. Between runs it blinks, falls asleep after five minutes and looks out at you while
 *   you type. Of the keystrokes it only notes the time; it never reads or consumes them.
 * - /bird on|minimal|off switches it for this process (minimal: indicator and footer, no perch);
 *   PI_NEST_BIRD=minimal or PI_NEST_BIRD=off starts Pi that way.
 * - Without a UI (print and JSON mode, headless runs in the container) it does nothing.
 *
 * It only reads: Pi's events, the model of each answer and quality-gate.ts's session entries.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BirdEvent, countGateResults, footer, gateResultSince, IDLE, indicator, next, type Paint, repairRound } from "./lib/bird.ts";
import { advanceClock, noteInput, perch, perchInterval, startClock, WATCH_MS } from "./lib/bird-perch.ts";

const STATUS_KEY = "nest-bird";
const PERCH_KEY = "nest-bird-perch";

type Mode = "on" | "minimal" | "off";

function modeFrom(value: string | undefined): Mode | undefined {
	const mode = value?.trim().toLowerCase();
	return mode === "on" || mode === "minimal" || mode === "off" ? mode : undefined;
}

export default function (pi: ExtensionAPI) {
	let mode: Mode = modeFrom(process.env.PI_NEST_BIRD) ?? "on";
	let state = IDLE;
	let clock = startClock(Date.now());
	/** The indicator key last handed to Pi; setting the same frames again would restart the animation. */
	let shownKey: string | undefined;
	/** The footer text last handed to Pi; RPC mode sends every setStatus to the client, so only changes go out. */
	let shownFooter: string | undefined;
	/** Gate results on the branch when the run started, so an older result is not taken for this run's. */
	let gateBaseline = 0;
	/** Whether the perch widget is registered with Pi. */
	let perchShown = false;
	/** The perch component while Pi shows it; `refresh` redraws it now and restarts its clock. */
	let perchView: { refresh(): void } | undefined;
	let stopInput: (() => void) | undefined;

	/** Registers the perch: a component that draws from the current state and redraws on its own clock. */
	function showPerch(ctx: ExtensionContext) {
		if (mode !== "on" || ctx.mode !== "tui" || perchShown) return;
		perchShown = true;
		ctx.ui.setWidget(
			PERCH_KEY,
			(tui, theme) => {
				const paint: Paint = (color, text) => theme.fg(color, text);
				const draw = (width: number) => perch(state, clock, Date.now(), width, paint);
				let timer: ReturnType<typeof setTimeout> | undefined;
				let width: number | undefined;
				let shown = "";
				const schedule = () => {
					clearTimeout(timer);
					timer = setTimeout(tick, perchInterval(state, clock, Date.now()));
					// The perch never keeps Pi alive.
					timer.unref?.();
				};
				// Asks Pi for a render only when the perch's lines changed (a blink, a frame, a chip).
				const tick = () => {
					if (width !== undefined && draw(width).join("\n") !== shown) tui.requestRender();
					schedule();
				};
				const view = {
					render(available: number): string[] {
						width = available;
						const lines = draw(available);
						shown = lines.join("\n");
						return lines;
					},
					invalidate() {},
					dispose() {
						clearTimeout(timer);
						timer = undefined;
						if (perchView === view) perchView = undefined;
					},
					refresh() {
						tui.requestRender();
						schedule();
					},
				};
				perchView = view;
				schedule();
				return view;
			},
			{ placement: "aboveEditor" },
		);
	}

	function hidePerch(ctx: ExtensionContext) {
		perchShown = false;
		perchView = undefined;
		if (ctx.mode === "tui") ctx.ui.setWidget(PERCH_KEY, undefined);
	}

	function draw(ctx: ExtensionContext) {
		if (mode === "off" || !ctx.hasUI) return;
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
		if (mode === "on") {
			showPerch(ctx);
			perchView?.refresh();
		}
	}

	function hide(ctx: ExtensionContext) {
		shownKey = undefined;
		shownFooter = undefined;
		hidePerch(ctx);
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingIndicator();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function apply(ctx: ExtensionContext, event: BirdEvent) {
		const before = state;
		state = next(state, event);
		clock = advanceClock(clock, before, state, Date.now());
		draw(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		state = IDLE;
		clock = startClock(Date.now());
		shownKey = undefined;
		shownFooter = undefined;
		perchShown = false;
		perchView = undefined;
		stopInput?.();
		stopInput = undefined;
		if (ctx.mode === "tui") {
			// Only the time of a keystroke: it wakes the bird and makes it look out. Nothing is consumed.
			stopInput = ctx.ui.onTerminalInput(() => {
				const now = Date.now();
				const watching = clock.inputAt !== undefined && now - clock.inputAt < WATCH_MS;
				clock = noteInput(clock, now);
				if (!watching) perchView?.refresh();
				return undefined;
			});
		}
		draw(ctx);
	});

	pi.on("session_shutdown", () => {
		stopInput?.();
		stopInput = undefined;
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
		description: "The woodpecker: /bird on (indicator, footer and perch), /bird minimal (no perch), /bird off",
		handler: async (args, ctx) => {
			const chosen = modeFrom(args);
			if (!chosen) {
				ctx.ui.notify(`bird: ${mode}; /bird on|minimal|off`, "info");
				return;
			}
			mode = chosen;
			if (mode === "off") hide(ctx);
			else {
				if (mode === "minimal") hidePerch(ctx);
				draw(ctx);
			}
			ctx.ui.notify(`bird: ${mode}`, "info");
		},
	});
}
