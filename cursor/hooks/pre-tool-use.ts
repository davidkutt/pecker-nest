/**
 * preToolUse (failClosed) on Shell, Read, Grep and the write tools (cursor/lib/permission.ts); a write
 * or command in a repository the turn does not know joins the gate (cursor/lib/gate.ts).
 */
import { joinTurn } from "../lib/gate.ts";
import { preToolUse } from "../lib/permission.ts";
import { runHook } from "../lib/run.ts";

runHook("permission", "preToolUse", (payload, context) => joinTurn(preToolUse(payload, context), payload, context));
