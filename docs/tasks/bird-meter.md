# Handoff: the woodpecker's context and cost meter

**Repository:** `davidkutt/pecker-nest`, base `main` at `41b168d` (24 November 2026)
**Branch to create:** `feat/bird-meter`
**Pi version:** `@earendil-works/pi-coding-agent` 1.5.0 (as pinned in `package.json`)

## Read first

1. `AGENTS.md`: repository rules. pecker-nest is never built with nest; this session is the right place.
2. `docs/tasks/bird-deluxe.md`: the bird's plan and decisions (ASCII only, no sound, the bird only reads).
3. `extensions/bird.ts` (wiring), `extensions/lib/bird.ts` (state machine, footer, session-entry helpers),
   `extensions/lib/bird-perch.ts` (the five-row perch: trunk, hole, chips, bubble), `test/bird.test.ts`,
   `test/bird-perch.test.ts`.
4. `docs/RUNBOOK.md`, section "Entschieden": the bird's rows from 24.11.2026.

## Working rules

- Every change goes through a PR from a new branch. Never merge, approve, close or comment on PRs.
- Commit as `davidkutt <52502283+davidkutt@users.noreply.github.com>`.
- No destructive git (force push, `reset --hard`, history rewrite) without David's explicit OK. Never print secrets or `.env` values.
- Public repository: nothing confidential from his employer; David stays pseudonymous ("David" / `davidkutt`).
- Code, comments and `docs/tasks/` are English; `docs/RUNBOOK.md` and `docs/SETUP.md` are German.
- Commands in docs and the PR description: the usual form first, then the fish form. David uses fish on macOS (Apple Terminal).

## Goal

The perch's trunk becomes a gauge for **how close the session is to auto-compaction**. The bubbles and the footer also show context and cost. A new `/meter` command prints the exact numbers. All decisions below are settled.

## Why it matters

nest sets `compaction.modelOverrides["router/escalate"].reserveTokens = 800000` in `agent/settings.json`. In Pi 1.5.0, a request routed by the virtual router compacts when:

```
contextTokens > routedModel.contextWindow − reserveTokens(selected model = router/escalate)
```

Two places in Pi's source show this, in `dist/core/agent-session.js`:
- `_exceedsCompactionThreshold(route.model, …)` uses the **routed** model's window but `getCompactionSettings(this.model)`, i.e. the **selected** model's settings.
- `getContextUsage()` uses `_limitsModel()` = routed model, otherwise the selected one.

