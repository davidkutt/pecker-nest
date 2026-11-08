import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createCheckpoint, KEEP, listCheckpoints, repoRoot, restoreCheckpoint } from "../extensions/lib/checkpoint.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
	return execFileSync("git", args, { cwd, encoding: "utf-8" });
}

function repo(commit = true): string {
	const dir = mkdtempSync(join(tmpdir(), "nest-cp-"));
	dirs.push(dir);
	git(dir, "init", "-q");
	writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(dir, "a.txt"), "one\n");
	if (commit) {
		git(dir, "add", "-A");
		git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
	}
	return dir;
}

describe("checkpoints", () => {
	it("are undefined outside git", () => {
		const dir = mkdtempSync(join(tmpdir(), "nest-cp-plain-"));
		dirs.push(dir);
		assert.equal(repoRoot(dir), undefined);
		assert.equal(createCheckpoint(dir, "x"), undefined);
		assert.deepEqual(listCheckpoints(dir), []);
	});

	it("save and restore changed, deleted and new files without touching index or ignored files", () => {
		const dir = repo();
		writeFileSync(join(dir, "draft.txt"), "untracked before\n");
		git(dir, "add", "draft.txt");
		const statusBefore = git(dir, "status", "--porcelain");
		const checkpoint = createCheckpoint(dir, "add a parser\nwith tests")!;
		assert.equal(checkpoint.label, "add a parser with tests");
		assert.equal(git(dir, "status", "--porcelain"), statusBefore, "the index is untouched");
		assert.equal(git(dir, "stash", "list"), "", "the stash is untouched");

		writeFileSync(join(dir, "a.txt"), "changed by the agent\n");
		rmSync(join(dir, "draft.txt"));
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src/new.ts"), "export {}\n");
		writeFileSync(join(dir, "ignored.txt"), "keep me\n");

		const result = restoreCheckpoint(dir, checkpoint.commit);
		assert.equal(readFileSync(join(dir, "a.txt"), "utf-8"), "one\n");
		assert.equal(readFileSync(join(dir, "draft.txt"), "utf-8"), "untracked before\n");
		assert.ok(!existsSync(join(dir, "src/new.ts")));
		assert.deepEqual(result.deleted, ["src/new.ts"]);
		assert.equal(readFileSync(join(dir, "ignored.txt"), "utf-8"), "keep me\n", "ignored files stay");
	});

	it("reuse the latest checkpoint when nothing changed", () => {
		const dir = repo();
		const first = createCheckpoint(dir, "one", 1000)!;
		const second = createCheckpoint(dir, "two", 2000)!;
		assert.equal(second.ref, first.ref);
		writeFileSync(join(dir, "a.txt"), "two\n");
		const third = createCheckpoint(dir, "three", 3000)!;
		assert.notEqual(third.ref, first.ref);
		assert.deepEqual(listCheckpoints(dir).map((checkpoint) => checkpoint.label), ["three", "one"]);
	});

	it("work in a repository without commits", () => {
		const dir = repo(false);
		const checkpoint = createCheckpoint(dir, "first")!;
		writeFileSync(join(dir, "b.txt"), "new\n");
		restoreCheckpoint(dir, checkpoint.commit);
		assert.ok(!existsSync(join(dir, "b.txt")));
		assert.equal(readFileSync(join(dir, "a.txt"), "utf-8"), "one\n");
	});

	it(`keep the newest ${KEEP}`, () => {
		const dir = repo();
		for (let i = 0; i < KEEP + 3; i++) {
			writeFileSync(join(dir, "a.txt"), `${i}\n`);
			createCheckpoint(dir, `step ${i}`, 10_000 + i);
		}
		const kept = listCheckpoints(dir);
		assert.equal(kept.length, KEEP);
		assert.equal(kept[0].label, `step ${KEEP + 2}`);
	});
});
