/**
 * The woodpecker: an ASCII bird on its own perch above the editor that shows what the agent is
 * doing, plus a text line in the footer (lib/bird.ts, lib/bird-perch.ts and lib/bird-meter.ts hold
 * the logic).
 *
 * - It looks around while the agent reads, pecks while it edits or writes, drums while bash runs,
 *   blinks while it thinks, and listens at the trunk while the run settles.
 * - It turns red while the strong model (GLM 5.3 or Kimi K3.1 Pro) answers, and drums fast and
 *   yellow in a repair round of the quality gate. The footer names the strong model and the round.
 * - After a run the footer keeps the result: gate ok with its seconds, gate red, stopped, or done.
 * - The perch (interactive mode only) is five rows above the editor and always visible: every edit
 *   deepens a hole in the trunk, strikes throw chips, a speech bubble says what is going on with
 *   counts only. Between runs it blinks, falls asleep after five minutes and looks out at you while
 *   you type. Of the keystrokes it only notes the time; it never reads or consumes them. While the
 *   perch is shown, Pi's working indicator keeps its message and drops its spinner.
 * - The meter (docs/tasks/bird-meter.md): the trunk's bark fills bottom-up with the context until
 *   Pi's auto-compaction (yellow from 70%, red from 90%), not the whole window. Crossing 70% or 90%
 *   puts up a note, a compaction sheds chips off the trunk, the bubbles add the run's cost, and a
 *   green gate from 70% suggests /compact. The footer adds `ctx N%` from 50%. Context and cost are
 *   read on events, never per frame.
 * - /meter prints context and cost, /meter context and /meter cost one of them; it works with
 *   /bird off too.
 * - /bird on|off switches it for this process; PI_NEST_BIRD=off starts Pi without it.
 * - Without a UI (print and JSON mode, headless runs in the container) it does nothing.
 *
 * It only reads: Pi's events, the model of each answer, quality-gate.ts's session entries, the
 * context usage, the cost in the session entries and the effective compaction settings. It writes
 * no entry and no file and calls no model; bubbles and /meter hold counts and money only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type BirdEvent, countGateResults, footer, gateResultSince, IDLE, next, type Paint, repairRound } from "./lib/bird.ts";
import {
	compactionPoint,
	METER_IDLE,
	METER_USAGE,
	type MeterEvent,
	type MeterReading,
	type ModelRef,
	meterReport,
	nextMeter,
	reportKind,
	runOf,
	sessionCost,
} from "./lib/bird-meter.ts";
import { advanceClock, noteInput, perch, perchInterval, startClock, WATCH_MS } from "./lib/bird-perch.ts";

const STATUS_KEY = "nest-bird";
const PERCH_KEY = "nest-bird-perch";

type Mode = "on" | "off";

function modeFrom(value: string | undefined): Mode | undefined {
	const mode = value?.trim().toLowerCase();
	return mode === "on" || mode === "off" ? mode : undefined;
}

export default function (pi: ExtensionAPI) {
	let mode: Mode = modeFrom(process.env.PI_NEST_BIRD) ?? "on";
	let state = IDLE;
	let clock = startClock(Date.now());
	/** Context until compaction, the run's cost, notes and the compaction scene (lib/bird-meter.ts). */
	let meter = METER_IDLE;
	/** Whether Pi's working indicator spinner is hidden, so the perch is the only bird. */
	let spinnerHidden = false;
	/** The footer text last handed to Pi ("" for none); RPC mode sends every setStatus to the client, so only changes go out. */
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
		if (mode === "off" || ctx.mode !== "tui" || perchShown) return;
		perchShown = true;
		ctx.ui.setWidget(
			PERCH_KEY,
			(tui, theme) => {
				const paint: Paint = (color, text) => theme.fg(color, text);
				const draw = (width: number) => perch(state, clock, Date.now(), width, paint, meter.view);
				let timer: ReturnType<typeof setTimeout> | undefined;
				let width: number | undefined;
				let shown = "";
				const schedule = () => {
					clearTimeout(timer);
					timer = setTimeout(tick, perchInterval(state, clock, Date.now(), meter.view));
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
		const line = footer(state, paint, meter.view.context?.fill) ?? "";
		if (line !== shownFooter) {
			shownFooter = line;
			ctx.ui.setStatus(STATUS_KEY, line || undefined);
		}
		if (ctx.mode === "tui") {
			// The perch shows what the agent does; the working indicator keeps only Pi's message.
			if (!spinnerHidden) {
				spinnerHidden = true;
				ctx.ui.setWorkingIndicator({ frames: [] });
			}
			showPerch(ctx);
			perchView?.refresh();
		}
	}

	function hide(ctx: ExtensionContext) {
		shownFooter = undefined;
		hidePerch(ctx);
		if (spinnerHidden) ctx.ui.setWorkingIndicator();
		spinnerHidden = false;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function apply(ctx: ExtensionContext, event: BirdEvent) {
		const before = state;
		state = next(state, event);
		clock = advanceClock(clock, before, state, Date.now());
		draw(ctx);
	}

	/**
	 * What the meter reads: Pi's context usage (the routed model's window), the compaction point
	 * from the selected model's settings, and the cost of every session entry. O(n) in the entries,
	 * so only on events.
	 */
	function readMeter(ctx: ExtensionContext, selected: ModelRef | undefined): MeterReading {
		const usage = ctx.getContextUsage();
		return {
			...(usage ? { context: { tokens: usage.tokens, point: compactionPoint(pi.getSettings().compaction, selected, usage.contextWindow) } } : {}),
			sessionCost: sessionCost(ctx.sessionManager.getEntries()),
		};
	}

	/**
	 * Feeds a fresh reading to the meter, also with /bird off, so /meter knows the run. Draws unless
	 * `redraw` is false (the caller draws right after); `selected` overrides `ctx.model`.
	 */
	function measure(ctx: ExtensionContext, event: (reading: MeterReading) => MeterEvent, options: { redraw?: boolean; selected?: ModelRef } = {}) {
		if (!ctx.hasUI) return;
		meter = nextMeter(meter, event(readMeter(ctx, options.selected ?? ctx.model)));
		if (options.redraw ?? true) draw(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		state = IDLE;
		clock = startClock(Date.now());
		meter = METER_IDLE;
		measure(ctx, (reading) => ({ type: "reset", reading }), { redraw: false });
		spinnerHidden = false;
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
		if (!state.running) {
			gateBaseline = countGateResults(ctx.sessionManager.getBranch());
			measure(ctx, (reading) => ({ type: "run_start", reading }), { redraw: false });
		}
		apply(ctx, { type: "run_start" });
	});

	pi.on("turn_start", (_event, ctx) => {
		const repair = repairRound(ctx.sessionManager.getBranch());
		apply(ctx, { type: "turn_start", ...(repair ? { repair } : {}) });
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "assistant") apply(ctx, { type: "model", modelId: event.message.model });
	});

	// Pi hands message_end and tool_execution_end to extensions before it stores the message, and
	// a read there misses it (before the first answer Pi's estimate then counts the system prompt).
	// agent-core awaits every event, so the next one sees what Pi stored: when a tool starts, the
	// answer that called it (its tokens and cost) is in the session; at turn_end Pi has resolved
	// the stored answer and every tool result (the trailing estimate, a subagent's cost).
	pi.on("tool_execution_start", (event, ctx) => {
		measure(ctx, (reading) => ({ type: "read", reading, at: Date.now() }), { redraw: false });
		apply(ctx, { type: "tool_start", toolName: event.toolName });
	});
	pi.on("tool_execution_end", (_event, ctx) => apply(ctx, { type: "tool_end" }));

	// Observation only: returning nothing leaves the turn to the other extensions.
	pi.on("turn_end", (_event, ctx) => {
		measure(ctx, (reading) => ({ type: "read", reading, at: Date.now() }));
		return undefined;
	});

	// Observation only: returning nothing leaves the entries and the continuation to the gate.
	// package.json loads this extension before quality-gate.ts, so the footer bird listens while
	// the gate's check runs instead of after it.
	pi.on("agent_before_settle", (_event, ctx) => {
		apply(ctx, { type: "settle_check" });
		return undefined;
	});

	pi.on("agent_settled", (event, ctx) => {
		const gate = gateResultSince(ctx.sessionManager.getBranch(), gateBaseline);
		measure(ctx, (reading) => ({ type: "run_end", reading, at: Date.now() }), { redraw: false });
		apply(ctx, { type: "settled", aborted: event.aborted, ...(gate ? { gate } : {}) });
	});

	pi.on("session_compact", (event, ctx) => {
		const { tokensBefore } = event.compactionEntry;
		measure(ctx, (reading) => ({ type: "compacted", reading, tokensBefore, overflow: event.reason === "overflow", at: Date.now() }));
	});

	pi.on("session_compact_failed", (event, ctx) => {
		if (!event.aborted) measure(ctx, () => ({ type: "compact_failed", at: Date.now() }));
	});

	// The newly selected model's compaction settings move the point.
	pi.on("model_select", (event, ctx) => measure(ctx, (reading) => ({ type: "read", reading, at: Date.now() }), { selected: event.model }));
	pi.on("session_tree", (_event, ctx) => measure(ctx, (reading) => ({ type: "read", reading, at: Date.now() })));

	pi.registerCommand("bird", {
		description: "The woodpecker: /bird on (perch above the editor and footer line), /bird off",
		handler: async (args, ctx) => {
			const chosen = modeFrom(args);
			if (!chosen) {
				ctx.ui.notify(`bird: ${mode}; /bird on|off`, "info");
				return;
			}
			mode = chosen;
			if (mode === "off") hide(ctx);
			else draw(ctx);
			ctx.ui.notify(`bird: ${mode}`, "info");
		},
	});

	pi.registerCommand("meter", {
		description: "Context until compaction and cost: /meter, /meter context, /meter cost (also with /bird off)",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const kind = reportKind(args);
			if (!kind) {
				ctx.ui.notify(METER_USAGE, "info");
				return;
			}
			const reading = readMeter(ctx, ctx.model);
			ctx.ui.notify(meterReport(kind, reading, runOf(meter, reading)), "info");
		},
	});
}
