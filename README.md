# pecker-nest

Versioned [Pi](https://pi.dev) configuration for nest: DeepSeek V4.1 Flash does the work and a stronger model steps in when it is needed (strategy A) — GLM 5.3 by default, Kimi K3.1 Pro with `/strong kimi` — all through one OpenRouter key with zero-data-retention routing. It adds a safety gate with per-repository protection rules, a quality gate with bounded self-repair, an escalation router, git checkpoints with `/rewind`, four subagent roles with a cross-model review chain, headless runs in Docker, and a session report plus Claude Code skills for supervised dogfooding. Host and container load the same files.

The plan this implements is "Pi V1 – Konfigurationsplan" (28.10.2026) with the update "GLM 5.3 & DeepSeek über OpenRouter" (30.10.2026), strategy A from the planning chat (07.11.2026), the optional Kimi K3.1 Pro stand-in (08.11.2026) and the setup hardening of 10.11.2026. In that plan this repo is called `pi-config`.

- **Start here, from zero:** [docs/SETUP.md](docs/SETUP.md)
- **Acceptance tests, milestones, dogfooding:** [docs/RUNBOOK.md](docs/RUNBOOK.md)
- **Deviations from the plan and findings:** [docs/v1-notes.md](docs/v1-notes.md)

## Layout

```text
pecker-nest/                  must live at ~/dev/pecker-nest
├── package.json              Pi package: extensions, skills, prompts; pi-subagents agent dir
├── extensions/
│   ├── safety-gate.ts        blocks rm -rf, git push/reset --hard/clean -f, curl|sh, writes to .env*/keys/.pi/,
│   │                         the harness itself (this repo, Pi's and Claude Code's config dirs);
│   │                         applies .pi/protect.json; /plan writes only PLAN.md
│   ├── quality-gate.ts       runs .pi/gate.json after code changes, ≤ 2 repair rounds, /gate command;
│   │                         also red when the diff weakens the checks: deleted or skipped tests,
│   │                         fewer test cases, suppressions, changed lint/type/test configuration
│   ├── router.ts             virtual model router/escalate: Flash (high) by default, the strong model
│   │                         (always max) for /plan, a red gate at repair round 2, loops, or /hard
│   │                         (until /flash); /strong glm|kimi picks it
│   ├── checkpoint.ts         git checkpoint before every prompt; /rewind, /checkpoints
│   ├── provider-log.ts       records the upstream OpenRouter provider of every request in the session
│   │                         file (from the stream, no extra request), for the session report
│   ├── vendor/               todo and questionnaire tools, copied unchanged from Pi's examples
│   └── lib/                  pure logic, unit-tested
├── skills/                   testing-ts, testing-py, best-practices (knowledge base), grill-me (manual)
├── prompts/                  /plan, /implement <step>, /review
├── agent/                    linked into ~/.pi/agent by scripts/link.sh
│   ├── settings.json         models, tools, compaction, packages (pinned pi-subagents), subagent defaults
│   ├── models.json           OpenRouter provider routing: ZDR only, no data collection; Kimi K3.1 Pro
│   │                         gets reasoning_content on replayed assistant messages
│   ├── APPEND_SYSTEM.md      global working principles
│   ├── mcp.json              MCP servers (knowledge base goes here)
│   ├── agents/               scout + worker (DeepSeek V4.1 Flash), planner + reviewer (GLM 5.3, max)
│   └── prompts/              review-chain and its four steps
├── claude/skills/            Claude Code: /nest-supervise, /nest-handoff (linked by scripts/link.sh --claude)
├── field-notes/              local session notes (git-ignored except README and TEMPLATE)
├── templates/                AGENTS.*.md, gate.*.json; undertext/ (gate.json, protect.json)
├── docker/                   Dockerfile.pi, pi-run.sh (container key from the Keychain, refuses a stale
│                             image), task.sh
├── scripts/
│   ├── link.sh               links agent/ into Pi's agent directory (and claude/skills with --claude)
│   ├── doctor.sh             is this machine ready? one PASS/WARN/FAIL line per check, with the fix;
│   │                         --docker adds the daemon and image checks for headless runs
│   ├── build-image.sh        builds the Docker image, labelled with the commit it contains
│   ├── probe-openrouter.ts   live probe of the three models (a few cents, run by hand): endpoints under
│   │                         the routing block, tool loop, cross-model replay, GLM preserved thinking
│   ├── field-note.ts         for the supervision skills: the configuration under test (commit, Pi,
│   │                         thinking level per tier and role, strong model) and the open field note
│   ├── session-report.ts     cost, models, switches per reason and strong model and what became of
│   │                         them, request-time fallbacks, errors per upstream provider, failed
│   │                         edits, loops, gates from Pi's session logs (offline)
│   └── container-config.ts   image build: host-only MCP servers (the knowledge base) and their subagent tools off
└── test/                     unit tests; e2e/ runs real Pi against a scripted OpenRouter mock
```

## Quick start

```bash
git clone -b main https://github.com/davidkutt/pecker-nest ~/dev/pecker-nest
~/dev/pecker-nest/scripts/link.sh --claude
pi            # first start installs pi-subagents@0.87.0; then /login openrouter
pi list       # ~/dev/pecker-nest and npm:pi-subagents@0.87.0
~/dev/pecker-nest/scripts/doctor.sh   # tools, links, login, models; --docker adds daemon and image
```

In a session: `/plan <task>`, `/implement <step>`, `/review`, `/hard` and `/flash`, `/strong glm|kimi`, `/rewind`, `/gate`, `/skill:grill-me <idea>`. After a session: `node ~/dev/pecker-nest/scripts/session-report.ts --cwd <repo>`.

## Checks

```bash
npm ci
npm run check        # typecheck + unit tests
npm run e2e          # real Pi + scripted OpenRouter mock: models, routing, gates, protection, /plan, trust,
                     # router, subagents, review chain, session report
scripts/build-image.sh   # pecker-nest-pi, labelled with the commit; pi-run.sh refuses a stale image
npm run e2e:docker       # headless run in the container (acceptance tests 10, 11)
```

The end-to-end tests cost no tokens: a local mock speaks OpenRouter's streaming chat-completions API and scripts the model's tool calls, so they check the wiring, not the models' judgment. What the real models and OpenRouter do with these requests is the job of `node scripts/probe-openrouter.ts`: it sends about twenty small real requests through Pi's own client and writes a report to `runs/`.
