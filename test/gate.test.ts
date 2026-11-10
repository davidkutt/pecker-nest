import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { isDocsOnly, loadGateConfig, outputExcerpt } from "../extensions/lib/gate-config.ts";
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

describe("outputExcerpt", () => {
	const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");

	it("keeps short output unchanged", () => {
		assert.equal(outputExcerpt("a\nb\n"), "a\nb");
		assert.equal(outputExcerpt(numbered(80)), numbered(80), "exactly the line budget is not shortened");
		assert.equal(outputExcerpt(""), "");
	});

	it("keeps the first 30 and the last 50 lines of long output, with a marker in between", () => {
		const lines = outputExcerpt(numbered(200)).split("\n");
		assert.equal(lines.length, 81);
		assert.deepEqual(lines.slice(0, 30), numbered(30).split("\n"), "the first failures stay");
		assert.equal(lines[30], "…(120 lines omitted)…");
		assert.equal(lines[31], "line 150");
		assert.equal(lines.at(-1), "line 199", "the summary at the end stays");
	});

	it("keeps the lint errors of a lint, types, tests check whose test output is long", () => {
		const output = ["src/a.ts:3:1 error no-unused-vars", "src/b.ts:9:5 error prefer-const", ...Array.from({ length: 300 }, (_, i) => `  test ${i} … ok`), "1 failed, 299 passed"].join("\n");
		const excerpt = outputExcerpt(output);
		assert.match(excerpt, /^src\/a\.ts:3:1 error no-unused-vars\nsrc\/b\.ts:9:5 error prefer-const\n/);
		assert.match(excerpt, /\n1 failed, 299 passed$/);
		assert.match(excerpt, /…\(223 lines omitted\)…/);
	});

	it("splits a custom line budget 3 to 5", () => {
		assert.equal(outputExcerpt(numbered(200), 8), ["line 0", "line 1", "line 2", "…(192 lines omitted)…", "line 195", "line 196", "line 197", "line 198", "line 199"].join("\n"));
		const tiny = outputExcerpt(numbered(200), 3);
		assert.equal(tiny, ["line 0", "…(197 lines omitted)…", "line 198", "line 199"].join("\n"));
		assert.equal(outputExcerpt(numbered(10), 1), ["…(9 lines omitted)…", "line 9"].join("\n"), "one line of budget goes to the tail");
	});

	it("stays within the character budget and keeps both outer edges", () => {
		// Few lines, but far too many characters: minified output, a long stack frame.
		const long = `START${"x".repeat(20_000)}END`;
		const one = outputExcerpt(long, 80, 8000);
		assert.ok(one.startsWith("START") && one.endsWith("END"));
		assert.match(one, /\n…\(output shortened here\)…\n/);
		assert.ok(one.length <= 8000 + "\n…(output shortened here)…\n".length);

		// Many long lines: the line cut alone would still be over budget.
		const wide = Array.from({ length: 200 }, (_, i) => `${i}:${"y".repeat(500)}`).join("\n");
		const excerpt = outputExcerpt(wide, 80, 8000);
		assert.ok(excerpt.startsWith("0:yyy"), "the head keeps its beginning");
		assert.ok(excerpt.endsWith("y".repeat(100)) && excerpt.includes("\n199:"), "the tail keeps its end");
		const [head, tail] = excerpt.split("\n…(output shortened here)…\n");
		assert.equal(head.length, 3000, "3/8 of the budget");
		assert.equal(tail.length, 5000, "5/8 of the budget");
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
