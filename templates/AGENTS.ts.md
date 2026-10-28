# AGENTS.md

<!-- Template from pecker-nest/templates/AGENTS.ts.md. Fill in every TODO, then delete this comment. -->

## Project

TODO: one paragraph on what this service or library does and who uses it.

## Commands

| Purpose | Command |
| --- | --- |
| Install | `pnpm install --frozen-lockfile` |
| Check (lint, types, tests) | `pnpm run check` |
| Unit tests | `pnpm test` |
| One test file | `pnpm exec vitest run path/to/file.test.ts` |
| One test by name | `pnpm exec vitest run -t "name"` |
| Typecheck only | `pnpm exec tsc --noEmit` |
| Lint only | `pnpm run lint` |

`pnpm run check` is the quality gate (`.pi/gate.json`). It must pass before a task counts as done.

## Architecture rules

- TODO: layer boundaries, e.g. `src/domain` imports nothing from `src/infra`.
- TODO: where new modules go and how they are named.
- Use the existing error type and logging helper; do not add new ones.
- No new runtime dependency without asking.

## Code conventions

- TypeScript `strict`. No `any` without a comment explaining why; no `@ts-ignore`.
- ESM imports, named exports.
- Tests live next to the code as `*.test.ts` and use Vitest.

## Definition of done

1. Behavior change is covered by a test that failed before the change.
2. `pnpm run check` passes.
3. No unrelated changes in the diff.
4. Public API changes are noted in the PR description.
