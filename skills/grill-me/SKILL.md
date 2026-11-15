---
name: grill-me
description: A relentless interview to sharpen a plan or design before any code is written. Started only by the user with /skill:grill-me <idea>.
disable-model-invocation: true
---

<!-- Local change in pecker-nest (10.11.2026), not in the upstream skill: the paragraph "Questions about data are questions about code". Reason: in pecker-grove session 1, four answers about prefill and file formats had to be corrected afterwards, because the details only show in the data models and loaders. The other local changes are listed at the end of this file. -->

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the repository or the environment, send the `scout` subagent (fresh context, read-only) to find it, or look it up yourself with read-only tools if subagents are unavailable; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the result; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

Questions about data are questions about code. Before you ask about prefill, import, export or a file format (which fields, what they are called, which types and defaults, what is optional, which encoding or layout), read the data models and the loaders, parsers and writers the feature feeds or is fed by: send `scout`, or read them yourself. Then ask from what the code requires. Name the model or loader and the field in the question, say what it accepts today, and put only the decision that is left to the user. Do not offer a format the existing code cannot read as if it were a free choice; if the idea needs one, say what would have to change and ask whether that is wanted. If the feature feeds nothing that exists yet, say so in the question instead of assuming a format.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding. Do not edit files during the interview; when it is done, offer to write the result to `PLAN.md` with /plan.

<!-- Adapted from the "grilling" skill in github.com/mattpocock/skills (MIT, Copyright (c) 2026 Matt Pocock; see LICENSE in this folder). Changes: one skill instead of grill-me + grilling, the scout subagent for fact finding, no edits during the interview, and (10.11.2026) reading data models and loaders before asking about prefill, export or file formats. -->
