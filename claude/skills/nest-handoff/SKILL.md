---
name: nest-handoff
description: Write the handoff after a pecker-nest session in the current repository, with session metrics, outcome against the acceptance checks, interventions and harness findings, for the planning chat.
argument-hint: "[--since 8h | session.jsonl]"
disable-model-invocation: true
---

# Hand off a nest session

Fill in the field note for this session and give David the part he pastes into the planning chat. You report; you do not fix anything.

1. **Find the field note.** It is the newest `~/dev/pecker-nest/field-notes/*-<repo>-*.md` from today. If there is none, create one from `TEMPLATE.md` and say that the session was not supervised from the start.
2. **Metrics.** Run `node ~/dev/pecker-nest/scripts/session-report.ts --cwd "$PWD"`, adding `$ARGUMENTS` if given (for example `--since 8h` for a day with several sessions). Put its output under Metrics. It contains counts only.
3. **Outcome.** From the start HEAD in the note: `git log --oneline <start>..HEAD`, `git diff --stat <start>`, and untracked files from `git status --short`. Run the check command from `.pi/gate.json` (or the repository's documented check) and record the exit code and the last lines. Go through the task's acceptance checks one by one: met, not met or unknown, each with its evidence.
4. **Quality.** Read the diff. Note concrete problems with `path:line`: bugs, weakened or skipped tests, scope creep, broken repository rules (`CLAUDE.md`, `AGENTS.md`). Do not fix them.
5. **Assessment.** What nest did well and badly, each with evidence (a file, a session-report number, a quality-gate round). Cover at least: did it plan before building, did DeepSeek V4.1 Flash cope or did the strong model have to step in and why, failed edits, loops, gate repair rounds, safety blocks that were right or wrong, cost. The session report's Router section names the strong model per switch, so say which one stepped in (GLM 5.3 by default, Kimi K3.1 Pro after `/strong kimi`).
6. **Model comparison.** Only when the session ran one (RUNBOOK M5, "Modellvergleich GLM gegen Kimi"): fill in the field note's Model comparison table, one row per step — step, GLM result, Kimi result, cost of each, verdict. Take the costs from the session report per model (`stats.models`), not from an estimate; for a `/plan` comparison also compare `PLAN.glm.md` with `PLAN.md`. Judge each step on substance (did it find the real constraint, is the plan or review usable), not on length, and write a verdict per step plus one line overall. If no comparison ran, leave the table empty and say nothing about it.
7. **Interventions.** Check the table is complete; add a one-line total (count and estimated minutes). Count `admin` rows (pushing the branch, opening the PR) separately and leave them out of the total that measures nest: they are release work, not a repair of what nest built.
8. **Harness findings.** One row per finding: evidence, proposal, the bucket it belongs in (Do now, Validate, Validate & later, Don't) and the metric that would show it worked. Keep product issues out of this table; they go under Product notes.
9. **For the planning chat.** Write the last section, at most 40 lines: outcome, key numbers (cost, requests per model, switches to the strong model and which one, failed-edit rate, gate repairs, interventions), the three most important findings, open questions. Had the session a model comparison, add its verdict in at most three lines (per step and overall), because the planning chat decides from it whether Kimi replaces GLM. Print exactly that section in your reply so David can paste it.

Rules: no secrets, no held-out eval samples, at most five-line code excerpts. The note stays local. Product status for the product's own planning chat belongs in its pull request description.
