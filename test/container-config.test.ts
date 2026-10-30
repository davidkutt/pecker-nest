import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { containerMcpConfig, isHostLocal, parseAgent, toolOverrides, writeContainerConfig } from "../scripts/container-config.ts";

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
