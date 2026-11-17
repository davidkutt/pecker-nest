# Field notes

One note per supervised nest session, written by the supervising agent (Claude Code, Cursor or Pi) with the skills in `skills/nest-supervise` and `skills/nest-handoff` (in Pi `/skill:nest-supervise`, `/skill:nest-handoff`):

1. `/nest-supervise <task>` at the start, in the product repository: creates the note and logs every intervention. On a later day of the same session it continues the open note instead of starting a new one.
2. `/nest-handoff` at the end: fills in metrics (`scripts/session-report.ts`), outcome, the defects that passed nest's own gate and review, assessment and harness findings, closes the note and prints the part for the planning chat.

A note is open until its Session section has an end HEAD. `node scripts/field-note.ts open --repo <repo>` prints the open note of a repository, and `node scripts/field-note.ts config --repo <repo>` prints the configuration under test (pecker-nest commit, Pi version, thinking level per tier and role, strong model) and whether the commit differs from the previous note. Both skills take these lines from the script instead of typing them: a before-and-after comparison is only valid when they are right.

Notes are local: everything in this folder except this README and `TEMPLATE.md` is git-ignored, because pecker-nest is public and the notes describe private repositories. Link the skills with `scripts/link.sh --claude`, `--cursor` or `--pi`. In Pi, nest's safety gate refuses writes to this folder, because it is part of the harness: the skills then give David the note's text to save.
