import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { containerMcpConfig, isHostLocal, type McpConfig, parseAgent, toolOverrides, writeContainerConfig } from "../scripts/container-config.ts";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("isHostLocal", () => {
	it("treats stdio servers and localhost URLs as host-only", () => {
		assert.ok(isHostLocal({ command: "uvx", args: ["kb-server"] }));
		assert.ok(isHostLocal({ url: "http://localhost:8765/mcp" }));
		assert.ok(isHostLocal({ url: "http://127.0.0.1:8765/mcp" }));
		assert.ok(!isHostLocal({ url: "https://kb.example.com/mcp" }));
	});
});

describe("containerMcpConfig", () => {
	it("disables host-only servers and keeps the rest unchanged", () => {
		const { config, disabled } = containerMcpConfig({
			mcpServers: {
				kb: { command: "kb-server", description: "Projektwissen" },
				docs: { url: "https://docs.example.com/mcp" },
				old: { command: "x", enabled: false },
			},
		});
		assert.deepEqual(disabled, ["kb"]);
		assert.deepEqual(config.mcpServers.kb, { command: "kb-server", description: "Projektwissen", enabled: false });
		assert.deepEqual(config.mcpServers.docs, { url: "https://docs.example.com/mcp" });
	});
});

describe("parseAgent", () => {
	it("reads comma and block tool lists", () => {
		assert.deepEqual(parseAgent("---\nname: reviewer\ntools: read, grep, mcp:kb/search\n---\nbody"), {
			name: "reviewer",
			tools: ["read", "grep", "mcp:kb/search"],
		});
		assert.deepEqual(parseAgent("---\nname: planner\ntools:\n  - read\n  - mcp:kb\nthinking: max\n---\n"), {
			name: "planner",
			tools: ["read", "mcp:kb"],
		});
	});
});

describe("toolOverrides", () => {
	it("drops mcp tools of disabled servers only for agents that use them", () => {
		const agents = [
			{ name: "reviewer", tools: ["read", "mcp:kb/search", "mcp:docs/get"] },
			{ name: "worker", tools: ["read", "bash"] },
		];
		assert.deepEqual(toolOverrides(agents, ["kb"]), { reviewer: ["read", "mcp:docs/get"] });
		assert.deepEqual(toolOverrides(agents, []), {});
	});
});

describe("writeContainerConfig", () => {
	it("writes container copies of mcp.json and settings.json over the links", () => {
		const nest = mkdtempSync(join(tmpdir(), "nest-cc-"));
		const agentDir = mkdtempSync(join(tmpdir(), "nest-cc-agent-"));
		dirs.push(nest, agentDir);
		mkdirSync(join(nest, "agent/agents"), { recursive: true });
		writeFileSync(join(nest, "agent/mcp.json"), JSON.stringify({ mcpServers: { kb: { url: "http://localhost:9000/mcp" } } }));
		writeFileSync(join(nest, "agent/settings.json"), JSON.stringify({ subagents: { agentOverrides: { reviewer: { thinking: "high" } } } }));
		writeFileSync(join(nest, "agent/agents/reviewer.md"), "---\nname: reviewer\ntools: read, mcp:kb/search\n---\n");
		writeFileSync(join(nest, "agent/agents/worker.md"), "---\nname: worker\ntools: read, bash\n---\n");
		symlinkSync(join(nest, "agent/mcp.json"), join(agentDir, "mcp.json"));
		symlinkSync(join(nest, "agent/settings.json"), join(agentDir, "settings.json"));

		const report = writeContainerConfig(nest, agentDir);

		assert.equal(report.length, 2);
		for (const file of ["mcp.json", "settings.json"]) assert.ok(!lstatSync(join(agentDir, file)).isSymbolicLink());
		assert.equal(JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf-8")).mcpServers.kb.enabled, false);
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).subagents.agentOverrides.reviewer, {
			thinking: "high",
			tools: ["read"],
		});
		// The repository files stay untouched.
		assert.equal(JSON.parse(readFileSync(join(nest, "agent/mcp.json"), "utf-8")).mcpServers.kb.enabled, undefined);
	});

	it("keeps settings.json linked when no agent uses a disabled server", () => {
		const nest = mkdtempSync(join(tmpdir(), "nest-cc-"));
		const agentDir = mkdtempSync(join(tmpdir(), "nest-cc-agent-"));
		dirs.push(nest, agentDir);
		mkdirSync(join(nest, "agent/agents"), { recursive: true });
		writeFileSync(join(nest, "agent/mcp.json"), JSON.stringify({ mcpServers: {} }));
		writeFileSync(join(nest, "agent/settings.json"), "{}");
		writeFileSync(join(nest, "agent/agents/worker.md"), "---\nname: worker\ntools: read\n---\n");
		symlinkSync(join(nest, "agent/settings.json"), join(agentDir, "settings.json"));

		assert.deepEqual(writeContainerConfig(nest, agentDir), []);
		assert.ok(lstatSync(join(agentDir, "settings.json")).isSymbolicLink());
	});
});

describe("the repository's agent/mcp.json", () => {
	const text = readFileSync(join(NEST, "agent/mcp.json"), "utf-8");
	const real = JSON.parse(text) as McpConfig;

	it("registers the knowledge base, and the container switches it off (decision of 30.10.2026)", () => {
		assert.equal(real.mcpServers.kb?.url, "http://localhost:8000/mcp");
		assert.notEqual(real.mcpServers.kb.enabled, false, "the host needs the server enabled");

		const { config, disabled } = containerMcpConfig(real);

		assert.deepEqual(disabled, ["kb"]);
		assert.equal(config.mcpServers.kb.enabled, false);
		assert.deepEqual({ ...config.mcpServers.kb, enabled: undefined }, { ...real.mcpServers.kb, enabled: undefined }, "nothing else changes");
	});

	it("holds no token, secret or machine-specific path", () => {
		const kb = real.mcpServers.kb as { headers?: unknown; env?: unknown; oauth?: Record<string, unknown> };
		// Pi signs in with its own Client ID Metadata Document and keeps the tokens in its auth store.
		assert.equal(kb.headers, undefined, "an Authorization header would be a static token");
		assert.equal(kb.env, undefined);
		assert.deepEqual(Object.keys(kb.oauth ?? {}).sort(), ["clientRegistration", "scope"]);
		assert.equal(kb.oauth?.clientRegistration, "cimd");
		assert.doesNotMatch(text, /\/Users\/|\/home\/|~\/|\$\{|"!/, "a home path, an environment variable or a command value");
	});

	it("hides the write tool and declares only the search directly", () => {
		const kb = real.mcpServers.kb as { exposure?: string; toolExposure?: Record<string, string> };
		assert.equal(kb.exposure, "deferred");
		assert.deepEqual(kb.toolExposure, { search_knowledge_base: "direct", ingest_url: "hidden" });
	});

	it("is used by no subagent: a subagent with an mcp:kb tool does not start while the server is down", () => {
		const agentsDir = join(NEST, "agent/agents");
		const agents = readdirSync(agentsDir)
			.filter((file) => file.endsWith(".md"))
			.map((file) => parseAgent(readFileSync(join(agentsDir, file), "utf-8")));
		assert.ok(agents.length >= 4);
		assert.deepEqual(toolOverrides(agents, ["kb"]), {}, "see docs/research/grove-kb-auth.md, P5");
	});
});
