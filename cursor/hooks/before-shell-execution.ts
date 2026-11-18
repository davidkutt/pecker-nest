/**
 * beforeShellExecution (failClosed): the command against the safety rules (cursor/lib/permission.ts);
 * a command with its own cwd in a repository the turn does not know joins the gate (cursor/lib/gate.ts).
 */
import { joinTurn } from "../lib/gate.ts";
import { beforeShellExecution } from "../lib/permission.ts";
import { runHook } from "../lib/run.ts";

runHook("permission", "beforeShellExecution", (payload, context) => joinTurn(beforeShellExecution(payload, context), payload, context));
