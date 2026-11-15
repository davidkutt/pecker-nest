/**
 * Provider log: records which upstream OpenRouter provider served each request, so the session
 * report can show request errors, failed tool calls and failed edits per model and provider
 * (the planning rule: tool errors that cluster on one provider mean pinning providers).
 *
 * Pi stores OpenRouter's generation ID on the assistant message (`responseId`) but not the
 * provider. OpenRouter names the provider in every stream chunk, and Pi hands extensions the raw
 * chunks (`provider_stream_event`), so the provider is taken there and written as a
 * `nest-provider` session entry at the end of the turn. No request, no key, no cost: the report
 * stays offline. A request that fails before a stream starts has no entry; the report then reads
 * the provider from the error body, where OpenRouter names one, and shows "–" otherwise.
 *
 * Loaded in the main session and in every subagent (agent/settings.json).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chunkProvider, PROVIDER_ENTRY, type ProviderRecord } from "./lib/provider-log.ts";
import { PROVIDER } from "./lib/router-logic.ts";

/** Streams seen since the last turn ended; a turn has one, a retried turn a few. */
const MAX_OPEN = 32;

export default function (pi: ExtensionAPI) {
	const open = new Map<string, string>();

	pi.on("provider_stream_event", (event) => {
		if (event.provider !== PROVIDER) return undefined;
		const { responseId, provider } = chunkProvider(event.data);
		if (!responseId || !provider || open.has(responseId)) return undefined;
		if (open.size >= MAX_OPEN) open.delete(open.keys().next().value as string);
		open.set(responseId, provider);
		return undefined;
	});

	pi.on("turn_end", (event) => {
		const message = event.message;
		if (message.role !== "assistant") return undefined;
		const responseId = message.responseId;
		const provider = responseId ? open.get(responseId) : undefined;
		open.clear();
		if (!responseId || !provider) return undefined;
		// A subagent may load this extension twice (as part of the package and by name).
		const recorded = event.entries.some((entry) => entry.type === "custom" && entry.customType === PROVIDER_ENTRY && (entry.data as ProviderRecord | undefined)?.responseId === responseId);
		if (recorded) return undefined;
		const data: ProviderRecord = { responseId, provider, model: message.model };
		return { entries: [...event.entries, { type: "custom" as const, customType: PROVIDER_ENTRY, data }] };
	});
}
