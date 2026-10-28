/**
 * A scripted stand-in for the Anthropic Messages API, so the gates, the router and the
 * subagent wiring can be tested end to end with a real Pi and no API key or token cost.
 *
 * Every request is answered by `respond()`, which looks at the conversation and returns text
 * or tool calls. Each request is appended to `requests` for assertions.
 */

import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface ToolUse {
	name: string;
	input: Record<string, unknown>;
}
export type Reply = { text?: string; tools?: ToolUse[] };

export interface MockRequest {
	model: string;
	/** Request parameters other than messages, system and tools (thinking, effort, …). */
	params: Record<string, unknown>;
	/**
	 * The effort in force: the last in-conversation `output_config` marker, which Pi sends for
	 * models that change effort mid-conversation, else the top-level `output_config.effort`.
	 */
	effort: string | undefined;
	system: string;
	toolNames: string[];
	messages: { role: string; content: unknown }[];
	/** Text of the last user-role message, including tool results. */
	lastUserText: string;
	/** Text of the first user message (the task). */
	firstUserText: string;
	/** The latest `[scenario:name]` marker in a user message, and the assistant turns since. */
	scenario: string | undefined;
	stepInScenario: number;
}

export type Responder = (request: MockRequest) => Reply;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type?: string; text?: string; content?: unknown }) =>
			block.type === "text" ? (block.text ?? "") : block.type === "tool_result" ? textOf(block.content) : "",
		)
		.join("\n");
}

function systemText(system: unknown): string {
	if (typeof system === "string") return system;
	if (Array.isArray(system)) return system.map((block: { text?: string }) => block.text ?? "").join("\n");
	return "";
}

/** Tools added mid-conversation: Pi re-declares the "tools" prompt section in a system message. */
function declaredTools(messages: { role: string; content: unknown }[]): string[] {
	const sections = messages
		.filter((message) => message.role === "system")
		.map((message) => /<tools>([\s\S]*?)<\/tools>/.exec(textOf(message.content))?.[1])
		.filter((section): section is string => section !== undefined);
	const latest = sections.at(-1);
	return latest ? [...latest.matchAll(/^- ([\w-]+):/gm)].map((match) => match[1]) : [];
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8");
}

let counter = 0;
function sse(reply: Reply, model: string): string {
	const events: [string, unknown][] = [];
	const id = `msg_mock_${++counter}`;
	events.push([
		"message_start",
		{
			type: "message_start",
			message: {
				id,
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
			},
		},
	]);
	let index = 0;
	if (reply.text) {
		events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
		events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: reply.text } }]);
		events.push(["content_block_stop", { type: "content_block_stop", index }]);
		index++;
	}
	for (const tool of reply.tools ?? []) {
		const toolId = `toolu_mock_${++counter}`;
		events.push([
			"content_block_start",
			{ type: "content_block_start", index, content_block: { type: "tool_use", id: toolId, name: tool.name, input: {} } },
		]);
		events.push([
			"content_block_delta",
			{ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } },
		]);
		events.push(["content_block_stop", { type: "content_block_stop", index }]);
		index++;
	}
	events.push([
		"message_delta",
		{ type: "message_delta", delta: { stop_reason: reply.tools?.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } },
	]);
	events.push(["message_stop", { type: "message_stop" }]);
	return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

export class MockAnthropic {
	readonly requests: MockRequest[] = [];
	private server: Server | undefined;
	private readonly respond: Responder;
	port = 0;

	constructor(respond: Responder) {
		this.respond = respond;
	}

	async start(host = "127.0.0.1"): Promise<number> {
		this.server = createServer(async (req, res) => {
			if (req.method !== "POST" || !req.url?.includes("/v1/messages")) {
				res.writeHead(404).end();
				return;
			}
			const raw = await readBody(req);
			if (process.env.MOCK_DUMP) appendFileSync(process.env.MOCK_DUMP, raw + "\n");
			const body = JSON.parse(raw);
			const messages = body.messages as { role: string; content: unknown }[];
			const userMessages = messages.filter((message) => message.role === "user");
			const { messages: _m, system: _s, tools: _t, ...params } = body;
			let scenario: string | undefined;
			let stepInScenario = 0;
			for (let index = messages.length - 1; index >= 0; index--) {
				const match = messages[index].role === "user" ? /\[scenario:([\w-]+)\]/.exec(textOf(messages[index].content)) : null;
				if (match) {
					scenario = match[1];
					stepInScenario = messages.slice(index + 1).filter((message) => message.role === "assistant").length;
					break;
				}
			}
			const markers = messages.filter((message) => (message as { output_config?: { effort?: string } }).output_config?.effort);
			const effort =
				(markers.at(-1) as { output_config?: { effort?: string } } | undefined)?.output_config?.effort ??
				(params.output_config as { effort?: string } | undefined)?.effort;
			const request: MockRequest = {
				model: body.model,
				params,
				effort,
				system: systemText(body.system),
				toolNames: [...new Set([...(body.tools ?? []).map((tool: { name: string }) => tool.name), ...declaredTools(messages)])],
				messages,
				lastUserText: textOf(userMessages.at(-1)?.content),
				firstUserText: textOf(userMessages[0]?.content),
				scenario,
				stepInScenario,
			};
			this.requests.push(request);
			let reply: Reply;
			try {
				reply = this.respond(request);
			} catch (error) {
				reply = { text: `mock error: ${error instanceof Error ? error.message : String(error)}` };
			}
			if (!body.stream) {
				res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "mock only streams" }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.end(sse(reply, body.model));
		});
		await new Promise<void>((resolve) => this.server!.listen(0, host, resolve));
		const address = this.server.address();
		this.port = typeof address === "object" && address ? address.port : 0;
		return this.port;
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
	}
}
