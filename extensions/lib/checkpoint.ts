import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Git checkpoints of the whole working tree, taken without touching your index, branch or stash:
 * files go into a temporary index, become a commit object, and a ref under
 * `refs/nest/checkpoints/` keeps it. Tracked and untracked files count; ignored files
 * (node_modules, .env) are neither saved nor ever deleted by a restore.
 */

export const REF_PREFIX = "refs/nest/checkpoints/";
export const KEEP = 30;

const IDENTITY = {
	GIT_AUTHOR_NAME: "pecker-nest",
	GIT_AUTHOR_EMAIL: "nest@localhost",
	GIT_COMMITTER_NAME: "pecker-nest",
	GIT_COMMITTER_EMAIL: "nest@localhost",
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 64 * 1024 * 1024,
	});
}

/** The repository's top level, or undefined outside a git work tree. */
export function repoRoot(cwd: string): string | undefined {
	try {
		return git(cwd, ["rev-parse", "--show-toplevel"]).trim() || undefined;
	} catch {
		return undefined;
	}
}

function headCommit(root: string): string | undefined {
	try {
		return git(root, ["rev-parse", "--verify", "-q", "HEAD"]).trim() || undefined;
	} catch {
		return undefined;
	}
}

export interface Checkpoint {
	ref: string;
	commit: string;
	/** Milliseconds since the epoch, from the ref name. */
	time: number;
	label: string;
}

export function listCheckpoints(cwd: string): Checkpoint[] {
	const root = repoRoot(cwd);
	if (!root) return [];
	const out = git(root, ["for-each-ref", "--sort=-refname", "--format=%(refname)%00%(objectname)%00%(contents:subject)", REF_PREFIX]);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [ref, commit, subject] = line.split("\0");
			return { ref, commit, time: Number(ref.slice(REF_PREFIX.length)), label: subject.replace(/^nest checkpoint: /, "") };
		})
		.filter((checkpoint) => Number.isFinite(checkpoint.time));
}

/**
 * Saves the working tree as a checkpoint. Returns the newest existing checkpoint instead when
 * nothing changed since it, and undefined outside a git repository.
 */
export function createCheckpoint(cwd: string, label: string, now = Date.now()): Checkpoint | undefined {
	const root = repoRoot(cwd);
	if (!root) return undefined;
	const scratch = mkdtempSync(join(tmpdir(), "nest-checkpoint-"));
	const index = { GIT_INDEX_FILE: join(scratch, "index") };
	try {
		const head = headCommit(root);
		if (head) git(root, ["read-tree", head], index);
		git(root, ["add", "-A", "--", "."], index);
		const tree = git(root, ["write-tree"], index).trim();
		const latest = listCheckpoints(root)[0];
		if (latest && git(root, ["rev-parse", `${latest.commit}^{tree}`]).trim() === tree) return latest;
		const subject = `nest checkpoint: ${label.replace(/\s+/g, " ").trim().slice(0, 72) || "(no label)"}`;
		const commit = git(root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", subject], IDENTITY).trim();
		let time = now;
		while (listCheckpoints(root).some((checkpoint) => checkpoint.time === time)) time++;
		const ref = `${REF_PREFIX}${time}`;
		git(root, ["update-ref", ref, commit]);
		for (const old of listCheckpoints(root).slice(KEEP)) git(root, ["update-ref", "-d", old.ref]);
		return { ref, commit, time, label: subject.replace(/^nest checkpoint: /, "") };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Puts the working tree back to `commit`: changed and deleted files come back, files created
 * since are deleted. Ignored files are left alone; the index and branch are not touched.
 */
export function restoreCheckpoint(cwd: string, commit: string): { restored: number; deleted: string[] } {
	const root = repoRoot(cwd);
	if (!root) throw new Error("not a git repository");
	const saved = new Set(git(root, ["ls-tree", "-r", "-z", "--name-only", commit]).split("\0").filter(Boolean));
	const present = git(root, ["ls-files", "-z", "-c", "-o", "--exclude-standard"]).split("\0").filter(Boolean);
	git(root, ["restore", `--source=${commit}`, "--worktree", "--", "."]);
	const deleted: string[] = [];
	for (const file of new Set(present)) {
		if (saved.has(file)) continue;
		try {
			unlinkSync(join(root, file));
			deleted.push(file);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			deleted.push(file);
		}
	}
	return { restored: saved.size, deleted: deleted.sort() };
}
