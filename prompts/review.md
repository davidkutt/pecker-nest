---
description: Review the current diff against AGENTS.md, findings only
argument-hint: "[base ref, default: HEAD]"
---
Review the changes in this repository against `${1:-HEAD}`. Do not edit any file.

1. Collect the diff: `git diff ${1:-HEAD}` plus untracked files from `git status --short`.
2. Read `AGENTS.md` and check the diff against its commands, architecture rules, conventions and definition of done.
3. Look up relevant conventions in the knowledge base and cite what you used.
4. Check test coverage: every behavior change needs a test that would fail without it. Flag deleted, skipped or weakened tests and loosened lint/type settings.
5. Run the check command from `AGENTS.md` and include its result.

Report findings as a list. Each finding has a severity (P0 blocks merge, P1 fix before release, P2 note), the file and line, the evidence, and the smallest fix. Report only concrete issues you can prove from the code or a check. If there are none, say `No issues found.`

End with `Merge verdict: BLOCK`, `Merge verdict: OK` or `Merge verdict: OK with notes`.
