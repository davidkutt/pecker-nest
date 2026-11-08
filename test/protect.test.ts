import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { existingMatches, globToRegExp, loadProtectConfig, matchingGlob, staticPrefix } from "../extensions/lib/protect-config.ts";
import {
	bashCommandReason,
	type PathPolicy,
	protectedPathReason,
	protectedReadReason,
	redactProtectedLines,
} from "../extensions/lib/safety-rules.ts";

const repo = mkdtempSync(join(tmpdir(), "nest-protect-"));
after(() => rmSync(repo, { recursive: true, force: true }));

function policy(overrides: Partial<PathPolicy> = {}): PathPolicy {
	return {
		cwd: "/work/undertext",
		write: ["evals/samples/test*.jsonl"],
		read: ["evals/samples/holdout*.jsonl"],
		readFiles: ["evals/samples/holdout.jsonl"],
		commands: [{ pattern: /--split[ =]+(test|holdout)\b/, reason: "the held-out splits run once, by David" }],
		harnessDirs: ["/home/dev/pecker-nest", "/home/dev/.pi/agent"],
		...overrides,
	};
}

describe("globToRegExp", () => {
	it("supports *, ** and ?", () => {
		assert.ok(globToRegExp("evals/samples/test*.jsonl").test("evals/samples/test.jsonl"));
		assert.ok(globToRegExp("evals/samples/test*.jsonl").test("evals/samples/test-2.jsonl"));
		assert.ok(!globToRegExp("evals/samples/test*.jsonl").test("evals/samples/sub/test.jsonl"));
		assert.ok(globToRegExp("evals/**/test.jsonl").test("evals/test.jsonl"));
		assert.ok(globToRegExp("evals/**/test.jsonl").test("evals/a/b/test.jsonl"));
		assert.ok(globToRegExp("data/v?.csv").test("data/v1.csv"));
		assert.ok(!globToRegExp("data/v?.csv").test("data/v10.csv"));
	});
	it("treats a plain path and a trailing slash as the directory and everything below", () => {
		assert.ok(globToRegExp("evals/holdout").test("evals/holdout"));
		assert.ok(globToRegExp("evals/holdout").test("evals/holdout/a.jsonl"));
		assert.ok(!globToRegExp("evals/holdout").test("evals/holdout2.jsonl"));
		assert.ok(globToRegExp("evals/holdout/").test("evals/holdout/x/y.json"));
	});
	it("escapes regex characters", () => {
		assert.ok(globToRegExp("a+b/(c).md").test("a+b/(c).md"));
		assert.ok(!globToRegExp("a.md").test("aXmd"));
	});
});

describe("staticPrefix and matchingGlob", () => {
	it("finds the directory before the first wildcard", () => {
		assert.equal(staticPrefix("evals/samples/test*.jsonl"), "evals/samples");
		assert.equal(staticPrefix("**/secret.txt"), "");
		assert.equal(staticPrefix("evals/samples/test.jsonl"), "evals/samples");
	});
	it("returns the matching glob", () => {
		assert.equal(matchingGlob("./evals/samples/test.jsonl", ["x", "evals/samples/test*.jsonl"]), "evals/samples/test*.jsonl");
		assert.equal(matchingGlob("evals/samples/dev.jsonl", ["evals/samples/test*.jsonl"]), undefined);
	});
});

describe("loadProtectConfig", () => {
	const write = (content: string) => {
		mkdirSync(join(repo, ".pi"), { recursive: true });
		writeFileSync(join(repo, ".pi/protect.json"), content);
	};
	it("is undefined without a file", () => {
		assert.equal(loadProtectConfig(join(repo, "missing")), undefined);
	});
	it("reads paths and command rules", () => {
		write(JSON.stringify({ write: ["./evals/x/"], read: ["a.txt"], commands: [{ pattern: "--split test", reason: "once" }] }));
		const config = loadProtectConfig(repo)!;
		assert.deepEqual(config.write, ["evals/x/**"]);
		assert.deepEqual(config.read, ["a.txt"]);
		assert.ok(config.commands[0].pattern.test("pnpm eval --split test"));
	});
	it("rejects invalid content", () => {
		for (const bad of ["{", "[]", '{"write":"a"}', '{"commands":[{"pattern":"("}]}', '{"commands":[{"pattern":"x"}]}', '{"writes":[]}']) {
			write(bad);
			assert.throws(() => loadProtectConfig(repo), /protect\.json/, bad);
		}
	});
});

describe("existingMatches", () => {
	it("lists existing files that match, skipping node_modules", () => {
		mkdirSync(join(repo, "evals/samples"), { recursive: true });
		mkdirSync(join(repo, "node_modules/evals/samples"), { recursive: true });
		writeFileSync(join(repo, "evals/samples/holdout.jsonl"), "{}\n");
		writeFileSync(join(repo, "evals/samples/dev.jsonl"), "{}\n");
		writeFileSync(join(repo, "node_modules/evals/samples/holdout.jsonl"), "{}\n");
		assert.deepEqual(existingMatches(repo, ["evals/samples/holdout*.jsonl"]), ["evals/samples/holdout.jsonl"]);
		assert.deepEqual(existingMatches(repo, ["**/holdout.jsonl"]), ["evals/samples/holdout.jsonl"]);
	});
});

