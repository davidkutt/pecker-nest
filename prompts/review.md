---
description: Review the branch against AGENTS.md, findings only
argument-hint: "[base branch or ref, default: main]"
---
Review the changes on this branch since it left `${1:-main}`, committed or not. Do not edit any file.

1. Collect the diff: `git merge-base ${1:-main} HEAD` gives the commit the branch left from; run `git diff` against that commit, and add untracked files from `git status --short`.
2. Read `AGENTS.md` and check the diff against its commands, architecture rules, conventions and definition of done, and the branch's commits (`git log` from that commit to `HEAD`) against its commit rules, identity included. When an identity breaks the rule, name the commit and the field (author or committer); never print the address it used.
3. If knowledge-base tools (`mcp__kb__*`) are available to you, look up the conventions for the touched area and cite the source. If not, say that the knowledge base was not consulted.
4. Check test coverage: every behavior change needs a test that would fail without it. Flag deleted, skipped or weakened tests and loosened lint/type settings.
5. Run the check command from `AGENTS.md` and include its result.

Report findings as a list. Each finding has a severity (P0 blocks merge, P1 fix before release, P2 note), the file and line, the evidence, and the smallest fix. Report only concrete issues you can prove from the code or a check. If there are none, say `No issues found.`

End with `Merge verdict: BLOCK`, `Merge verdict: OK` or `Merge verdict: OK with notes`.
