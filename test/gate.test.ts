import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isDocsOnly, loadGateConfig, outputTail } from "../extensions/lib/gate-config.ts";
import { changedPaths, parsePorcelainZ, snapshotKey, takeSnapshot } from "../extensions/lib/worktree.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "nest-gate-"));
	dirs.push(dir);
	return dir;
}
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("loadGateConfig", () => {
	it("returns undefined without .pi/gate.json", () => {
		assert.equal(loadGateConfig(tempDir()), undefined);
	});
	it("applies defaults", () => {
		const dir = tempDir();
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi/gate.json"), JSON.stringify({ command: " pnpm run check " }));
		assert.deepEqual(loadGateConfig(dir), { command: "pnpm run check", maxRepairRounds: 2, timeoutSeconds: 600 });
	});
	it("rejects a missing command and bad numbers", () => {
		const dir = tempDir();
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi/gate.json"), JSON.stringify({ maxRepairRounds: 1 }));
		assert.throws(() => loadGateConfig(dir), /command/);
		writeFileSync(join(dir, ".pi/gate.json"), JSON.stringify({ command: "x", maxRepairRounds: -1 }));
		assert.throws(() => loadGateConfig(dir), /maxRepairRounds/);
		writeFileSync(join(dir, ".pi/gate.json"), "{");
		assert.throws(() => loadGateConfig(dir), /valid JSON/);
	});
});

describe("isDocsOnly", () => {
	it("is true only for a non-empty set of documentation files", () => {
		assert.ok(isDocsOnly(["PLAN.md", "docs/guide.rst"]));
		assert.ok(!isDocsOnly(["requirements.txt"]));
		assert.ok(!isDocsOnly(["PLAN.md", "src/a.ts"]));
		assert.ok(!isDocsOnly([]));
	});
});

describe("outputTail", () => {
	it("keeps short output unchanged", () => {
		assert.equal(outputTail("a\nb\n"), "a\nb");
	});
	it("keeps the last lines of long output", () => {
		const output = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		const tail = outputTail(output, 3);
		assert.match(tail, /omitted/);
		assert.match(tail, /line 199$/);
		assert.doesNotMatch(tail, /line 196\n/);
	});
});

describe("worktree snapshots", () => {
	it("parses renames without treating the source as an entry", () => {
		assert.deepEqual(parsePorcelainZ("R  new.ts\0old.ts\0?? a b.txt\0 M src/x.ts\0"), [
			{ code: "R ", path: "new.ts" },
			{ code: "??", path: "a b.txt" },
			{ code: " M", path: "src/x.ts" },
		]);
	});

	it("is undefined outside git", () => {
		assert.equal(takeSnapshot(tempDir()), undefined);
	});

	it("detects content changes in files that were already dirty", () => {
		const dir = tempDir();
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
		git("init", "-q");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
		writeFileSync(join(dir, "a.ts"), "1");
		const before = takeSnapshot(dir)!;
		assert.deepEqual(changedPaths(before, takeSnapshot(dir)!), []);

		writeFileSync(join(dir, "a.ts"), "2");
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub/b.ts"), "new");
		const afterEdit = takeSnapshot(dir)!;
		assert.deepEqual(changedPaths(before, afterEdit), ["a.ts", "sub/b.ts"]);
		assert.notEqual(snapshotKey(before), snapshotKey(afterEdit));

		rmSync(join(dir, "a.ts"));
		assert.deepEqual(changedPaths(before, takeSnapshot(dir)!), ["a.ts", "sub/b.ts"]);
	});
});
