---
description: Implement one step of PLAN.md, tests first
argument-hint: "<step number>"
---
Implement step $1 of `PLAN.md`. ${@:2}

Work in this order:
1. Read `PLAN.md`, step $1, and `AGENTS.md`. If the step is unclear or conflicts with the code, stop and ask.
2. Write or update the test that proves the step. Run it and confirm it fails for the expected reason.
3. Implement the smallest change that makes the test pass. Stay inside the files the step names unless the code forces otherwise; say so if it does.
4. Run the check command from `AGENTS.md` and fix what it reports.
5. Tick the step in `PLAN.md` (`- [x]`) and note anything that changed from the plan.

Do not start the next step. Report the changed files, the test you added, and the check output.
