---
description: Saved chain scout → planner → worker → reviewer. Best started with /prompt-workflow review-chain <task>
argument-hint: "<task>"
chain: chain-scout -> chain-plan -> chain-build -> chain-review
---
Run the saved review chain for this task with the `subagent` tool: $@

Launch one workflow (a ```js workflow block plus `subagent({ workflow: true })`) that runs these children in order, each with fresh context, and passes each output to the next:

1. `scout`: collect the context needed to plan the task.
2. `planner`: write a test-first plan from the task and the scout context.
3. `worker`: implement the plan and run the check command.
4. `reviewer`: review the resulting diff against the task, the plan and `AGENTS.md`.

Do not edit files yourself. When the chain finishes, report the reviewer's findings and merge verdict unchanged, then the worker's check result. Do not fix findings unless I ask.
