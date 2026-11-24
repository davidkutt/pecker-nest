# How to use nest

DOs and DON'Ts for building software with nest. They aren't tied to one project: project rules stay in each repository's `AGENTS.md`. Installing nest: [SETUP.md](SETUP.md). Acceptance tests and the supervised session: [RUNBOOK.md](RUNBOOK.md).

This file grows from real tasks. It starts small on purpose.

## How entries work

- One line per entry: **DO** or **DON'T**, the rule, then the reason in a few words. Put the source in brackets when a task taught it, e.g. `[pecker-drum M2]`.
- `(untested)` marks an entry no nest session has tried yet. Drop the mark once a task confirms it, or rewrite the entry.
- This file is for you, the person driving nest. If an entry keeps being needed, the problem is a lever, not your memory: move the entry into the agent's instructions (`agent/APPEND_SYSTEM.md`, a skill, the repository's `AGENTS.md`) or into a gate rule, and delete it here. `node ~/dev/pecker-nest/scripts/nest-review.ts patterns` shows what recurs.

## The default loop

1. Unclear task: `/hard`, then `/skill:grill-me <brief>`, then `/flash`. Check each round's recommendations before you answer.
2. `/plan <brief>` in the same session writes `PLAN.md` on the strong model, with the decisions from the grill. Read it and answer its open questions.
3. `/implement 1`, `/implement 2`, … one step per prompt; each step ends with a commit. The quality gate repairs up to two rounds. `/new` between steps is fine.
4. Review before the pull request on Kimi K3.1 Pro: `/strong kimi`, `/hard`, `/review`, `/flash`, `/strong glm`. `/review` reviews the branch against `main`; the last command puts GLM 5.3 back for `/plan`.
5. You push and open the pull request (nest's gate blocks `git push`), then `/nest-review <PR>` in Cursor (in Claude Code until 06.12.2026); nest is the default origin, a Cursor PR needs `--from cursor`. Review fixes go onto the same branch.
6. A supervised session ends with `/nest-handoff`, after `/nest-review`: the handoff closes the field note, and nest-review reads the interventions only from an open note.

## Before a task

- **DO** run `~/dev/pecker-nest/scripts/doctor.sh --repo "$PWD"` (same in bash and fish) and fix every `FAIL` first, the credential checks included. With a broken gate or a missing `AGENTS.md` the session proves nothing; without a Pi login the first escalation fails. [pecker-drum M2.1]
- **DO** give every repository its own commit identity (`git config user.name`, `git config user.email`) and turn on GitHub's "Block command line pushes that expose my email". nest commits with whatever git config gives it, and one commit went out with a personal address. [pecker-drum M2.1]
- **DO** check that `AGENTS.md` names the check command and `.pi/gate.json` runs exactly that command. "Done" means the gate is green.
- **DO** `/trust` each repository once. Otherwise the gate doesn't run (Pi says "gate.json ignored: this project is not trusted").
- **DO** start a fresh Pi session (`/new`) for each new task. A continued session carries the old task's context and branch. [pecker-drum]
- **DON'T** update pecker-nest while a supervised session is open. Its numbers then can't be compared with other sessions. [v1-notes 12.11.2026]

## Planning

- **DO** write the task as a brief: goal, acceptance checks (what proves it's done), scope and out of scope. Plans, reviews and handoffs are all graded against it.
- **DO** read `PLAN.md` in full before you approve it. Each step names the test it starts with and the files it changes, and is small enough for one `/implement <n>`.
- **DO** have every plan checked against the code, not against memory, older handoffs or the target's docs. A handoff had a target's user roles and API prefix wrong; only the target's code showed it. [pecker-drum M2]
- **DO** answer the plan's open questions before `/implement`, and record real decisions where the repository keeps them (ADR, decision table).
- **DO** make the plan's docs list name the README whenever user-facing output changes (report columns, file formats, commands). [pecker-drum M2.1]
- **DON'T** accept grill-me's recommendations wholesale. They are your decisions, and checking them is the cheapest test of nest's planning: in M2.1, 4 of 14 needed a change and one design question was missing. [pecker-drum M2.1]
- **DON'T** approve a plan that decides product or architecture questions on its own. Those are yours.
- **DON'T** put two features in one plan. One task, one pull request, one model per pull request. [RUNBOOK, 21.11.2026]

## Coding tasks

- **DO** look at the step's commit (`git show --stat`) before the next `/implement`.
- **DO** start a fresh session (`/new`) between steps when the last one was long: `PLAN.md` and the commits carry the state. Stay in the session only if nest reported a deviation it did not write back into `PLAN.md`. [pecker-drum M2.1]
- **DO** let the quality gate run its repair rounds. Step in only when it hands back: interventions are what the handoff measures.
- **DO** use `/rewind` to undo a bad turn instead of repairing it by hand.
- **DO** switch to `/hard` for a step Flash has failed at twice, and back with `/flash`.
- **DON'T** work around a safety-gate block. Wrong blocks are harness findings for pecker-nest.
- **DON'T** let nest run anything that costs money or touches a live system. You run those.

## Refactorings

- **DO** refactor in its own task and pull request, never mixed with a behaviour change. A review can't tell a moved line from a changed one. (untested)
- **DO** keep the tests unchanged: green before, green after. A refactor that needs a test change is a behaviour change. (untested)
- **DO** add characterization tests first where coverage is thin. (untested)
- **DON'T** ask for "clean up X". Name the target shape and the invariant ("public API unchanged"). nest's instructions forbid drive-by refactors, so a vague ask gets nothing or scope creep. (untested)

## Testing

- **DO** require a test that fails first for every behaviour change, and check that it failed for the expected reason.
- **DO** break each new guard once in review: delete the check and run the tests. If they stay green, the guard is untested. [pecker-drum M2, M2.1]
- **DO** build stand-ins and fakes from the real system's code, including its order of events, not from its docs. [pecker-drum M2]
- **DON'T** accept tests that call the network or a live model. Mock at the I/O boundary.
- **DON'T** rely on the gate alone for weakened tests. It catches deleted and skipped tests, suppressions and loosened configuration, but not hollowed-out assertions or dropped `parametrize` cases. Check those in review.

## AI-driven UI and layout

- **DO** give a reference: a screenshot, an existing screen or component, or the design tokens. Add the states (empty, loading, error, long text) and the breakpoints. (untested)
- **DO** know the image limit. GLM 5.3 reads no images, so with a screenshot in the conversation the router keeps Flash even when it would escalate. `/strong kimi` makes Kimi K3.1 Pro the strong model, and it reads images. [RUNBOOK M5]
- **DO** keep it to one screen or component per task. (untested)
- **DO** check the result by looking at it (run it, take a screenshot), not by the model's description of it. (untested)
- **DON'T** let nest add a UI library or component kit. New third-party code needs your OK.

## Reviews and pull requests

- **DO** run the repository's text checks on the pull request text before it goes up: no secrets, no private details, nothing from an employer.
- **DO** have the pull request description refreshed after every commit that follows it, before the merge. [pecker-drum M2.1]
- **DO** tell the supervisor each intervention as it happens. It doesn't watch Pi; it logs only what you tell it. [pecker-drum M2.1]
- **DO** log as `advice` every design question or fact you add that nest should have found itself. Fixing findings from nest's own `/review` is not an intervention. [pecker-drum M2.1]
- **DO** run `/review` on Kimi K3.1 Pro before every pull request (loop step 4), not on Flash. In a blind rerun of an M2.1 snapshot, Flash missed the bug that had shipped, GLM 5.3 found it but called it unreachable and offered to document it, and Kimi found it, rated it P1, proved it with a probe and proposed the fix that was merged. One run per model: revisit as reviews come in. [pecker-drum M2.1]
- **DON'T** copy Kimi's output unread. Its working notes can show up in the answer: one review started with them. [pecker-drum M2.1]
- **DO** squash-merge a messy history and merge a clean one as it is.
- **DON'T** let an agent merge, approve, close or comment on pull requests. You merge.

## Commands an agent gives you

- **DO** ask for bash first, then fish. A command that is the same in both shells is shown once and labelled so.
- **DO** chain dependent steps (`&&` in bash, `; and` in fish) so that a failure stops the rest. When the next block depends on reading the output, the agent says "run the blocks one at a time".
- **DO** guard steps that must not run on bad input: `! grep -q 'error' "$OUT" && cp …` (fish: `not grep -q 'error' $OUT; and cp …`).
- **DON'T** put `grep -c` in a chain: it exits 1 when the count is 0.
- **DON'T** use `<placeholder>` in a command: the shell reads `<` as a redirect. Use a variable or `PUT-VALUE-HERE`.
- **DON'T** paste lines after a `read -s` line in the same paste: they become its input.
- **DON'T** trust these two git defaults: `git check-ignore -q` takes one path only (`-v` takes several), and `git rm` of a folder's last file removes the folder (run `mkdir -p` before copying back into it).

## After a task

- **DO** run `/nest-review` for each pull request and save the review, then `/nest-handoff` for a supervised session.
- **DO** record every fix you apply for a review tag in `field-notes/reviews/fixes.jsonl`, so `patterns` shows whether the tag comes back.
- **DO** add what the task taught to this file soon, with its source.
