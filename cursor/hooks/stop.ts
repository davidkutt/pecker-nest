/** stop: the quality gate and its repair rounds. See cursor/lib/gate.ts. */
import { stopTurn } from "../lib/gate.ts";
import { runHook } from "../lib/run.ts";

runHook("stop", "stop", (payload, context) => stopTurn(payload, context));
