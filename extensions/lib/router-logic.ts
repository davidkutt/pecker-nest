/** Pure routing decisions for router.ts, kept free of Pi types so they can be unit-tested. */

export type Phase = "plan" | "build";
export interface RouterState {
	phase: Phase;
}

export const PROVIDER = "anthropic";
export const PLAN_MODEL = "claude-opus-5-5";
export const BUILD_MODEL = "claude-sonnet-5-5";

const LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type RouterLevel = (typeof LEVELS)[number];
export const ROUTER_LEVELS: RouterLevel[] = ["medium", "high", "xhigh"];

/** Planning uses the selected level on Opus; building runs one level lower on Sonnet. */
export function physicalLevel(phase: Phase, selected: string): RouterLevel {
	const index = Math.max(0, LEVELS.indexOf(selected as RouterLevel));
	return phase === "plan" ? LEVELS[index] : LEVELS[Math.max(0, index - 1)];
}

/** Changes to these files do not end the plan phase: writing PLAN.md is still planning. */
export function isDocsPath(path: string): boolean {
	return /\.(md|mdx|markdown|rst|adoc)$/i.test(path);
}

interface MessageLike {
	role: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

/** Whether a code file was edited successfully since the last user message. */
export function editedCodeSinceLastUser(messages: readonly MessageLike[]): boolean {
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	const recent = messages.slice(lastUser + 1);
	const paths = new Map<string, string>();
	for (const message of recent) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as { type?: string; id?: string; arguments?: { path?: unknown } }[]) {
			if (block.type === "toolCall" && block.id && typeof block.arguments?.path === "string") {
				paths.set(block.id, block.arguments.path);
			}
		}
	}
	return recent.some(
		(message) =>
			message.role === "toolResult" &&
			(message.toolName === "edit" || message.toolName === "write") &&
			!message.isError &&
			!isDocsPath(paths.get(message.toolCallId ?? "") ?? ""),
	);
}

/**
 * The phase for the next request. `planRequested` is set when the user starts a new task
 * with /plan, which always returns to Opus.
 */
export function nextPhase(state: RouterState | undefined, messages: readonly MessageLike[], planRequested: boolean): Phase {
	if (planRequested) return "plan";
	const phase = state?.phase ?? "plan";
	if (phase === "plan" && editedCodeSinceLastUser(messages)) return "build";
	return phase;
}
