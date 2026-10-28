---
description: review-chain step 2 (planner); run the chain with /prompt-workflow review-chain <task>
subagent: planner
fresh: true
---
Task: $@

Context from the scout:

{previous}

Verify this context against the code and write a small, test-first implementation plan for the worker. Do not edit files.
