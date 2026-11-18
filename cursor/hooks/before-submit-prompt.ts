/** beforeSubmitPrompt: records the turn's starting point for the quality gate. See cursor/lib/gate.ts. */
import { startTurn } from "../lib/gate.ts";
import { runHook } from "../lib/run.ts";

runHook("prompt", "beforeSubmitPrompt", startTurn);
