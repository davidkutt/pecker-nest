# nest field note: <repo> · <YYYY-MM-DD> · <task>

## Session

<!-- The note is open while "Start HEAD → end HEAD" has no end HEAD. /nest-handoff fills it in and closes the note. A session that runs over several days keeps one note. -->

- Repository / branch:
- Start HEAD → end HEAD:
- Task or brief:
- Start → end (active minutes):
- Days: <!-- one entry per day of the session: date, HEAD at the start of that day -->
- Config under test: <!-- output of `node ~/dev/pecker-nest/scripts/field-note.ts config --repo <repo>`, not typed by hand: pecker-nest commit, Pi version, thinking level per tier and role, strong model -->
- Compared with the previous note: <!-- second line of the same output: same pecker-nest commit, or differs -->
- Strong model in the session: <!-- /nest-handoff: from the session report's Router section (GLM 5.3 unless `/strong kimi`) -->
- Repository setup: gate.json / protect.json present; project trusted

## Outcome

| Acceptance check | Status | Evidence |
| --- | --- | --- |
|  |  |  |

- Check command and result:
- Diff: files, +/− lines, commits:

## Metrics

<!-- output of scripts/session-report.ts --since <start of the note> -->

## Defects that passed the gate and the review

<!-- What nest shipped: problems in the final diff that its own quality gate and review let through. One row each, with path:line. Interventions (below) measure how much help nest needed; this measures what it delivered. -->

| Kind | Where | What | Why the gate or review missed it |
| --- | --- | --- | --- |
|  |  |  |  |

Total: bugs · weakened tests · rule breaks

## What nest did well and badly

- 

## Model comparison

<!-- only when the session compared GLM 5.3 and Kimi K3.1 Pro (RUNBOOK M5); costs from the session report, per model -->

| Step | GLM 5.3 result | Kimi K3.1 Pro result | Cost GLM | Cost Kimi | Verdict |
| --- | --- | --- | ---: | ---: | --- |
|  |  |  |  |  |  |

Overall:

## Interventions

| Time | What | Why (what nest failed at) | Size | Category |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

Total (without `admin`):

## Harness findings

| Finding | Evidence | Proposal | Bucket | Metric that shows it worked |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Product notes

<!-- for the product's own planning chat or pull request, not for the harness -->

## For the planning chat

<!-- at most 40 lines: outcome, key numbers, three most important findings, open questions.
Key numbers always include these two lines:
Defects that passed gate and review: <n> bugs, <n> weakened tests, <n> rule breaks
Escalation outcome: <the "Outcome of the switches" lines of the session report, e.g. gate, GLM 5.3: 3 switches, 2 green, 1 handed back; 14 strong-model requests, $0.42> -->
