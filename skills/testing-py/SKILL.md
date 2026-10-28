---
name: testing-py
description: Write, run and debug pytest tests in Python repositories managed with uv. Use when adding or changing tests, reproducing a bug with a failing test, or when ruff, pyright or pytest fails.
---

# Testing in Python repositories

The repository's `AGENTS.md` is authoritative for commands. These are the defaults when it is silent.

## Commands

| Goal | Command |
| --- | --- |
| Whole check (gate) | `uv run ruff check . && uv run pyright && uv run pytest -q` |
| All tests | `uv run pytest -q` |
| One file | `uv run pytest -q tests/test_orders.py` |
| One test by name | `uv run pytest -q -k "rejects_empty"` |
| Stop at first failure, show locals | `uv run pytest -x -l` |
| Typecheck | `uv run pyright` |
| Lint | `uv run ruff check .` |
| Lint autofix (only when asked) | `uv run ruff check --fix .` |

Run everything through `uv run` so the project's virtualenv and pinned tools are used. Add dependencies with `uv add` (or `uv add --dev`), never with `pip install`.

## Conventions

- Tests live in `tests/`, files `test_*.py`, functions `test_<behavior>`.
- Plain `assert` statements; `pytest.raises(SomeError, match="...")` for errors.
- Fixtures in `conftest.py` for shared setup; keep them small and explicit.
- `tmp_path` for files, `monkeypatch` for environment variables, `freezegun` or an injected clock for time.
- Parametrize instead of copying tests: `@pytest.mark.parametrize("value, expected", [...])`.
- Mock only at I/O boundaries (HTTP, database, clock). Prefer fakes over `MagicMock` chains.

## Test-first loop

1. Write the test for the new behavior and run only that test. It must fail, and for the reason you expect.
2. Implement until it passes.
3. Run the whole check command before reporting done.

## Never

- `@pytest.mark.skip`, `xfail` or `pytest.skip()` added to get green.
- `# type: ignore` or `# noqa` without a reason in the same comment.
- Deleting or loosening an assertion to make a test pass.

## Reading failures

- `ModuleNotFoundError` for the project itself: the package is not installed in the venv; run `uv sync`.
- pyright errors in tests only: check that `tests/` is in pyright's `include` and that fixtures are typed.
- Order-dependent failures: run `uv run pytest -q -p no:randomly` or a single test to isolate shared state.
