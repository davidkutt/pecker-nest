/**
 * Checkpoints: before every prompt you type, the working tree is saved as a git checkpoint
 * (lib/checkpoint.ts), so you can undo whatever the agent did since.
 *
 * - `/rewind` lists the latest checkpoints and restores the one you pick. It saves the current
 *   state first, so a rewind can itself be rewound.
 * - `/checkpoints` lists them.
 * - Only in git repositories; the last 30 are kept under `refs/nest/checkpoints/`.
 * - PI_NEST_CHECKPOINT=off turns it off for a process.
 *
 * Checkpoints never touch your index, branch or stash, and never include ignored files.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Checkpoint, createCheckpoint, listCheckpoints, restoreCheckpoint } from "./lib/checkpoint.ts";

const CUSTOM_TYPE = "nest-checkpoint";

function describe(checkpoint: Checkpoint): string {
	const time = new Date(checkpoint.time).toLocaleString();
	return `${time}  ${checkpoint.label}`;
}

export default function (pi: ExtensionAPI) {
	const enabled = process.env.PI_NEST_CHECKPOINT !== "off";
	let warned = false;

	function save(ctx: ExtensionContext, label: string): Checkpoint | undefined {
		try {
			return createCheckpoint(ctx.cwd, label);
		} catch (error) {
			if (!warned) {
				warned = true;
				const message = `checkpoint failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else process.stderr.write(`[checkpoint] ${message}\n`);
			}
			return undefined;
		}
	}

	pi.on("before_agent_start", (event, ctx) => {
		if (!enabled || event.messageType !== "user") return undefined;
		const checkpoint = save(ctx, event.prompt);
		if (checkpoint) pi.appendEntry(CUSTOM_TYPE, { ref: checkpoint.ref, commit: checkpoint.commit });
		return undefined;
	});

	pi.registerCommand("checkpoints", {
		description: "List the working-tree checkpoints taken before your prompts",
		handler: async (_args, ctx) => {
			const checkpoints = listCheckpoints(ctx.cwd);
			ctx.ui.notify(checkpoints.length ? checkpoints.slice(0, 10).map(describe).join("\n") : "No checkpoints in this repository yet.", "info");
		},
	});

	pi.registerCommand("rewind", {
		description: "Restore the working tree to a checkpoint taken before one of your prompts",
		handler: async (_args, ctx) => {
			const checkpoints = listCheckpoints(ctx.cwd).slice(0, 10);
			if (!checkpoints.length) {
				ctx.ui.notify("No checkpoints in this repository yet.", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`/rewind needs the interactive UI. Checkpoints:\n${checkpoints.map(describe).join("\n")}`, "info");
				return;
			}
			const options = checkpoints.map(describe);
			const choice = await ctx.ui.select("Restore the working tree to the state before:", options);
			const target = checkpoints[options.indexOf(choice ?? "")];
			if (!target) return;
			const confirmed = await ctx.ui.confirm(
				"Restore checkpoint?",
				"Changed files come back, files created since are deleted. Ignored files stay. The current state is saved first.",
			);
			if (!confirmed) return;
			save(ctx, "before /rewind");
			try {
				const result = restoreCheckpoint(ctx.cwd, target.commit);
				ctx.ui.notify(`Restored ${describe(target)}; deleted ${result.deleted.length} file(s) created since.`, "info");
			} catch (error) {
				ctx.ui.notify(`Rewind failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
