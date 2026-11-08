# Field notes

One note per supervised nest session, written by Claude Code with the skills in `claude/skills/`:

1. `/nest-supervise <task>` at the start, in the product repository: creates the note and logs every intervention.
2. `/nest-handoff` at the end: fills in metrics (`scripts/session-report.ts`), outcome, assessment and harness findings, and prints the part for the planning chat.

Notes are local: everything in this folder except this README and `TEMPLATE.md` is git-ignored, because pecker-nest is public and the notes describe private repositories. Link the skills with `scripts/link.sh --claude`.
