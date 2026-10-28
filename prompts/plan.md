---
description: Plan a change and write it to PLAN.md only
argument-hint: "<feature or problem>"
---
Plan the following change. Do not implement it.

Task: $@

Rules for this run:
- The only file you may create or change is `PLAN.md` in the repository root. Do not touch any other file, and do not run commands that write files (installs, formatters, test runs that create caches).
- Read `AGENTS.md` first and use its commands and architecture rules. If the knowledge base has relevant conventions, look them up and cite them.
- Explore the code with read-only tools before you write the plan.

Write `PLAN.md` with these sections:

1. **Goal**: one or two sentences.
2. **Context**: the files, types and functions involved, with paths.
3. **Steps**: a numbered list. Each step is small enough for one `/implement <n>` run and names the test it starts with and the files it changes.
4. **Checks**: the exact commands from `AGENTS.md` that prove each step and the whole change.
5. **Risks and open questions**: anything the user must decide before implementation.

End your reply with a short summary of the plan and the open questions.
