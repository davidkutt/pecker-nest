---
name: nest-review
description: Review one pull request that nest (Pi) or Cursor's agent built - whether it met the task, what went badly, and which of six levers of the setup to change, with several fixes per problem. Use when David asks for a review of a PR.
argument-hint: "<PR number or URL> --from nest|cursor, then the task as David gave it to the agent"
disable-model-invocation: true
---

# Review a pull request

You review the setup around the agent, not the model: what made the work go well or badly, and where David can change it. One pull request, one agent: either nest or one model in Cursor. You report to David only. You never comment on, approve, merge or close a pull request, and you write no file: Pi's safety gate and the Cursor adapter refuse writes to `~/dev/pecker-nest` anyway. David saves the review.

The reviewer is always Claude, so that reviews stay comparable. If David built a Cursor PR with the same Claude model, say so in the header: that review grades its own model. The review is in English.

Commands: `/nest-review` in Cursor and Claude Code. Not in Pi, where nest's own models would grade nest's work; `scripts/link.sh` does not link this skill for Pi. The commands below are the same in bash, zsh and fish.

## 1. Inputs

David gives three things with the command: the pull request (number or URL; without one, the pull request of the current branch), its origin (`--from nest` or `--from cursor`), and the task as he gave it to the agent, pasted. If the origin or the task is missing, ask for it in one line and wait. Never guess the origin. If the task names a brief (for example `docs/tasks/<name>.md` or `docs/milestones/M1.md`), read it and take its acceptance checks.

## 2. Facts

In the product repository, run `node ~/dev/pecker-nest/scripts/nest-review.ts collect --from <origin> --pr <pr>`, with `--since <date>` if David named a start, and once more with `--json`. The script reads the pull request with `gh`, proposes the window (from the commit the branch left `main` at to the last commit), lists the Pi sessions in it, sums up the Cursor adapter's records, and reads CI, the local checkout and the configuration under test.

- **"Cannot review"** (exit code 1): stop. Show David the reasons as printed and what would fix each. Never review with an input missing.
- **Sessions:** show David the window and the Pi sessions (file, start and end, PR commits made during it, edits). Ask which belong to this pull request. A session without PR commits is often planning, or another pull request. If David names another start, run `collect` again with `--since`.
- **Other agent:** a warning about Cursor turns or Pi sessions that changed files means you ask David whether another agent worked on this pull request. If yes, stop: one PR, one model. If it was supervision beside nest, or an intervention logged in the field note, go on and count interventions as interventions.
- **Configuration:** copy the `Config under test` line as it is. Put the warnings about uncommitted or newer pecker-nest commits into the header: the numbers are then not comparable with other reviews.

## 3. What happened in the session

- **nest:** run `node ~/dev/pecker-nest/scripts/session-report.ts <confirmed session files>`, and once with `--json`. Use the prompts (how often David steered), models and cost, the router ("Outcome of the switches", "Fallbacks at request time"), providers, tools (failed edits, loops), gates (runs, repair rounds, hand-backs, weakened-test check) and safety blocks.
- **Cursor:** use the adapter's numbers from the facts (gate runs, repair rounds, hand-backs, weakened-test findings, blocks). Ask David for the model he used and for the path of the conversation's transcript (Cursor hands it to hooks as `transcript_path`), and count tool calls, failed edits and repeated calls in it yourself.
- **Raw logs:** to find a cause you may read the Pi session files and Cursor's transcript on this machine. Quote at most five lines in your review, never a prompt, a secret or a key, and put only your own words into the record.
- **Field note:** if the facts name an open field note, read its Interventions table. Interventions measure how much help the agent needed; they are not its output.
- **David's commits:** commits outside the confirmed sessions count as David's, not the agent's.

## 4. Final gate state

For a Cursor pull request with adapter records, the adapter's last result is the final state. Otherwise take CI from the facts: green or red is final. If CI still runs or there is none and the facts say the check can be repeated locally, run the check command of `.pi/gate.json` and record the exit code and at most five lines of the end of its output.

## 5. Outcome and problems

Read the diff (`gh pr diff <pr>`). If the facts warn about a large diff, read the files that matter and list the ones you saw only in the `--stat`. Go through the acceptance checks one by one: met, not met or unknown, each with its evidence. Then note every problem with its evidence: bugs, weakened or skipped tests, broken rules of the repository's `AGENTS.md` or `CLAUDE.md`, scope creep, missing tests, needless cost.

Every problem needs evidence: a `path:line` in the diff, a number from the session report or the adapter, or a gate round. Without evidence it is not listed. Run `node ~/dev/pecker-nest/scripts/nest-review.ts patterns --last 20` to see whether a problem recurs or a fix did not work, and say so.

