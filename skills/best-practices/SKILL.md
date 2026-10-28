---
name: best-practices
description: Query the knowledge base (kb MCP server) for project conventions, architecture decisions, API usage and coding best practices. Use before answering questions about how things should be done here, before planning a change, and before reviewing code.
---

# Knowledge base usage

The knowledge base is the `kb` MCP server. Its search tool is exposed directly as `mcp__kb__<search tool>`; check the tool list for the exact name.

## When to query

- The user asks how something should be done, which pattern or library to use, or why the code is shaped a certain way.
- Before writing `PLAN.md`: look up conventions for the area you are changing.
- Before a review: look up the rules the diff should follow.
- When `AGENTS.md` refers to a document or decision you have not seen.

Skip it for questions the open files already answer completely, and for pure mechanics (running a command, renaming a variable).

## How to query

1. Search with the domain words of the task, not the whole user prompt: `"error handling http client"`, not `"how do I fix the bug in orders"`.
2. If the first search returns nothing useful, rephrase once with synonyms or the module name. Stop after two empty searches and say the knowledge base has nothing on it.
3. Read the top results, prefer the most specific and most recent document when they disagree, and note conflicts.

## How to use results

- Name the source (document title or path the tool returns) for every convention you apply.
- Repository code and `AGENTS.md` win over the knowledge base when they conflict; point out the conflict.
- Do not copy large passages into files; link or cite them.

## When the server is down

If `mcp__kb__*` calls fail or the tools are missing, say once that the knowledge base is unavailable, then continue from the repository alone. Do not retry in a loop.
