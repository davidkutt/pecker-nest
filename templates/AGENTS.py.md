# AGENTS.md

<!-- Template from pecker-nest/templates/AGENTS.py.md. Fill in every TODO, then delete this comment. -->

## Project

TODO: one paragraph on what this service or library does and who uses it.

## Commands

| Purpose | Command |
| --- | --- |
| Install | `uv sync` |
| Check (lint, types, tests) | `uv run ruff check . && uv run pyright && uv run pytest -q` |
| Unit tests | `uv run pytest -q` |
| One test file | `uv run pytest -q tests/test_x.py` |
| One test by name | `uv run pytest -q -k "name"` |
| Typecheck only | `uv run pyright` |
| Lint only | `uv run ruff check .` |
| Format | `uv run ruff format .` |

The check command is the quality gate (`.pi/gate.json`). It must pass before a task counts as done.

## Architecture rules

- TODO: package layout and which modules may import which.
- TODO: where new modules go and how they are named.
- Use the existing exception hierarchy and logger; do not add new ones.
- No new dependency without asking; add dependencies with `uv add`, never by editing the lockfile.

## Code conventions

- Type hints on all public functions; pyright must stay clean. No `# type: ignore` without a reason.
- No `# noqa` without a reason.
- Tests live in `tests/` as `test_*.py` and use pytest fixtures, not `unittest.TestCase`.

## Definition of done

1. Behavior change is covered by a test that failed before the change.
2. The check command passes.
3. No unrelated changes in the diff.
4. Public API changes are noted in the PR description.