describe("protectedPathReason with a repository policy", () => {
	it("blocks writes to write- and read-protected paths, relative or absolute", () => {
		assert.match(protectedPathReason("evals/samples/test.jsonl", policy()) ?? "", /protect\.json \(write: evals\/samples\/test\*\.jsonl\)/);
		assert.match(protectedPathReason("/work/undertext/evals/samples/test-2.jsonl", policy()) ?? "", /write:/);
		assert.match(protectedPathReason("./evals/samples/holdout.jsonl", policy()) ?? "", /read:/);
	});
	it("allows other repository files and paths outside the repository", () => {
		assert.equal(protectedPathReason("evals/samples/dev.jsonl", policy()), undefined);
		assert.equal(protectedPathReason("src/index.ts", policy()), undefined);
		assert.equal(protectedPathReason("/tmp/scratch.txt", policy()), undefined);
	});
	it("blocks the harness directories and .pi/ everywhere", () => {
		assert.match(protectedPathReason("/home/dev/pecker-nest/extensions/safety-gate.ts", policy()) ?? "", /part of the agent harness/);
		assert.match(protectedPathReason("/home/dev/.pi/agent/settings.json", policy()) ?? "", /harness/);
		assert.match(protectedPathReason(".pi/gate.json") ?? "", /inside \.pi\//);
		assert.match(protectedPathReason(".pi/protect.json", policy()) ?? "", /inside \.pi\//);
		assert.match(protectedPathReason(`~/.pi/agent/models.json`) ?? "", /inside \.pi\//);
	});
	it("expands ~ against the home directory", () => {
		const home = policy({ harnessDirs: [join(homedir(), "dev/pecker-nest")] });
		assert.match(protectedPathReason("~/dev/pecker-nest/agent/settings.json", home) ?? "", /harness/);
	});
});

describe("protectedReadReason", () => {
	it("only covers read-protected paths", () => {
		assert.match(protectedReadReason("evals/samples/holdout.jsonl", policy()) ?? "", /read: evals\/samples\/holdout\*\.jsonl/);
		assert.equal(protectedReadReason("evals/samples/test.jsonl", policy()), undefined, "write-protected files stay readable");
		assert.equal(protectedReadReason("evals", policy()), undefined);
	});
});

describe("bashCommandReason with a repository policy", () => {
	const blocked = [
		"pnpm eval --split test",
		"pnpm eval --split=holdout",
		"cd packages && pnpm eval --split test --verbose",
		"cat evals/samples/holdout.jsonl",
		"jq . < evals/samples/holdout.jsonl",
		"head -n 5 evals/samples/*.jsonl",
		"node -e \"console.log(require('fs').readFileSync('evals/samples/holdout.jsonl', 'utf8'))\"",
		"cd evals/samples && cat holdout.jsonl",
		"cp evals/samples/dev.jsonl evals/samples/test.jsonl",
		"echo '{}' >> evals/samples/test.jsonl",
		"sed -i 's/a/b/' evals/samples/test.jsonl",
		"echo x > .pi/gate.json",
		"tee /home/dev/pecker-nest/agent/settings.json < /dev/null",
	];
	for (const command of blocked) {
		it(`blocks: ${command}`, () => assert.ok(bashCommandReason(command, policy()), command));
	}
	const allowed = [
		"pnpm eval --split dev",
		"pnpm test",
		"cat evals/samples/dev.jsonl",
		"cat evals/samples/test.jsonl",
		"grep -r attacker evals/",
		"ls evals/samples",
		"cat .pi/gate.json",
	];
	for (const command of allowed) {
		it(`allows: ${command}`, () => assert.equal(bashCommandReason(command, policy()), undefined, command));
	}
	it("keeps the built-in rules without a policy", () => {
		assert.equal(bashCommandReason("pnpm eval --split test"), undefined);
		assert.ok(bashCommandReason("git push"));
	});
});

describe("redactProtectedLines", () => {
	const files = ["evals/samples/holdout.jsonl"];
	it("removes lines that mention a protected file, however the path is written", () => {
		const output = [
			"evals/samples/dev.jsonl:3:hello",
			"evals/samples/holdout.jsonl:7:secret sample",
			"samples/holdout.jsonl:8: grep relative to its search directory",
			"holdout.jsonl-9- context line",
			"./evals/samples/holdout.jsonl",
			"/work/undertext/evals/samples/holdout.jsonl:1:x",
			"src/a.ts:1:x",
		].join("\n");
		const result = redactProtectedLines(output, files);
		assert.equal(result.removed, 5);
		assert.equal(result.text, "evals/samples/dev.jsonl:3:hello\nsrc/a.ts:1:x");
	});
	it("does not match names that only contain the file name", () => {
		const output = "evals/fixtures/my-holdout.jsonl:1:x\nholdout.jsonl.bak:1:x";
		assert.equal(redactProtectedLines(output, files).removed, 0);
	});
	it("leaves output alone without protected files", () => {
		assert.deepEqual(redactProtectedLines("a\nb", []), { text: "a\nb", removed: 0 });
	});
});
