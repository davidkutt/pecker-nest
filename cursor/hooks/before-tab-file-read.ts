/** beforeTabFileRead: keeps read-protected files away from Tab. Not failClosed. See cursor/lib/permission.ts. */
import { beforeReadFile } from "../lib/permission.ts";
import { runHook } from "../lib/run.ts";

runHook("permission-tab", "beforeTabFileRead", (payload, context) => beforeReadFile(payload, context, "beforeTabFileRead"));
