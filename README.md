# pecker-nest

Versioned [Pi](https://pi.dev) configuration for nest V1: Anthropic models, a safety gate, a quality gate with bounded self-repair, an Opus→Sonnet router, four subagent roles with a review chain, and headless runs in Docker. Host and container load the same files.

The plan this implements is "Pi V1 – Konfigurationsplan" (28.10.2026). In that plan this repo is called `pi-config`.

- **Setup and acceptance tests:** [docs/RUNBOOK.md](docs/RUNBOOK.md)
- **Deviations from the plan and findings:** [docs/v1-notes.md](docs/v1-notes.md)

## Layout

```text
pecker-nest/                  must live at ~/dev/pecker-nest
├── package.json              Pi package: extensions, skills, prompts; pi-subagents agent dir
├── extensions/
│   ├── safety-gate.ts        blocks rm -rf, git push/reset --hard/clean -f, curl|sh, writes to .env*/keys; /plan writes only PLAN.md
│   ├── quality-gate.ts       runs .pi/gate.json after code changes, ≤ 2 repair rounds, /gate command
│   ├── router.ts             virtual model router/phased: Opus plans, Sonnet builds
│   └── lib/                  pure logic, unit-tested
├── skills/                   testing-ts, testing-py, best-practices (knowledge base)
├── prompts/                  /plan, /implement <step>, /review
├── agent/                    linked into ~/.pi/agent by scripts/link.sh
│   ├── settings.json         models, tools, packages (pinned pi-subagents), subagent defaults
│   ├── APPEND_SYSTEM.md      global working principles
│   ├── mcp.json              MCP servers (knowledge base goes here)
│   ├── agents/               scout (Haiku), planner (Opus), worker (Sonnet), reviewer (Opus)
│   └── prompts/              review-chain and its four steps
├── templates/                AGENTS.ts.md, AGENTS.py.md, gate.ts.json, gate.py.json
├── docker/                   Dockerfile.pi, pi-run.sh, task.sh
├── scripts/link.sh           links agent/ into Pi's agent directory
└── test/                     unit tests; e2e/ runs real Pi against a scripted Anthropic mock
```

## Quick start

```bash
git clone https://github.com/davidkutt/pecker-nest ~/dev/pecker-nest
~/dev/pecker-nest/scripts/link.sh
pi            # first start installs pi-subagents@0.83.1
pi list       # ~/dev/pecker-nest and npm:pi-subagents@0.83.1
```

## Checks

```bash
npm ci
npm run check        # typecheck + unit tests
npm run e2e          # real Pi + scripted Anthropic mock: gates, /plan, trust, router, subagents, review chain
docker build -t pecker-nest-pi -f docker/Dockerfile.pi .
npm run e2e:docker   # headless run in the container (acceptance tests 10, 11)
```

The end-to-end tests cost no tokens: a local mock speaks the Anthropic streaming API and scripts the model's tool calls, so they check the wiring, not the models' judgment.
