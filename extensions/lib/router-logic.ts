/** Pure routing decisions for router.ts, kept free of Pi types so they can be unit-tested. */

export const PROVIDER = "openrouter";
export const FLASH = "deepseek/deepseek-v4.1-flash-1017";
export const GLM = "z-ai/glm-5.3";
export const KIMI = "moonshotai/kimi-k3.1-pro";

/**
 * The model the router calls in for /plan, escalations and /hard. GLM 5.3 is the default;
 * `/strong kimi` swaps in Kimi K3.1 Pro so the two can be compared on the same steps.
 */
export type Strong = "glm" | "kimi";

export const STRONG_MODELS: Record<Strong, { id: string; name: string }> = {
	glm: { id: GLM, name: "GLM 5.3" },
	kimi: { id: KIMI, name: "Kimi K3.1 Pro" },
};

export const DEFAULT_STRONG: Strong = "glm";

export function isStrong(value: unknown): value is Strong {
	return value === "glm" || value === "kimi";
}

/** The tier a request runs on. `strong` is whichever model `/strong` selected. */
export type Tier = "flash" | "strong";
/** Why the session runs on its tier. Only `hard` outlives the next prompt you type. */
export type Why = "default" | "plan" | "hard" | "gate" | "loop" | "stuck";
export type Level = "high" | "max";

export interface RouterState {
	tier: Tier;
	why: Why;
	/** Set by /hard: the strong model stays on for every prompt until /flash. */
	sticky?: boolean;
	/** Which strong model /strong selected; absent means the default (GLM). */
	strong?: Strong;
}

export const DEFAULT_STATE: RouterState = { tier: "flash", why: "default" };

/**
 * The strong model a stored state asks for. States written before /strong existed carry
 * `tier: "glm"` and no `strong`, so they keep reading as GLM.
 */
export function strongOf(state: RouterState | undefined): Strong {
	return isStrong(state?.strong) ? state.strong : DEFAULT_STRONG;
}

/** Normalizes a stored state: the old `tier: "glm"` means the strong tier. */
export function readState(state: unknown): RouterState | undefined {
	if (!state || typeof state !== "object") return undefined;
	const raw = state as { tier?: unknown; why?: unknown; sticky?: unknown; strong?: unknown };
	const tier: Tier = raw.tier === "strong" || raw.tier === "glm" ? "strong" : "flash";
	const why = (["default", "plan", "hard", "gate", "loop", "stuck"] as const).find((candidate) => candidate === raw.why) ?? "default";
	return {
		tier,
		why,
		...(raw.sticky ? { sticky: true } : {}),
		...(isStrong(raw.strong) ? { strong: raw.strong } : {}),
	};
}

/**
 * The strong tier always runs at max: Z.ai and Moonshot both publish their coding results at
 * max, and an escalation means Flash is already stuck. Flash runs at high, except for a /plan
 * that has to stay on Flash (the strong model cannot take the conversation), which keeps max.
 */
export function levelFor(tier: Tier, why: Why): Level {
	return tier === "strong" || why === "plan" ? "max" : "high";
}

/** Changes to these files do not count as code: writing PLAN.md is still planning. */
export function isDocsPath(path: string): boolean {
	return /\.(md|mdx|markdown|rst|adoc)$/i.test(path);
}

