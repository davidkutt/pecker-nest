/** beforeReadFile (failClosed): reads of files that .pi/protect.json protects. See cursor/lib/permission.ts. */
import { beforeReadFile } from "../lib/permission.ts";
import { runHook } from "../lib/run.ts";

runHook("permission", "beforeReadFile", (payload, context) => beforeReadFile(payload, context, "beforeReadFile"));
