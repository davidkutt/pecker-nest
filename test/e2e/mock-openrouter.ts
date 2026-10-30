/**
 * A scripted stand-in for the OpenRouter chat-completions API, so the gates, the router and
 * the subagent wiring can be tested end to end with a real Pi and no API key or token cost.
 *
 * Every request is answered by `respond()`, which looks at the conversation and returns text
 * or tool calls. Each request is appended to `requests` for assertions. `GET /models/user`
 * answers 404, so Pi keeps its bundled OpenRouter catalog, as it does behind a proxy.
 */

import { appendFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface ToolUse {
	name: string;
	input: Record<string, unknown>;
}
export type Reply = { text?: string; tools?: ToolUse[] };

export interface ChatMessage {
	role: string;
	content?: unknown;
	tool_calls?: { function?: { name?: string } }[];
}

export interface MockRequest {
	/** OpenRouter model ID, e.g. `z-ai/glm-5.3`. */
	model: string;
	/** `reasoning.effort` as Pi sent it. */
	effort: string | undefined;
	/** OpenRouter provider-routing preferences (the `provider` body field). */
	routing: unknown;
	/** The `x-session-id` header OpenRouter uses for sticky provider routing. */
	sessionId: string | undefined;
	/** Leading system prompt. */
	system: string;
	/** Tools declared in `tools` plus tools added mid-conversation in a system message. */
	toolNames: string[];
	messages: ChatMessage[];
	/** Text of every message after the last assistant message: tool results and user input. */
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
	return content.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

/** Tools added mid-conversation: Pi re-declares the "tools" prompt section in a system message. */
function declaredTools(messages: ChatMessage[]): string[] {
	const sections = messages
		.filter((message) => message.role === "system" || message.role === "developer")
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
	const id = `gen-mock-${++counter}`;
	const chunk = (delta: unknown, finish: string | null = null, usage?: unknown) =>
		`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
	let out = chunk({ role: "assistant", content: "" });
	if (reply.text) out += chunk({ content: reply.text });
	(reply.tools ?? []).forEach((tool, index) => {
		out += chunk({
			tool_calls: [{ index, id: `call_mock_${++counter}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) } }],
		});
	});
	const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 0 } };
	out += chunk({}, reply.tools?.length ? "tool_calls" : "stop", usage);
	return `${out}data: [DONE]\n\n`;
}

export class MockOpenRouter {
	readonly requests: MockRequest[] = [];
	private server: Server | undefined;
	private readonly respond: Responder;
	port = 0;

	constructor(respond: Responder) {
		this.respond = respond;
	}

	async start(host = "127.0.0.1"): Promise<number> {
		this.server = createServer(async (req, res) => {
			if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
				res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
				return;
			}
			const raw = await readBody(req);
			if (process.env.MOCK_DUMP) appendFileSync(process.env.MOCK_DUMP, `${raw}\n`);
			const body = JSON.parse(raw);
			const messages = body.messages as ChatMessage[];
			const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
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
			const request: MockRequest = {
				model: body.model,
				effort: body.reasoning?.effort,
				routing: body.provider,
				sessionId: req.headers["x-session-id"] as string | undefined,
				system: messages[0]?.role === "system" ? textOf(messages[0].content) : "",
				toolNames: [
					...new Set([...(body.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name), ...declaredTools(messages)]),
				],
				messages,
				lastUserText: messages
					.slice(lastAssistant + 1)
					.filter((message) => message.role === "user" || message.role === "tool")
					.map((message) => textOf(message.content))
					.join("\n"),
				firstUserText: textOf(messages.find((message) => message.role === "user")?.content),
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
