/**
 * Which upstream provider served a request. OpenRouter names it in the `provider` field of every
 * stream chunk, next to the generation ID Pi keeps as `responseId`. Kept free of Pi types so the
 * session report and the tests can use it.
 */

/** The session entry (`type: "custom"`) that ties a response ID to the provider that served it. */
export const PROVIDER_ENTRY = "nest-provider";

export interface ProviderRecord {
	/** The response's ID as Pi stores it on the assistant message (`responseId`). */
	responseId: string;
	/** The upstream provider as OpenRouter names it, e.g. `DeepInfra`. */
	provider: string;
	/** The model ID the request asked for. */
	model?: string;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Response ID and upstream provider of one raw stream chunk, as far as the chunk names them. */
export function chunkProvider(data: unknown): { responseId?: string; provider?: string } {
	if (!data || typeof data !== "object" || Array.isArray(data)) return {};
	const chunk = data as { id?: unknown; provider?: unknown };
	const responseId = text(chunk.id);
	const provider = text(chunk.provider);
	return { ...(responseId ? { responseId } : {}), ...(provider ? { provider } : {}) };
}

/**
 * The provider a failed request names. No stream arrives for an HTTP error, but OpenRouter's
 * error body carries `metadata.provider_name` when an upstream provider rejected the request,
 * and Pi keeps that body in the error message.
 */
export function providerFromError(errorMessage: string | undefined): string | undefined {
	if (!errorMessage) return undefined;
	return /"provider_name"\s*:\s*"((?:[^"\\]|\\.)+)"/.exec(errorMessage)?.[1]?.replace(/\\(.)/g, "$1");
}