export interface MessageLike {
	role: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

interface ContentBlock {
	type?: string;
	id?: string;
	name?: string;
	text?: string;
	arguments?: unknown;
}

function blocks(message: MessageLike): ContentBlock[] {
	return Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
}

function textOf(message: MessageLike): string {
	if (typeof message.content === "string") return message.content;
	return blocks(message)
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

/** Whether any message carries an image (a pasted screenshot, an image a tool returned). */
export function hasImages(messages: readonly MessageLike[]): boolean {
	return messages.some((message) => blocks(message).some((block) => block.type === "image"));
}

/**
 * The quality gate's repair round that the latest user-role message asks for, or 0. Pi sends the
 * gate's custom message to the model as a user message starting with `[quality-gate]`.
 */
export function gateRound(messages: readonly MessageLike[]): number {
	const last = messages.findLast((message) => message.role === "user");
	if (!last) return 0;
	const match = /^\[quality-gate\][^\n]*Repair round (\d+) of \d+/.exec(textOf(last).trimStart());
	return match ? Number(match[1]) : 0;
}

/** Stable JSON: object keys sorted, so `{a,b}` and `{b,a}` compare equal. */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export interface ToolStep {
	id: string;
	name: string;
	/** Tool name plus arguments as stable JSON; equal keys mean an identical call. */
	key: string;
	path?: string;
	isError?: boolean;
}

/** Tool calls since the latest user-role message, oldest first, each with its result's error flag. */
export function trailingToolSteps(messages: readonly MessageLike[]): ToolStep[] {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	const steps: ToolStep[] = [];
	const byId = new Map<string, ToolStep>();
	for (const message of messages.slice(lastUser + 1)) {
		if (message.role === "assistant") {
			for (const block of blocks(message)) {
				if (block.type !== "toolCall" || !block.name) continue;
				const args = block.arguments as { path?: unknown } | undefined;
				const step: ToolStep = {
					id: block.id ?? "",
					name: block.name,
					key: `${block.name} ${stableJson(block.arguments ?? {})}`,
					...(typeof args?.path === "string" ? { path: args.path } : {}),
				};
				steps.push(step);
				if (step.id) byId.set(step.id, step);
			}
		} else if (message.role === "toolResult" && message.toolCallId) {
			const step = byId.get(message.toolCallId);
			if (step) step.isError = Boolean(message.isError);
		}
	}
	return steps;
}

export const LOOP_REPEATS = 3;
export const FAILED_EDITS = 3;
export const ERROR_STREAK = 5;

/**
 * Why the agent looks stuck, or undefined. Looks only at tool calls since the latest user-role
 * message (a gate repair message starts a fresh window):
 * - `loop`: the last three tool calls are identical (same tool, same arguments);
 * - `stuck`: the last three edit/write calls on one file failed, or the last five tool calls failed.
 */
export function stuckReason(messages: readonly MessageLike[]): { why: "loop" | "stuck"; detail: string } | undefined {
	const steps = trailingToolSteps(messages).filter((step) => step.isError !== undefined);
	const lastSame = steps.slice(-LOOP_REPEATS);
	if (lastSame.length === LOOP_REPEATS && lastSame.every((step) => step.key === lastSame[0].key)) {
		return { why: "loop", detail: `the same ${lastSame[0].name} call ${LOOP_REPEATS} times in a row` };
	}
	const edits = steps.filter((step) => (step.name === "edit" || step.name === "write") && step.path);
	const lastEdits = edits.slice(-FAILED_EDITS);
	if (lastEdits.length === FAILED_EDITS && lastEdits.every((step) => step.isError && step.path === lastEdits[0].path)) {
		return { why: "stuck", detail: `${FAILED_EDITS} failed edits on ${lastEdits[0].path}` };
	}
	const lastErrors = steps.slice(-ERROR_STREAK);
	if (lastErrors.length === ERROR_STREAK && lastErrors.every((step) => step.isError)) {
		return { why: "stuck", detail: `${ERROR_STREAK} failed tool calls in a row` };
	}
	return undefined;
}

export interface RouteInput {
	reason: "user" | "continuation";
	state: RouterState | undefined;
	messages: readonly MessageLike[];
	/** The prompt you typed starts with /plan. */
	planRequested: boolean;
	/** The request follows a steering, follow-up or extension message: keep the current tier. */
	keepTier: boolean;
	/** /hard (true) or /flash (false) was used since the last request. */
	hard?: boolean;
	/** The strong model /strong selected since the last request. */
	strong?: Strong;
	/** The strong model is available and can read every message (no images, or it accepts them). */
	strongUsable: boolean;
	/** The strong model that is actually reachable, when it is not the selected one (fallback). */
	strongFallback?: Strong;
}

export interface RouteDecision {
	state: RouterState;
	tier: Tier;
	level: Level;
	/** The strong model this decision runs on, or would run on. */
	strong: Strong;
	/** Set when the tier changes, for a notification. */
	notice?: string;
}

/** The display name of a strong model, for notices. */
export function strongName(strong: Strong): string {
	return STRONG_MODELS[strong].name;
}

/** The next tier and thinking level. `state` is what the session records; `tier` is what runs. */
export function decide(input: RouteInput): RouteDecision {
	const current = input.state ?? DEFAULT_STATE;
	// /strong, like /hard, takes effect with the prompt you type next and is then remembered.
	const selected = input.reason === "user" && input.strong !== undefined ? input.strong : strongOf(current);
	const keep = (why: Why, extra: Partial<RouterState> = {}): RouterState => ({
		tier: "strong",
		why,
		...extra,
		...(selected === DEFAULT_STRONG ? {} : { strong: selected }),
	});
	let state = current;
	let detail: string | undefined;

	if (input.reason === "user") {
		const sticky = input.hard ?? current.sticky ?? false;
		if (input.planRequested) state = keep("plan", sticky ? { sticky } : {});
		else if (input.keepTier && input.hard === undefined && input.strong === undefined) state = current;
		else if (sticky) state = keep("hard", { sticky: true });
		else state = selected === DEFAULT_STRONG ? DEFAULT_STATE : { ...DEFAULT_STATE, strong: selected };
	} else if (current.tier === "flash") {
		const round = gateRound(input.messages);
		const stuck = stuckReason(input.messages);
		if (round >= 2) {
			state = { ...current, tier: "strong", why: "gate" };
			detail = `quality gate still red at repair round ${round}`;
		} else if (stuck) {
			state = { ...current, tier: "strong", why: stuck.why };
			detail = stuck.detail;
		}
	}

	// The model that will actually serve the strong tier: the selected one, or the fallback the
	// registry left us. GLM 5.3 reads no images, and ZDR may leave a model without a provider.
	const strong = input.strongFallback ?? selected;
	const effective = (candidate: RouterState): Tier => (candidate.tier === "strong" && !input.strongUsable ? "flash" : candidate.tier);
	const tier = effective(state);
	const level = levelFor(tier, state.why);
	const reason = `${state.why}${detail ? `: ${detail}` : ""}`;
	let notice: string | undefined;
	if (tier !== effective(current)) {
		notice = tier === "strong" ? `${strongName(strong)} at ${level} (${reason})` : "back on DeepSeek V4.1 Flash";
	} else if (state.tier === "strong" && tier === "flash" && current.tier !== "strong") {
		notice = `staying on DeepSeek V4.1 Flash: ${strongName(strong)} cannot take this conversation (${reason})`;
	}
	return { state, tier, level, strong, ...(notice ? { notice } : {}) };
}

/** Same state? Used to avoid storing an unchanged state, which Pi would record as a new entry. */
export function sameState(a: RouterState | undefined, b: RouterState): boolean {
	return (
		a !== undefined &&
		a.tier === b.tier &&
		a.why === b.why &&
		Boolean(a.sticky) === Boolean(b.sticky) &&
		strongOf(a) === strongOf(b)
	);
}
