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

Everything else is an intervention and goes into the field note's Interventions table right away: time, what you did, why (what nest failed at), size (files and lines), and a category: `bug-fix`, `unblock`, `environment`, `scope`, `takeover` or `advice` (a hint David passes on to nest beyond restating the task). Only intervene when David asks.

Rules:
- Never commit, push or merge in this repository, and never edit `.pi/` or `~/dev/pecker-nest`. Harness ideas go into the field note under Harness findings, with the evidence.
- Field notes stay on this machine (the folder is git-ignored; pecker-nest is a public repository). No secrets, no held-out eval samples, at most five-line code excerpts.

## End

When David says the session is over, run `/nest-handoff`.
