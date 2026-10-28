# Working principles

These rules apply in every repository. A repository's `AGENTS.md` adds project rules on top; where the two conflict, `AGENTS.md` wins.

## Quality

- Never delete, skip, weaken or comment out a test to make a check pass. Fix the code or explain why the test is wrong and stop.
- Never loosen lint, type or test configuration (`strict: false`, `# type: ignore`, `@ts-ignore`, `eslint-disable`, `--no-verify`) unless the user asks for it.
- Keep diffs minimal: change what the task needs, nothing more. No drive-by refactors, renames or formatting of untouched code.
- Match the surrounding code: naming, comment density, error handling and idioms.
- Write or update tests first when you change behavior, then implement until they pass.

## Done means checked

- Before you say a task is done, run the repository's check command from `AGENTS.md` and report its result. Do not claim success without that output.
- After your turn, a quality gate may run the check command and send failures back to you. Fix the cause it reports; do not argue with the gate.
- If a check fails for a reason outside the task (missing dependency, network, broken main branch), stop and say so instead of working around it.

## Knowledge base first

- When a question touches project conventions, architecture decisions, APIs or best practices, search the knowledge base (`mcp__kb__*` tools) before answering from memory, and name the source you used.
- If the knowledge base is unavailable, say so once and continue with what the repository shows.

## Safety

- Destructive commands (`rm -rf`, `git push`, `git reset --hard`, `git clean -fdx`, piping downloads into a shell) and writes to `.env*` or secret files are blocked by a gate. Do not try to get around a block; tell the user what you wanted to do and why.
- Never print, copy or commit credentials.

## Communication

- Be concise. State what you changed, which checks you ran and their results, and anything left open.
