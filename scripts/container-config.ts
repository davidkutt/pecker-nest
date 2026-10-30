/**
 * Builds the container's view of the agent configuration; docker/Dockerfile.pi runs it after
 * scripts/link.sh.
 *
 * The knowledge base runs only on the host. MCP servers that live there, stdio commands and
 * URLs on localhost, are switched off in the container, and subagents lose the `mcp:` tools of
 * those servers instead of failing to start. Servers on other hosts stay as they are.
 *
 *   node scripts/container-config.ts <agent-dir>
 */

import { lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface McpServer {
	command?: string;
	url?: string;
	enabled?: boolean;
	[key: string]: unknown;
}
export interface McpConfig {
	mcpServers: Record<string, McpServer>;
	[key: string]: unknown;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/** Servers whose process or port exists only on the host. */
export function isHostLocal(server: McpServer): boolean {
	if (server.command) return true;
	if (!server.url) return false;
	try {
		return LOCAL_HOSTS.has(new URL(server.url).hostname);
	} catch {
		return false;
	}
}

/** MCP servers count as one when their names differ only in `-` and `_`, as in Pi. */
function serverKey(name: string): string {
	return name.replaceAll("-", "_");
}

export function containerMcpConfig(config: McpConfig): { config: McpConfig; disabled: string[] } {
	const servers: Record<string, McpServer> = {};
	const disabled: string[] = [];
	for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
		if (isHostLocal(server) && server.enabled !== false) {
			servers[name] = { ...server, enabled: false };
			disabled.push(name);
		} else {
			servers[name] = server;
		}
	}
	return { config: { ...config, mcpServers: servers }, disabled };
}

/** Name and `tools` of an agent file; `tools` accepts the comma form and the `- item` block form. */
export function parseAgent(markdown: string): { name?: string; tools?: string[] } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
	if (!match) return {};
	const lines = match[1].split(/\r?\n/);
	const name = lines.find((line) => line.startsWith("name:"))?.slice(5).trim();
	const at = lines.findIndex((line) => line.startsWith("tools:"));
	if (at < 0) return { name };
	const inline = lines[at].slice(6).trim();
	const tools = inline ? inline.split(",") : [];
	for (let index = at + 1; !inline && index < lines.length && /^\s+-\s/.test(lines[index]); index++) {
		tools.push(lines[index].replace(/^\s+-\s/, ""));
	}
	return { name, tools: tools.map((tool) => tool.trim()).filter(Boolean) };
}

/** Tool lists without the `mcp:` entries of disabled servers, for agents that had any. */
export function toolOverrides(agents: { name?: string; tools?: string[] }[], disabled: string[]): Record<string, string[]> {
	const off = new Set(disabled.map(serverKey));
	const overrides: Record<string, string[]> = {};
	for (const { name, tools } of agents) {
		if (!name || !tools) continue;
		const kept = tools.filter((tool) => !(tool.startsWith("mcp:") && off.has(serverKey(tool.slice(4).split("/")[0]))));
		if (kept.length !== tools.length) overrides[name] = kept;
	}
	return overrides;
}

/** Replaces a linked file in the agent directory with a container-specific copy. */
function writeOwnCopy(path: string, content: unknown) {
	try {
		if (lstatSync(path)) rmSync(path);
	} catch {
		// Not there yet.
	}
	writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`);
}

export function writeContainerConfig(nestDir: string, agentDir: string): string[] {
	const report: string[] = [];
	const mcp = JSON.parse(readFileSync(join(nestDir, "agent/mcp.json"), "utf-8")) as McpConfig;
	const { config, disabled } = containerMcpConfig(mcp);
	writeOwnCopy(join(agentDir, "mcp.json"), config);
	for (const name of disabled) report.push(`mcp server ${name}: disabled in the container (runs only on the host)`);

	const agentsDir = join(nestDir, "agent/agents");
	const agents = readdirSync(agentsDir)
		.filter((file) => file.endsWith(".md"))
		.map((file) => parseAgent(readFileSync(join(agentsDir, file), "utf-8")));
	const overrides = toolOverrides(agents, disabled);
	if (Object.keys(overrides).length > 0) {
		const settings = JSON.parse(readFileSync(join(nestDir, "agent/settings.json"), "utf-8"));
		settings.subagents ??= {};
		settings.subagents.agentOverrides ??= {};
		for (const [name, tools] of Object.entries(overrides)) {
			settings.subagents.agentOverrides[name] = { ...settings.subagents.agentOverrides[name], tools };
			report.push(`agent ${name}: tools in the container: ${tools.join(", ")}`);
		}
		writeOwnCopy(join(agentDir, "settings.json"), settings);
	}
	return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const agentDir = process.argv[2];
	if (!agentDir) {
		console.error("usage: node scripts/container-config.ts <agent-dir>");
		process.exit(64);
	}
	const nestDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	for (const line of writeContainerConfig(nestDir, agentDir)) console.log(line);
}
