---
name: nest-supervise
description: Start supervising a pecker-nest (Pi) session in the current repository. Claude watches and logs interventions instead of building. Use when David says he is starting a nest session here.
argument-hint: "[task, brief path or milestone]"
disable-model-invocation: true
---

# Supervise a nest session

nest (Pi with DeepSeek V4.1 Flash and GLM 5.3, configured in `~/dev/pecker-nest`) does the work in this repository. You watch. The point of the session is to find out what nest can do, so do not fix what nest should fix.

## Start

1. Record the repository, branch, `git rev-parse HEAD`, the time and the task. The task is `$ARGUMENTS`; if it is empty, ask David for it in one line. If it names a brief (for example `docs/milestones/M1.md`), read it and note its acceptance checks.
2. Create the field note `~/dev/pecker-nest/field-notes/<YYYY-MM-DD>-<repo>-<short-task-slug>.md` from `~/dev/pecker-nest/field-notes/TEMPLATE.md` and fill in the Session section. Note the pecker-nest commit (`git -C ~/dev/pecker-nest rev-parse --short HEAD`) and `pi --version`.
3. Check the setup and note anything missing: `.pi/gate.json` and `.pi/protect.json` present (templates in `~/dev/pecker-nest/templates/`), project trusted in Pi, `~/dev/pecker-nest/scripts/link.sh --check` clean. Do not fix the setup yourself; tell David.

## During the session

You may, without it counting as an intervention: read files and logs, run read-only commands (`git status`, `git diff`, `git log`, the session report in `~/dev/pecker-nest/scripts/session-report.ts`), and answer David's questions.

Everything else is an intervention and goes into the field note's Interventions table right away: time, what you did, why (what nest failed at), size (files and lines), and a category: `bug-fix`, `unblock`, `environment`, `scope`, `takeover`, `advice` (a hint David passes on to nest beyond restating the task) or `admin` (see below). Only intervene when David asks.

When David asks you to, you may push nest's branch and open the pull request for its work. That is routine release work, not a repair of what nest built: log it as category `admin`, and `/nest-handoff` does not count it against nest. Push the branch nest worked on, never `main`; describe only what nest did, with its own commits; do not merge, and do not change the code to make it mergeable (a failing check belongs in the PR description and in the field note).

Rules:
- Never commit or merge in this repository, and never edit `.pi/` or `~/dev/pecker-nest`. Pushing and opening the PR is allowed only as `admin` work above, when David asks. Harness ideas go into the field note under Harness findings, with the evidence.
- Field notes stay on this machine (the folder is git-ignored; pecker-nest is a public repository). No secrets, no held-out eval samples, at most five-line code excerpts.

## End

When David says the session is over, run `/nest-handoff`.
