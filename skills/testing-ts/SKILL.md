---
name: testing-ts
description: Write, run and debug Vitest tests in TypeScript repositories. Use when adding or changing tests, reproducing a bug with a failing test, or when a TypeScript check (tsc, eslint, vitest) fails.
---

# Testing in TypeScript repositories

The repository's `AGENTS.md` is authoritative for commands. These are the defaults when it is silent.

## Commands

| Goal | Command |
| --- | --- |
| Whole check (gate) | `pnpm run check` |
| All tests | `pnpm exec vitest run` |
| One file | `pnpm exec vitest run src/foo/bar.test.ts` |
| One test by name | `pnpm exec vitest run -t "rejects empty input"` |
| Related to changed files | `pnpm exec vitest related src/foo/bar.ts --run` |
| Typecheck | `pnpm exec tsc --noEmit` |
| Lint | `pnpm exec eslint .` |

Always pass `run` (or `--run`): plain `vitest` starts watch mode and never exits.

## Conventions

- Test files sit next to the code: `bar.ts` → `bar.test.ts`.
- One `describe` per unit, test names state behavior: `it("returns 404 when the user is missing")`.
- Arrange, act, assert; one behavior per test.
- Prefer real objects and in-memory fakes over mocks. Use `vi.fn()` only at I/O boundaries (HTTP, clock, filesystem). Reset with `vi.restoreAllMocks()` in `afterEach`.
- Use `vi.useFakeTimers()` instead of real waits. No `setTimeout` sleeps in tests.
- Snapshot tests only for stable serialized output, never for behavior.

## Test-first loop

1. Write the test for the new behavior and run only that file. It must fail, and for the reason you expect.
2. Implement until it passes.
3. Run the whole check command before reporting done.

## Never

- `it.skip`, `describe.skip`, `it.only`, `it.todo` left in the diff.
- `@ts-ignore`, `@ts-expect-error` or `as any` to silence the typecheck.
- Deleting or loosening an assertion to make a test pass.

## Reading failures

- `Cannot find module` in tests but not in the build: check the `vitest.config` aliases match `tsconfig` `paths`.
- Typecheck passes but tests fail on types: Vitest does not typecheck; trust `tsc --noEmit` for types.
- Flaky timing: look for real timers, shared module state or unawaited promises before adding retries.
