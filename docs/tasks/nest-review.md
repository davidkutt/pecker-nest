# Task: nest-review, a review per pull request

From the planning chat of 18–21 November 2026. After every pull request that nest (Pi) or Cursor's agent
built, Claude reviews how well the agent worked, sums up what went badly, and proposes concrete changes.
The point is the setup around the agent, not the model. Decisions are in the "Entschieden" table of
`docs/RUNBOOK.md` (21.11.2026).

## Decisions

- **A review per pull request, not live.** A rating per round would only help to stop running work, and
  nest's router already covers that (switch to the strong model on loops, failed edits and a red gate).
  For improvements to the setup the whole pull request is enough, and patterns show better there.
- **Its own skill, `nest-review`**, not `/review`, to avoid a clash with built-in commands.
- **Runs beside `nest-handoff`, not instead.** The handoff stays per session for the planning chat; the
  review checks the setup per pull request and reads an open field note for the interventions.
- **The skill collects its inputs itself** and stops when one is missing, naming it. It never reviews with
  incomplete facts.
- **One PR, one model.** Every pull request comes from exactly one agent: nest, or one model in Cursor.
  Traces of a second agent: the review asks David and stops if it was one.
- **Origin as input.** David says with the command whether nest or Cursor did the work. Missing: the skill
  asks; it never guesses.
- **Reviewer: always Claude**, so that reviews compare. The skill runs in Cursor and Claude Code, not in Pi,
  where nest's own models would grade nest's work. A Cursor pull request built with the same Claude model
  is marked in the review.
- **Output to David only.** The skill comments on, approves, merges or closes no pull request and writes no
  file: Pi's safety gate and the Cursor adapter refuse writes to `~/dev/pecker-nest`. David saves the
  review in `field-notes/reviews/` (local, git-ignored).
- **Raw logs, locally.** To find a cause the review may read Pi's session files and Cursor's transcript;
  it quotes at most five lines and never a prompt.
- **Reviews in English**, like the field notes and `nest-handoff`.

## Inputs

1. The task as David gave it to the agent; it lives only in the prompt, so David pastes it.
2. The pull request (number or URL; without one, the current branch's), its diff via `gh`.
3. The window: `session-report.ts` picks sessions by directory and time, not by branch. The skill
   proposes the window from the pull request (the commit the branch left `main` at to the last commit),
   lists the sessions in it and lets David confirm them.
4. The session record: `session-report.ts` for nest; for Cursor the adapter's log
   (`~/.local/state/pecker-nest/cursor/log.jsonl`: gate runs, repair rounds, findings, blocks) and the
   conversation's transcript for tool calls, failed edits and loops.
5. The gate result: for nest the history from the session report's "Gates", the final state from CI or a
   local run of the check command of `.pi/gate.json` at the pull request's head; for Cursor the adapter's
   last result, CI where the adapter did not run.
6. The configuration under test from `scripts/field-note.ts config`, so that a later review can tell
   whether a fix worked.
7. David's own commits and steering: agent and David both commit as `davidkutt`, so commits outside the
   confirmed sessions count as David's, and the session report's prompt count shows his steering.

Stop cases: no pull request or `gh` not signed in, no session in the window, origin missing, CI still
running and the check cannot be repeated locally. Only a warning: the pecker-nest checkout has
uncommitted changes, or newer commits than the window start (configuration not comparable), and a very
large diff (the review names the files it saw only in the `--stat`).

## Six levers

Every problem is put down to exactly one lever: the one where a fix is cheapest and lasts longest;
contributing levers get one sentence.

1. **Config:** model per role, thinking level, compaction; in Cursor model and effort.
2. **Instructions:** system prompt, `AGENTS.md`, skills, subagent roles; in Cursor rules and skills.
3. **Harness code:** logic of router, gate and protect rules, the tools the agent gets; in Cursor the hooks.
4. **Target repository:** tests, structure and docs of the repository the agent works in.
5. **Task:** how precisely David words the task and how big he cuts it.
6. **Environment:** provider errors, network, container, local tools, a reachable knowledge base.

Edge cases: the kind of cause decides, not where the file lies. The `AGENTS.md` of the target repository
and the knowledge base's content are instructions (text the model reads); router thresholds and MCP
servers on or off are config (values without logic); `.pi/gate.json` and `.pi/protect.json` belong to the
target repository; David's steering during the session belongs to the task. A problem without a clear
cause (a model limit, a one-off) goes under "Observe" and gets a fix only once it turns up in several
pull requests.

## Output

A short summary (task met, what went badly); each acceptance check with its evidence; per problem its
evidence (`path:line`, a session-report number or a gate round; without evidence it is not listed), its
lever and several concrete fixes within that lever, each with effort S/M/L and benefit low/medium/high,
one marked as recommended; levers without findings in one line each instead of invented problems; the
"Observe" list. Fixed order: header (PR, origin, configuration line, window), outcome, problems, levers
without findings, observe, and last a JSON line for the collection.

## Collection across pull requests

Per review one Markdown file with one JSON line (date, repo, PR, origin, nest commit, and per finding the
lever and a problem tag). The problem tags form a short fixed list, so cases can be counted; the skill
proposes new ones, David adds them. A patterns mode counts the tags over the last reviews and shows what
recurs. A fix David applies is recorded with its date; the patterns then show whether the tag still turns
up after it (like the "Metric that shows it worked" column of `nest-handoff`).

## Build

1. `skills/nest-review/SKILL.md`, in English, following this plan.
2. `scripts/nest-review.ts` with `collect` (facts as JSON) and `patterns` (count tags), unit tests in
   `test/`, as `field-note.ts` does for the field notes: the script reads the facts, the model judges.
3. `scripts/link.sh` links `nest-review` with `--claude` and `--cursor` only, not with `--pi`.
4. Docs: README, `field-notes/README.md`, RUNBOOK "Entschieden", `docs/v1-notes.md`, this brief.
5. `npm run check` and `npm run e2e` green, then a pull request from a new branch; David merges.