## 6. Put each problem down to one lever

| Lever | nest | Cursor |
| --- | --- | --- |
| Config | model per role, thinking level, router thresholds, compaction, MCP servers on or off | model and effort |
| Instructions | system prompt (`agent/APPEND_SYSTEM.md`), `AGENTS.md`, skills, prompts, subagent roles, knowledge base content | rules, `AGENTS.md`, skills |
| Harness code | router, quality gate, safety gate and protect logic, the tools the agent gets (`extensions/`) | the adapter's hooks (`cursor/`), only partly adjustable |
| Target repository | code, tests, structure and docs of the product, `.pi/gate.json`, `.pi/protect.json` | the same |
| Task | how precisely David worded the task and how big he cut it, his steering during the session | the same |
| Environment | provider errors, network, container, local tools, a reachable knowledge base | the same, without the container |

- The kind of cause decides, not where the file lies. The `AGENTS.md` of the product and the knowledge base's content are instructions: text the model reads. Router thresholds and MCP servers on or off are config: values without logic of their own.
- Exactly one lever per problem: the one where a fix is cheapest and lasts longest. Name contributing levers in one sentence.
- A problem without a clear cause, such as a model limit or a one-off, goes under **Observe** and gets no fix yet. A fix is due once it turns up in several pull requests; `patterns` shows that.
- Give each problem a tag from `TAGS` in `~/dev/pecker-nest/scripts/nest-review.ts`. If none fits, propose a short kebab-case tag and mark it new; David adds it to the list or maps it.
- For each problem give several concrete fixes within its lever (a new skill, one more rule, a config change, a test, a better cut task), each with effort S, M or L and benefit low, medium or high. Mark one as recommended; the choice is David's. Models, thinking levels, routing and router thresholds are David's decisions: propose, never decide. Never propose to weaken a gate, the harness protection or the weakened-test check.
- A lever where everything went well gets one line saying so. Do not invent problems.

## 7. The review

Print the review in this order, in English, so David can copy it whole:

````markdown
# nest review: <repo> #<pr> · <YYYY-MM-DD>

- Pull request: <url> · origin: nest | Cursor (<model>) · reviewer: Claude (<model>)
- Config under test: <the line from collect>
- Window: <start> → <end> (<source>) · sessions: <files, or "Cursor conversation">
- Notes: <warnings, self-review, interventions: count>

## Outcome

Task met: yes | partly | no. <one sentence>

| Acceptance check | Status | Evidence |
| --- | --- | --- |

<what went badly, two or three sentences>

## Problems

| # | Problem | Evidence | Lever | Tag |
| --- | --- | --- | --- | --- |

### 1. <problem>

Lever: <lever>. <contributing levers, one sentence, if any>

| Fix | Effort | Benefit |
| --- | --- | --- |
| **<fix>** (recommended) | S | high |
| <fix> | M | medium |

## Levers without findings

- <lever>: <one line>

## Observe

- <tag>: <what, with evidence> (<n> PRs so far)

## Record

```nest-review
{"kind":"review","date":"<YYYY-MM-DD>","repo":"<repo>","pr":<n>,"from":"nest|cursor","nestCommit":"<commit from the config line>","reviewer":"Claude <model>","taskMet":"yes|partly|no","findings":[{"lever":"<lever id>","tag":"<tag>"}],"observe":[{"tag":"<tag>"}]}
```
````

The record is one JSON line with ids only, no text: lever ids are `config`, `instructions`, `harness`, `target-repo`, `task`, `environment`. `patterns` reads it.

Then tell David how to save it, with the file name filled in: copy the review, then run (the same in bash and fish)

```bash
mkdir -p ~/dev/pecker-nest/field-notes/reviews
pbpaste > ~/dev/pecker-nest/field-notes/reviews/<YYYY-MM-DD>-<repo>-pr<n>.md
```

When David later says he applied a fix for a tag, give him the line that records it, for example (the same in bash and fish)

```bash
echo '{"kind":"fix","date":"<YYYY-MM-DD>","lever":"instructions","tag":"tests-not-run","ref":"pecker-nest#<pr>"}' >> ~/dev/pecker-nest/field-notes/reviews/fixes.jsonl
```

`patterns` then shows whether the tag still turns up in later reviews.

Rules: no secrets, no held-out eval samples, at most five-line excerpts. Reviews stay on this machine: `field-notes/` is git-ignored, pecker-nest is public, and nothing from a private repository goes into a commit.
