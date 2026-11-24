# Task: bird deluxe, the woodpecker over the top

From the planning chat of 24 November 2026. The woodpecker (`extensions/bird.ts`, logic in
`extensions/lib/bird.ts`) is an 8-column ASCII bird in Pi's working indicator plus one line in the footer.
It becomes a small stage: a bird on its own perch above the editor, a splash at startup, short scenes for
the gate result and a bit of personality. Every level is driven by the existing state machine (`next()`),
so the bird keeps telling the truth about what the agent does. Decisions are in the "Entschieden" table
of `docs/RUNBOOK.md` (24.11.2026).

## Decisions

- **ASCII only, everywhere.** Every frame, the perch, the splash and the scenes use printable ASCII
  (`0x20`–`0x7e`): no Unicode blocks, braille or emoji. Colour comes from Pi's theme tokens only.
- **Target terminal: Apple Terminal** with fish. It has no inline image protocol (Kitty, iTerm2), so a
  pixel image of the bird is out. Theme tokens let Pi map the colours to what the terminal supports.
- **The perch sits above the editor and is always visible**, also between runs.
- **No sound.**
- **The bird still only reads:** Pi's events, the model of each answer and the gate's session entries;
  since L1b also the context usage, the cost in the session entries and the effective compaction
  settings. It writes no session entry and no file and calls no model. Speech bubbles are fixed templates
  with counts and money, never file names, prompts or output.
- **No new dependencies.** Sprites, wordmark and scenes are written by hand.
- **Logic stays pure** in `extensions/lib/` with unit tests; `bird.ts` only translates Pi's events and
  hands lines to Pi.

## Levels

One pull request each, in this order.

1. **L1, the perch** (this pull request), details below.
2. **L2, the splash.** `ctx.ui.setHeader` at startup: a hand-lettered `PECKER NEST` wordmark in ASCII,
   coloured in steps of theme tokens; the bird flies in and lands on the last letter. Below it the router
   models, the last gate result and the number of checkpoints.
3. **L3, gate scenes and title.** Short overlays (`ctx.ui.custom` with `overlay: true`, experimental in
   Pi): green, the bird flies a lap over the top in a shower of chips; red, it bonks the trunk, stars
   circle, it slides down; stopped, it ducks into its hole. About two seconds, skippable, never takes the
   keyboard from the editor. The terminal title follows the bird (`(o> pecking - nest`).
