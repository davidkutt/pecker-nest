/** Pure routing decisions for router.ts, kept free of Pi types so they can be unit-tested. */

export const PROVIDER = "openrouter";
export const FLASH = "deepseek/deepseek-v4.1-flash";
export const GLM = "z-ai/glm-5.3";

export type Tier = "flash" | "glm";
/** Why the session runs on its tier. Only `hard` outlives the next prompt you type. */
export type Why = "default" | "plan" | "hard" | "gate" | "loop" | "stuck";
export type Level = "high" | "max";

export interface RouterState {
	tier: Tier;
	why: Why;
	/** Set by /hard: GLM stays on for every prompt until /flash. */
	sticky?: boolean;
}

export const DEFAULT_STATE: RouterState = { tier: "flash", why: "default" };

/** GLM plans at max; everything else runs at high. */
export function levelFor(why: Why): Level {
	return why === "plan" ? "max" : "high";
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
	/** GLM is available and can read every message (no images, or GLM accepts images). */
	glmUsable: boolean;
}

export interface RouteDecision {
	state: RouterState;
	tier: Tier;
	level: Level;
	/** Set when the tier changes, for a notification. */
	notice?: string;
}

/** The next tier and thinking level. `state` is what the session records; `tier` is what runs. */
export function decide(input: RouteInput): RouteDecision {
	const current = input.state ?? DEFAULT_STATE;
	let state = current;
	let detail: string | undefined;

	if (input.reason === "user") {
		const sticky = input.hard ?? current.sticky ?? false;
		if (input.planRequested) state = { tier: "glm", why: "plan", ...(sticky ? { sticky } : {}) };
		else if (input.keepTier && input.hard === undefined) state = current;
		else if (sticky) state = { tier: "glm", why: "hard", sticky: true };
		else state = DEFAULT_STATE;
	} else if (current.tier === "flash") {
		const round = gateRound(input.messages);
		const stuck = stuckReason(input.messages);
		if (round >= 2) {
			state = { ...current, tier: "glm", why: "gate" };
			detail = `quality gate still red at repair round ${round}`;
		} else if (stuck) {
			state = { ...current, tier: "glm", why: stuck.why };
			detail = stuck.detail;
		}
	}

	// GLM 5.3 reads no images and may be filtered out by your OpenRouter settings; Flash takes over.
	const effective = (candidate: RouterState): Tier => (candidate.tier === "glm" && !input.glmUsable ? "flash" : candidate.tier);
	const tier = effective(state);
	const level = levelFor(state.why);
	const reason = `${state.why}${detail ? `: ${detail}` : ""}`;
	let notice: string | undefined;
	if (tier !== effective(current)) {
		notice = tier === "glm" ? `GLM 5.3 at ${level} (${reason})` : "back on DeepSeek V4.1 Flash";
	} else if (state.tier === "glm" && tier === "flash" && current.tier !== "glm") {
		notice = `staying on DeepSeek V4.1 Flash: GLM 5.3 cannot take this conversation (${reason})`;
	}
	return { state, tier, level, ...(notice ? { notice } : {}) };
}

/** Same state? Used to avoid storing an unchanged state, which Pi would record as a new entry. */
export function sameState(a: RouterState | undefined, b: RouterState): boolean {
	return a !== undefined && a.tier === b.tier && a.why === b.why && Boolean(a.sticky) === Boolean(b.sticky);
}
