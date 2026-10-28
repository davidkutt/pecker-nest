---
description: review-chain step 4 (reviewer); run the chain with /prompt-workflow review-chain <task>
subagent: reviewer
fresh: true
---
Task: $@

Worker report:

{previous}

Review the current diff against the task, AGENTS.md, the knowledge base and test coverage. Report findings with evidence and a merge verdict. Do not change any file.
