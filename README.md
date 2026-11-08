# pecker-nest

Versioned [Pi](https://pi.dev) configuration for nest: DeepSeek V4.1 Flash does the work and GLM 5.3 steps in when it is needed (strategy A), both through one OpenRouter key with zero-data-retention routing. It adds a safety gate with per-repository protection rules, a quality gate with bounded self-repair, an escalation router, git checkpoints with `/rewind`, four subagent roles with a cross-model review chain, headless runs in Docker, and a session report plus Claude Code skills for supervised dogfooding. Host and container load the same files.

The plan this implements is "Pi V1 – Konfigurationsplan" (28.10.2026) with the update "GLM 5.3 & DeepSeek über OpenRouter" (30.10.2026) and strategy A from the planning chat (07.11.2026). In that plan this repo is called `pi-config`.

- **Start here, from zero:** [docs/SETUP.md](docs/SETUP.md)
- **Acceptance tests, milestones, dogfooding:** [docs/RUNBOOK.md](docs/RUNBOOK.md)
- **Deviations from the plan and findings:** [docs/v1-notes.md](docs/v1-notes.md)

## Layout

```text
pecker-nest/                  must live at ~/dev/pecker-nest
├── package.json              Pi package: extensions, skills, prompts; pi-subagents agent dir
├── extensions/
│   ├── safety-gate.ts        blocks rm -rf, git push/reset --hard/clean -f, curl|sh, writes to .env*/keys/.pi/,
│   │                         the harness itself; applies .pi/protect.json; /plan writes only PLAN.md
│   ├── quality-gate.ts       runs .pi/gate.json after code changes, ≤ 2 repair rounds, /gate command
│   ├── router.ts             virtual model router/escalate: Flash by default, GLM for /plan, a red gate
│   │                         at repair round 2, loops, or /hard (until /flash)
│   ├── checkpoint.ts         git checkpoint before every prompt; /rewind, /checkpoints
│   ├── vendor/               todo and questionnaire tools, copied unchanged from Pi's examples
│   └── lib/                  pure logic, unit-tested
├── skills/                   testing-ts, testing-py, best-practices (knowledge base), grill-me (manual)
├── prompts/                  /plan, /implement <step>, /review
├── agent/                    linked into ~/.pi/agent by scripts/link.sh
│   ├── settings.json         models, tools, compaction, packages (pinned pi-subagents), subagent defaults
│   ├── models.json           OpenRouter provider routing: ZDR only, no data collection
│   ├── APPEND_SYSTEM.md      global working principles
│   ├── mcp.json              MCP servers (knowledge base goes here)
│   ├── agents/               scout + worker (DeepSeek V4.1 Flash), planner + reviewer (GLM 5.3)
│   └── prompts/              review-chain and its four steps
├── claude/skills/            Claude Code: /nest-supervise, /nest-handoff (linked by scripts/link.sh --claude)
├── field-notes/              local session notes (git-ignored except README and TEMPLATE)
├── templates/                AGENTS.*.md, gate.*.json; undertext/ (gate.json, protect.json)
├── docker/                   Dockerfile.pi, pi-run.sh, task.sh
├── scripts/
│   ├── link.sh               links agent/ into Pi's agent directory (and claude/skills with --claude)
│   ├── session-report.ts     cost, models, switches to GLM, failed edits, loops, gates from Pi's session logs
│   └── container-config.ts   image build: host-only MCP servers (the knowledge base) and their subagent tools off
└── test/                     unit tests; e2e/ runs real Pi against a scripted OpenRouter mock
```

## Quick start

```bash
git clone -b main https://github.com/davidkutt/pecker-nest ~/dev/pecker-nest
~/dev/pecker-nest/scripts/link.sh --claude
pi            # first start installs pi-subagents@0.87.0; then /login openrouter
pi list       # ~/dev/pecker-nest and npm:pi-subagents@0.87.0
```

In a session: `/plan <task>`, `/implement <step>`, `/review`, `/hard` and `/flash`, `/rewind`, `/gate`, `/skill:grill-me <idea>`. After a session: `node ~/dev/pecker-nest/scripts/session-report.ts --cwd <repo>`.

## Checks

```bash
npm ci
npm run check        # typecheck + unit tests
npm run e2e          # real Pi + scripted OpenRouter mock: models, routing, gates, protection, /plan, trust,
                     # router, subagents, review chain, session report
docker build -t pecker-nest-pi -f docker/Dockerfile.pi .
npm run e2e:docker   # headless run in the container (acceptance tests 10, 11)
```

The end-to-end tests cost no tokens: a local mock speaks OpenRouter's streaming chat-completions API and scripts the model's tool calls, so they check the wiring, not the models' judgment.
