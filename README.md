# pecker-nest

Versioned [Pi](https://pi.dev) configuration for nest V1: GLM 5.3 and DeepSeek V4 through one OpenRouter key with zero-data-retention routing, a safety gate, a quality gate with bounded self-repair, a router that switches GLM's effort from max to high, four subagent roles with a cross-provider review chain, and headless runs in Docker. Host and container load the same files.

The plan this implements is "Pi V1 – Konfigurationsplan" (28.10.2026) with the update "GLM 5.3 & DeepSeek über OpenRouter" (30.10.2026). In that plan this repo is called `pi-config`.

- **Setup and acceptance tests:** [docs/RUNBOOK.md](docs/RUNBOOK.md)
- **Deviations from the plan and findings:** [docs/v1-notes.md](docs/v1-notes.md)

## Layout

```text
pecker-nest/                  must live at ~/dev/pecker-nest
├── package.json              Pi package: extensions, skills, prompts; pi-subagents agent dir
├── extensions/
│   ├── safety-gate.ts        blocks rm -rf, git push/reset --hard/clean -f, curl|sh, writes to .env*/keys; /plan writes only PLAN.md
│   ├── quality-gate.ts       runs .pi/gate.json after code changes, ≤ 2 repair rounds, /gate command
│   ├── router.ts             virtual model router/phased: GLM 5.3 plans at max, builds at high
│   └── lib/                  pure logic, unit-tested
├── skills/                   testing-ts, testing-py, best-practices (knowledge base)
├── prompts/                  /plan, /implement <step>, /review
├── agent/                    linked into ~/.pi/agent by scripts/link.sh
│   ├── settings.json         models, tools, packages (pinned pi-subagents), subagent defaults
│   ├── models.json           OpenRouter provider routing: ZDR only, no data collection
│   ├── APPEND_SYSTEM.md      global working principles
│   ├── mcp.json              MCP servers (knowledge base goes here)
│   ├── agents/               scout (DeepSeek V4 Flash), planner + worker (GLM 5.3), reviewer (DeepSeek V4 Pro)
│   └── prompts/              review-chain and its four steps
├── templates/                AGENTS.ts.md, AGENTS.py.md, gate.ts.json, gate.py.json
├── docker/                   Dockerfile.pi, pi-run.sh, task.sh
├── scripts/
│   ├── link.sh               links agent/ into Pi's agent directory
│   └── container-config.ts   image build: host-only MCP servers (the knowledge base) and their subagent tools off
└── test/                     unit tests; e2e/ runs real Pi against a scripted OpenRouter mock
```

## Quick start

```bash
git clone https://github.com/davidkutt/pecker-nest ~/dev/pecker-nest
~/dev/pecker-nest/scripts/link.sh
pi            # first start installs pi-subagents@0.83.1; then /login openrouter
pi list       # ~/dev/pecker-nest and npm:pi-subagents@0.83.1
```

## Checks

```bash
npm ci
npm run check        # typecheck + unit tests
npm run e2e          # real Pi + scripted OpenRouter mock: models, routing, gates, /plan, trust, router, subagents, review chain
docker build -t pecker-nest-pi -f docker/Dockerfile.pi .
npm run e2e:docker   # headless run in the container (acceptance tests 10, 11)
```

The end-to-end tests cost no tokens: a local mock speaks OpenRouter's streaming chat-completions API and scripts the model's tool calls, so they check the wiring, not the models' judgment.