4. **L4, personality.** Seasonal looks (hat from 1 December, fireworks on New Year's Eve), a nightcap
   after 23:00, a streak of green gates, `/bird pet` and `/bird feed`, and `/bird stats`, a tall trunk
   drawn from Pi's session files with the session report's logic (read only).

Dropped by the decisions above: half-block pixel art, braille particles, inline images, sound.

**L1b, the meter,** came in between, from the planning chat of 24 November 2026: the trunk shows how
close the session is to auto-compaction. Details below; the full brief is
[bird-meter.md](bird-meter.md).

## L1: the perch

A widget above the editor (`ctx.ui.setWidget` with a component, `placement: "aboveEditor"`), five rows
high, only in Pi's interactive mode (`ctx.mode === "tui"`). The working indicator and the footer stay as
they are.

```
    ,^.   |##|      .----------------------------------------.
   ( ^ >  |o#|      < gate green in 41s. pecked 3, drummed 1 )
   /)  )  |##|      `----------------------------------------'
  /_/ /   |##|
   `-`    |##|
```

- **Poses from the run's activity**, like the indicator: thinking blinks, reading looks around (head turns
  away and back), editing pecks (wind-up, strike, recoil), bash drums, the gate's check listens with the
  beak on the trunk. A repair round drums faster in yellow; the strong model turns the bird red. The crest
  is always red.
- **The hole:** every edit in a run deepens a hole in the trunk at beak height (`.` `o` `O` `()`); it
  stays until the next run starts.
- **Chips:** each strike throws one or two chips off the trunk that fly and fall. Chips are a pure
  function of time and a seed, so tests get the same frames every time.
- **Speech bubble** to the right of the trunk, with counts only: thinking dots or the strong model's name,
  `looking around x4`, `tap tap - peck 3`, `drrrr - drum 2`, `listening to the gate...`,
  `repair 1/2 - hold on`, and after the run the result with the tally (`gate green in 41s. pecked 3,
  drummed 5`, `gate red. ouch.`, `stopped. I'll wait here.`, `done.`). Before the first run:
  `ready when you are`. The bubble is cut to the width, and left out when there is no room.
- **Idle:** between runs it blinks now and then; after five minutes without a run or a keystroke it falls
  asleep (`z` `Z` rising, no bubble). A keystroke wakes it, and while you type it looks out at you. It
  only watches the input and never consumes it.
- **Narrow terminals:** below 18 columns the perch draws nothing; it never draws a line wider than the
  terminal.
- **Its own clock:** the widget redraws only when its lines change, at the pose's frame rate while a run
  is going and a few times a second when idle; the timer stops when the widget is disposed and never
  keeps Pi alive.
- **Controls:** `/bird on` (indicator, footer and perch), `/bird minimal` (indicator and footer, the bird
  as it was), `/bird off`. `PI_NEST_BIRD=minimal` or `PI_NEST_BIRD=off` starts Pi that way.

Tests: every perch line is printable ASCII and never wider than the given width (widths 0 to 200, every
pose, many points in time); the perch is always five rows when it draws; poses, hole stages, chips,
bubble texts, sleep, waking and the watch pose; the run's tally in `next()`; the clock that tells the
perch when a pose started and when the bird went idle.

## L1b: the meter

nest reserves 800k tokens for compaction (`compaction.modelOverrides` in `agent/settings.json`), so Pi
1.5.0 compacts at the routed model's window minus that reserve: 248,576 tokens, about 24% of the
1,048,576-token window. Pi's footer counts against the whole window and turns yellow only at 70% of it,
which a nest session never reaches. The meter counts against the compaction point.

Decisions (24.11.2026, rows "Specht: Meter" to "Specht: was er liest" in `docs/RUNBOOK.md`):

- **The trunk shows the context until compaction**, not the window and not the cost: ten cells filled
  bottom-up with `#` (theme colour `accent`, `warning` from 70%, `error` from 90%), free cells a dim `:`,
  all free while the context is unknown right after a compaction. The run's hole lies over the cells.
- **`/meter`** is its own command, not part of `/bird`: `/meter` prints context and cost, `/meter context`
  and `/meter cost` one of them. It works with `/bird off`.
- **No budget for now**, numbers only. A daily budget comes with L4's stats at the earliest.
- **The `/compact` nudge:** after a green gate with the trunk at 70% or more, the result bubble suggests
  `/compact`.
- **Footer:** `ctx N%` from 50%, relative to the compaction point.
- **The bird reads more** (see Decisions above), and still only reads.

Bubbles: a note when the fill crosses 70% (`context 74% of 249k`) or 90% (`context 92% - compaction
soon`), for 4 s and once per crossing; the strong model's thinking with the run's cost so far; the result
with the nudge, the run's cost and the tally, in that order, so that cutting to the width drops the tally
first; on a compaction, 1.5 s of chips falling off every trunk row and `compacted from 241k`;
`compaction failed` when one fails.

Pi hands `message_end` and `tool_execution_end` to extensions before it stores the message, so the meter
reads when a tool starts (the answer that called it is stored) and at `turn_end` (Pi has stored the
answer and its tool results), not at those two events as first planned; see `docs/v1-notes.md`.

Tests: the compaction point with Pi's fallback order, fill levels, gauge cells and the hole over them,
crossings, the cost sum against every entry type Pi's footer counts, the `/meter` texts, the bubbles
with their priority and cut, the compaction scene, the footer part; and every perch line printable ASCII
and never wider than the terminal with a meter view, too.
