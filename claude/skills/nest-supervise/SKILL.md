---
name: nest-supervise
description: Start supervising a pecker-nest (Pi) session in the current repository. Claude watches and logs interventions instead of building. Use when David says he is starting a nest session here.
argument-hint: "[task, brief path or milestone]"
disable-model-invocation: true
---

# Supervise a nest session

nest (Pi with DeepSeek V4.1 Flash and a strong model, GLM 5.3 or Kimi K3.1 Pro, configured in `~/dev/pecker-nest`) does the work in this repository. You watch. The point of the session is to find out what nest can do, so do not fix what nest should fix.

`<repo>` below is the repository's directory name (`basename "$PWD"`). The commands are the same in bash, zsh and fish.

## Start

1. Record the repository, branch, `git rev-parse HEAD`, the time and the task. The task is `$ARGUMENTS`; if it is empty, ask David for it in one line. If it names a brief (for example `docs/milestones/M1.md`), read it and note its acceptance checks.
2. Find out whether this continues a session. Run `node ~/dev/pecker-nest/scripts/field-note.ts open --repo <repo>`.
   - It prints a path: that note is still open (no end HEAD), so the session runs over more than one day. Continue it: add today's date and the current HEAD to its `Days` line, keep its start HEAD and its interventions, and tell David which note you continue. If the task is a different one, ask David whether to close the old note with `/nest-handoff` first.
   - It prints nothing (exit code 1): create the field note `~/dev/pecker-nest/field-notes/<YYYY-MM-DD>-<repo>-<short-task-slug>.md` from `~/dev/pecker-nest/field-notes/TEMPLATE.md` and fill in the Session section. Write the first line as `<repo> / <branch>` with the directory name, because that is how the note is found again. Leave the end HEAD empty: that is what keeps the note open.
3. Record the configuration under test. Run `node ~/dev/pecker-nest/scripts/field-note.ts config --repo <repo>` and copy its two lines into the Session section as they are (`Config under test`, `Compared with the previous note`). Do not type them by hand and do not correct them: the script reads the pecker-nest commit, the Pi version, the thinking level per router tier and per subagent role and the strong model from the repository. In a continued note, add the lines again only if they differ from the ones already there, with the date, and say so to David: a session whose configuration changed halfway cannot be compared as one.
   - `with uncommitted changes` in the line means the checkout is not exactly that commit. Tell David; the numbers of this session are then not comparable with others.
   - `differs from the previous note` means nest itself changed since the last session in this repository. That is what a before-and-after comparison needs, so name both commits to David.
   - The strong model in the line is the default. `/strong kimi` changes it for a session; the session report says at the handoff which model stepped in.
4. Check the setup: run `~/dev/pecker-nest/scripts/doctor.sh --repo "$PWD"` and copy every `WARN` and `FAIL` line into the field note; each ends with its fix. It covers the tools, the links, the OpenRouter login, the models and the key for the live probe, and this repository's `.pi/protect.json`, `.pi/gate.json` and `AGENTS.md`. The Docker daemon and the image are left out (one `SKIP` line): only headless runs need them, so do not add `--docker` and do not copy that line. It cannot see whether the project is trusted in Pi; ask David if the gate does not run. Do not fix the setup yourself; tell David.

## During the session

You may, without it counting as an intervention: read files and logs, run read-only commands (`git status`, `git diff`, `git log`, the session report in `~/dev/pecker-nest/scripts/session-report.ts`), and answer David's questions.

Everything else is an intervention and goes into the field note's Interventions table right away: time, what you did, why (what nest failed at), size (files and lines), and a category: `bug-fix`, `unblock`, `environment`, `scope`, `takeover`, `advice` (a hint David passes on to nest beyond restating the task) or `admin` (see below). Only intervene when David asks.

When David asks you to, you may push nest's branch and open the pull request for its work. That is routine release work, not a repair of what nest built: log it as category `admin`, and `/nest-handoff` does not count it against nest. Push the branch nest worked on, never `main`; describe only what nest did, with its own commits; do not merge, and do not change the code to make it mergeable (a failing check belongs in the PR description and in the field note).

Rules:
- Never commit or merge in this repository, and never edit `.pi/` or `~/dev/pecker-nest`. Pushing and opening the PR is allowed only as `admin` work above, when David asks. Harness ideas go into the field note under Harness findings, with the evidence.
- Field notes stay on this machine (the folder is git-ignored; pecker-nest is a public repository). No secrets, no held-out eval samples, at most five-line code excerpts.

## End

When David says the session is over, run `/nest-handoff`; it closes the note. When he only stops for the day, leave the note open and say so: the next `/nest-supervise` here continues it.