Flash, GLM 5.3 and Kimi K3.1 Pro all have 1,048,576 tokens on OpenRouter (Pi's `pi-ai` provider data). So compaction starts at **248,576 tokens, about 24% of the window**.

Pi's footer shows the percentage of the whole window (e.g. `2.8%/1.0M`) and only turns yellow at 70% and red at 90%. A session never gets there. `2.8%` is really 12% of the way to compaction.

## Decisions (settled 24.11.2026)

1. **The trunk shows context until compaction.** Cost is not on the trunk.
2. **The command is `/meter`**, not part of `/bird`: `/meter` prints context and cost, `/meter context` prints only context, `/meter cost` prints only cost. It works even when the bird is off (`/bird off`).
3. **No budget for now:** numbers only. A daily budget would need to read session files and comes with L4's stats at the earliest.
4. **`/compact` nudge:** when a run ends with a green gate and the trunk is at 70% or more, the result bubble suggests `/compact`.
5. **Footer:** `ctx N%` (relative to the compaction point) from 50% on.
6. **The bird's read scope grows** by three things: context usage (`ctx.getContextUsage()`), costs from session entries, and the effective compaction settings (`pi.getSettings()`). It still writes no entry and no file and calls no model. Bubbles hold counts and money only, never file names, prompts or output.
7. **Unchanged:** printable ASCII only, colors only via theme tokens, no sound, no new dependencies, logic pure in `extensions/lib/` with unit tests.

## Spec

### The compaction point

- `usage = ctx.getContextUsage()`. Without it (no model, window ≤ 0) there is no meter: the trunk is drawn as today and there is no footer part.
- `window = usage.contextWindow`. This is the routed model's window, exactly what Pi compares against.
- `reserve` comes from `pi.getSettings().compaction` for the selected model `ctx.model`: `modelOverrides["<provider>/<id>"].reserveTokens`, otherwise `reserveTokens`, otherwise 16,384. This is the same fallback order as Pi's `getCompactionSettings`.
- `enabled = compaction.enabled ?? true`.
- `point = enabled ? window − reserve : window`.
- `fill = usage.tokens / point`. `usage.tokens === null` (right after a compaction, until the next answer) means unknown.
- **Guard:** `point ≤ 0` (reserve ≥ window) counts as full, and `/meter` explains it (see below).

### The trunk gauge

- The trunk's bark is 5 rows × 2 cells = **10 cells**. `filled = clamp(round(fill × 10), 0, 10)`.
- Fill order runs bottom-up: bottom row left cell, bottom row right cell, then the next row up.
- **Filled cell `#`**, colored `accent` below 70%, `warning` from 70%, `error` from 90%. Over 100% counts as all filled, `error`.
- **Free cell `:`**, colored `dim`. Not `.`, because `.` is the hole's first stage.
- **Unknown:** all cells `:` `dim`.
- **Walls** `|` stay `muted`, as today.
- **The hole** at beak height: `holeFor(pecks)` keeps its stages. Every `#` in its string is replaced by that cell's gauge character; the hole's own characters (`.` `o` `O` `(` `)`) stay as they are, `muted`.

Mockups:

```text
12%                        75% (filled cells yellow)              right after a compaction
    ,^.    |::|                ,^.    |::|  .----------------------.     ,^.  '  |::|  .---------------------.
   ( ^ =>  |o:|  < hmm... )   ( ^ =>  |o#|  < context 75% of 249k )   ( ^ => . |::|  < compacted from 241k )
   /)  )   |::|               /)  )   |##|  `----------------------'   /)  )  ' |::|  `---------------------'
  /_/ /    |::|              /_/ /    |##|                            /_/ /   . |::|
   `-`     |#:|               `-`     |##|                             `-`    ' |#:|
```

(The bubble's exact position follows the existing layout; the mockups only show the trunk and the texts.)

### Bubbles

**Crossing notes:**
- When the fill crosses **70%** upward, the bubble shows `context 74% of 249k` (`warning`, the actual percentage); at **90%**, `context 92% - compaction soon` (`error`).
- Each note shows for 4 s.
- A note fires again only after the fill has dropped back below its line, e.g. after a compaction.

**Priority while running:** `listen` > repair round > crossing note > activity bubble.

**Run cost** is the session cost now minus the session cost at the run's first `agent_start`.
- **Strong model thinking:** `GLM 5.3 is thinking... $0.012`, with the run cost so far.
- **Result bubbles,** in this order, so that cutting to the width drops the least important part first:
  - green: `gate green in 41s. /compact? (78%). $0.012. pecked 3, drummed 1`
  - red: `gate red. ouch. $0.020`
  - stopped: `stopped. I'll wait here. $0.004`
  - done: `done. $0.004. pecked 1`
  - Leave out the cost when it is 0, and the nudge when it doesn't apply. Without a tally, green keeps `tap tap!`.

**Nudge:** only for outcome `green` and a known fill ≥ 70%.

**Compaction scene** (`session_compact`):
- For 1.5 s, chips fall from every trunk row: deterministic, like `chipsAt`.
- The trunk shows all free.
- The bubble says `compacted from 241k` (from `compactionEntry.tokensBefore`), plus ` (overflow)` when `reason === "overflow"`.
- After the scene, the trunk stays unknown until the next answer.

**Compaction failed** (`session_compact_failed`, `aborted === false`): the note `compaction failed`, `error`, 4 s. Aborted: nothing.

### Footer

- From a known fill of 50%: `ctx 64%` at the end of the footer parts.
- Colors: `muted` from 50%, `warning` from 70%, `error` from 90%.
- Nothing below 50% or when the fill is unknown.

### `/meter`

Prints via `ctx.ui.notify(…, "info")`:

```
/meter          context 28k of 249k before compaction (12%), window 1.0M, reserve 800k - session $0.041, this run $0.012
/meter context  context 28k of 249k before compaction (12%), window 1.0M, reserve 800k (router/escalate)
/meter cost     session $0.041, this run $0.012
```

- **Between runs:** `last run` instead of `this run`.
- **Unknown context:** `context unknown until the next answer (just compacted)`.
- **Compaction off:** `context 28k of the 1.0M window (3%), auto-compaction off`.
- **Guard:** `reserve 800k >= window 512k: Pi compacts before every request`.
- **Anything else** (an unknown argument): the usage line `/meter [context|cost]`.

**Formatting:**
- Tokens exactly like Pi's footer (`formatTokens` in `footer.js`): `850`, `1.4k`, `28k`, `249k`, `1.0M`.
- Cost: `$` with 3 decimals below $1, 2 decimals from $1.

### Cost sum

The same rules as Pi's footer (`dist/modes/interactive/components/footer.js` → `getSessionStats`), over **all** entries (`ctx.sessionManager.getEntries()`: money already spent, other branches included). Sum `usage.cost.total` of:
- `usage` entries
- assistant messages
- tool-result messages that carry `usage` (subagents)
- `compaction` and `branch_summary` entries with `usage`

### Events (recompute here, never per frame)

| Event | What changes |
|---|---|
| `session_start` | context and cost; reset notes |
| `agent_start` (first of a run, where `gateBaseline` is set today) | run-cost baseline |
| `message_end` (assistant) | context and cost |
| `tool_execution_end` | context (trailing estimate) and cost (subagent usage) |
| `agent_settled` | context and cost; nudge |
| `session_compact` | scene; fill unknown |
| `session_compact_failed` | note unless aborted |
| `model_select` | compaction point (settings of the newly selected model) |
| `session_tree` | context and cost |

`getEntries()` is O(n); caching by entry count, like Pi's footer, is fine.

## Implementation plan

1. **New `extensions/lib/bird-meter.ts`** (pure, no Pi imports). Suggested functions; adjust where the code reads better:
   - `compactionPoint(settings, selected: {provider, id}, window): { point, reserve, enabled }`
   - `meterOf(tokens: number | null, point): { fill?: number; level: "ok" | "warn" | "hot" }`
   - `gaugeCells(fill?: number): string[]`: 5 rows × 2 characters plus colors, hole overlay included or as a separate step.
   - `sessionCost(entries)`, `crossings(before?, after?, noted)`
   - `compactNudge(outcome, fill?)`
   - `formatTokens`, `formatCost`, `meterReport(kind: "both" | "context" | "cost", …)`
2. **`extensions/lib/bird-perch.ts`:**
   - `perch(…)` takes an optional meter view (fill, level, note with its start time, scene with its start time, run cost, nudge).
   - Without one it draws exactly as today, so the existing tests keep passing unchanged.
   - Draw the trunk from the gauge cells, extend `bubbleFor` with the new texts and priority, add the scene's chips.
   - `perchInterval` speeds up to the chip rate while a scene runs.
3. **`extensions/lib/bird.ts`:** `footer(…)` appends the `ctx N%` part (optional parameter).
4. **`extensions/bird.ts`:**
   - Keep the meter state next to `state`/`clock`: last view, run-cost baseline, noted crossings, note and scene timestamps.
   - Wire the events above, and `refresh()` the perch when the meter changes.
   - `pi.registerCommand("meter", …)`: works with `/bird off`; in non-UI modes it does nothing.
   - Update the header comment, including "It only reads: …".
5. **Docs:**
   - `docs/tasks/bird-deluxe.md`: add a level `L1b, the meter` (short spec + decisions), and extend the "The bird still only reads" bullet.
   - `docs/RUNBOOK.md` "Entschieden": rows dated 24.11.2026 in German, in the style of the existing "Specht: …" rows. Drafts:
     - `Specht: Meter`: Der Stamm zeigt den Kontext bis zur Kompaktierung, nicht das ganze Fenster: 10 Felder von unten, ab 70 % gelb, ab 90 % rot. Bei nest kompaktiert Pi bei Fenster minus 800k Reserve, also bei rund 249k Tokens.
     - `Specht: /meter`: Eigener Befehl, nicht unter `/bird`: `/meter` zeigt Kontext und Kosten, `/meter context` und `/meter cost` je eins. Funktioniert auch bei `/bird off`.
     - `Specht: Budget`: Vorerst kein Budget, nur Zahlen. Ein Tagesbudget frühestens mit den Statistiken aus L4.
     - `Specht: /compact-Hinweis`: Nach grünem Gate ab 70 % schlägt die Sprechblase `/compact` vor.
     - `Specht: Fußzeile`: `ctx N%` ab 50 %, bezogen auf die Kompaktierung.
     - `Specht: was er liest`: Zusätzlich Kontextnutzung, Kosten aus den Session-Einträgen und die wirksamen Kompaktierungs-Einstellungen. Er schreibt weiterhin nichts und ruft kein Modell auf.
   - `docs/SETUP.md`: the bird's table row mentions `/meter`.
   - `README.md` layout: the `bird.ts` line mentions the meter, plus a line for `lib/bird-meter.ts`.

## Tests

New `test/bird-meter.test.ts`, plus additions to the existing tests:

- **Compaction point:** override hit, fallback to `reserveTokens`, fallback to 16,384, `enabled: false`, reserve ≥ window. The nest values give 248,576.
- **`meterOf`:** 0, 0.69/0.70, 0.89/0.90, > 1, `null`.
- **`gaugeCells`:**
  - the filled-cell count and bottom-up order
  - colors per level
  - all free and dim when unknown
  - the hole overlay for every `holeFor` stage (`##`, `.#`, `o#`, `O#`, `()`)
- **Crossings:** fire once going up, not again while above, again after dropping below.
- **Cost:** a fixture with every entry type sums like Pi's footer; tool results without `usage` count 0; run cost = difference.
- **Bubbles:**
  - the priority while running
  - every result text with and without cost, nudge and tally
  - the nudge only for green with a known fill ≥ 70%
  - the strong-model text with cost
  - the compaction scene (texts and chips deterministic)
- **Footer:** nothing below 50%, colors at 50/70/90, unknown → nothing, no double spaces.
- **`/meter` texts:** both, context, cost, between runs, unknown, compaction off, the guard, the usage line.
- **Existing rules still hold** with a meter view: every perch line printable ASCII and never wider than the width (widths 0–200, many fills and times); always `PERCH_HEIGHT` rows.

## Verification

```bash
npm ci && npm run check && PI_BIN=node_modules/.bin/pi npm run e2e
```

```fish
npm ci; and npm run check; and env PI_BIN=node_modules/.bin/pi npm run e2e
```

**Then look at the real TUI.** Run Pi interactively in `tmux` against the e2e mock (`test/e2e/mock-openrouter.ts`, `MockOpenRouter`), from a scratch script **outside** the repository:
- Use a throwaway agent dir built like `makeAgentDir` in `test/e2e/run.ts`, with the mock's base URL in `models.json` and `--approve`.
- Capture the screen with `tmux capture-pane -p` (and `-e` for colors) every ~150 ms.
- The mock reports a fixed small usage per answer, so to reach 70%, 90% and a real compaction, **shrink the compaction point in the scratch agent's `settings.json`**: e.g. `compaction.modelOverrides["router/escalate"].reserveTokens` = 1,048,576 − 3,000. Then a few reads of a larger file cross the lines and trigger a compaction (the mock must also answer the summary request).
- If exact token levels are needed, an optional `usage` field on the mock's `Reply` is an acceptable test-only change.

**Check on screen:**
- the trunk filling
- the 70% and 90% notes
- the compaction scene and the unknown state afterwards
- the nudge after green
- `ctx N%` in the footer
- `/meter`, `/meter context`, `/meter cost`, also after `/bird off`

## PR

- **Title:** `feat: context and cost meter on the woodpecker's trunk`
- **Description,** as in the earlier bird PRs:
  - what changed
  - the checks, with commands (usual form and fish) and results
  - the TUI check and what it showed
  - what was not tested (e.g. macOS / Apple Terminal itself)
  - what stays open
- **Note for David:** after the merge, `scripts/build-image.sh`, otherwise `pi-run.sh` refuses the stale image. In the container the bird does nothing.

## Out of scope

Budgets (session or daily), cost on the trunk, reading session files, L2–L4 of `bird-deluxe.md`, any sound.
