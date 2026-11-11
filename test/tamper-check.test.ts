import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { type Finding, findTampering, formatFindings, isCheckConfig, isTestFile, parseDiff, snapshotTree, tamperFindings, type TamperPattern } from "../extensions/lib/tamper-check.ts";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// The fixtures are joined from lines so that this file carries none of the markers itself.
const lines = (...text: string[]) => `${text.join("\n")}\n`;
const SKIP = [".", "skip"].join("");
const ONLY = [".", "only"].join("");
const TS_IGNORE = ["@ts", "ignore"].join("-");
const TS_EXPECT = ["@ts", "expect", "error"].join("-");
const ESLINT_OFF = ["eslint", "disable"].join("-");
const OXLINT_OFF = ["oxlint", "disable"].join("-");
const TYPE_IGNORE = ["# type:", "ignore"].join(" ");
const NOQA = ["#", "noqa"].join(" ");
const PYRIGHT_IGNORE = ["# pyright:", "ignore"].join(" ");

const TS_FILES: Record<string, string> = {
	"src/price.ts": lines("export function price(net: number): number {", "\treturn net * 1.19;", "}"),
	"src/price.test.ts": lines(
		'import { expect, it, describe } from "vitest";',
		'import { price } from "./price";',
		"",
		'describe("price", () => {',
		'\tit("adds VAT", () => {',
		"\t\texpect(price(100)).toBe(119);",
		"\t});",
		'\tit("keeps zero", () => {',
		"\t\texpect(price(0)).toBe(0);",
		"\t});",
		'\tit("rounds", () => {',
		"\t\texpect(price(1)).toBe(1.19);",
		"\t});",
		"});",
	),
	"test/api.test.ts": lines('import { test } from "node:test";', 'test("answers", () => {});'),
	"tsconfig.json": lines("{", '\t"compilerOptions": { "strict": true }', "}"),
	"eslint.config.js": lines("export default [];"),
	"vitest.config.ts": lines("export default {};"),
	"package.json": lines("{", '\t"name": "shop",', '\t"scripts": {', '\t\t"check": "tsc && eslint . && vitest run",', '\t\t"dev": "vite"', "\t},", '\t"dependencies": {}', "}"),
};

const PY_FILES: Record<string, string> = {
	"shop/price.py": lines("def price(net: float) -> float:", "    return net * 1.19"),
	"tests/test_price.py": lines(
		"import pytest",
		"from shop.price import price",
		"",
		"",
		"def test_adds_vat():",
		"    assert price(100) == 119",
		"",
		"",
		"def test_keeps_zero():",
		"    assert price(0) == 0",
		"",
		"",
		"class TestRounding:",
		"    def test_rounds(self):",
		"        assert price(1) == 1.19",
	),
	"tests/conftest.py": lines("import pytest"),
	"pyproject.toml": lines(
		"[project]",
		'name = "shop"',
		'dependencies = ["httpx"]',
		"",
		"[tool.ruff]",
		"line-length = 100",
		"",
		"[tool.ruff.lint]",
		'select = ["E", "F", "B"]',
		"",
		"[tool.pyright]",
		'typeCheckingMode = "strict"',
		"",
		"[tool.pytest.ini_options]",
		'addopts = "-q"',
		"",
		"[tool.uv]",
		"dev-dependencies = []",
	),
	"setup.cfg": lines("[metadata]", "name = shop", "", "[flake8]", "max-line-length = 100"),
};

function sh(cwd: string, ...args: string[]) {
	return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function repo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "nest-tamper-"));
	dirs.push(dir);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	sh(dir, "init", "-q");
	sh(dir, "add", "-A");
	sh(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
	return dir;
}

/** The findings for a change made after the baseline was taken, as `kind path:line` plus the detail. */
function check(files: Record<string, string>, change: (dir: string) => void, patterns: TamperPattern[] = []): Finding[] {
	const dir = repo(files);
	const base = snapshotTree(dir);
	change(dir);
	const now = snapshotTree(dir);
	assert.ok(base && now, "both states are git trees");
	return tamperFindings(dir, base, now, patterns);
}

const edit = (dir: string, path: string, change: (text: string) => string) => writeFileSync(join(dir, path), change(readFileSync(join(dir, path), "utf-8")));
const where = (findings: Finding[]) => findings.map((finding) => `${finding.kind} ${finding.path}${finding.line ? `:${finding.line}` : ""}`);

describe("weakened-test check on a TypeScript repository", () => {
	it("finds nothing in an honest change: new code, a new test, a renamed test, a new dependency and script", () => {
		const findings = check(TS_FILES, (dir) => {
			edit(dir, "src/price.ts", (text) => `${text}export const VAT = 0.19;\n`);
			edit(dir, "src/price.test.ts", (text) => text.replace('it("rounds"', 'it("rounds to cents"').replace("});\n});", '});\n\tit("has a rate", () => {});\n});'));
			edit(dir, "package.json", (text) => text.replace('"dependencies": {}', '"dependencies": { "zod": "4.0.0" }').replace('"dev": "vite"', '"dev": "vite",\n\t\t"build": "vite build"'));
			writeFileSync(join(dir, "src/tax.test.ts"), lines('import { it } from "vitest";', 'it("is new", () => {});'));
			writeFileSync(join(dir, "NOTES.md"), lines("it.skip( is fine in prose"));
		});
		assert.deepEqual(findings, []);
	});

	it("finds a deleted test file", () => {
		const findings = check(TS_FILES, (dir) => rmSync(join(dir, "test/api.test.ts")));
		assert.deepEqual(findings, [{ kind: "deleted-test", path: "test/api.test.ts", detail: "test file deleted" }]);
	});

	it("does not take a moved test file for a deleted one", () => {
		const findings = check(TS_FILES, (dir) => {
			mkdirSync(join(dir, "src/api"));
			renameSync(join(dir, "test/api.test.ts"), join(dir, "src/api/api.test.ts"));
		});
		assert.deepEqual(findings, []);
	});

	it("finds fewer test cases in a changed test file, at the place they were", () => {
		const findings = check(TS_FILES, (dir) => edit(dir, "src/price.test.ts", (text) => text.replace(/\tit\("keeps zero"[\s\S]*?\t\}\);\n\tit\("rounds"[\s\S]*?\t\}\);\n/, "")));
		assert.deepEqual(findings, [{ kind: "fewer-tests", path: "src/price.test.ts", line: 8, detail: "2 test cases fewer than before (2 removed, 0 added)" }]);
	});

	it("finds added skip and focus markers with their lines", () => {
		const findings = check(TS_FILES, (dir) => {
			edit(dir, "src/price.test.ts", (text) =>
				text
					.replace('it("adds VAT"', `it${SKIP}("adds VAT"`)
					.replace('it("keeps zero"', `it${ONLY}("keeps zero"`)
					.replace('it("rounds"', 'xit("rounds"')
					.replace('describe("price"', 'xdescribe("price"'),
			);
			edit(dir, "test/api.test.ts", (text) => text.replace('test("answers", ', 'test("answers", { skip: true }, '));
		});
		assert.deepEqual(where(findings), ["skip src/price.test.ts:5", "skip src/price.test.ts:8", "skip src/price.test.ts:4", "skip src/price.test.ts:11", "skip test/api.test.ts:2"]);
		assert.match(findings[0].detail, /skip or focus marker added: \.skip/);
		assert.match(findings[1].detail, /\.only/);
		assert.match(findings[2].detail, /xit\/xdescribe/);
		// xit is still a test case to the counter, so it is one finding, not two.
		assert.ok(!findings.some((finding) => finding.kind === "fewer-tests"));
	});

	it("leaves skip-like calls in application code alone", () => {
		const findings = check(TS_FILES, (dir) => edit(dir, "src/price.ts", (text) => `${text}export const page = (query: any) => query${SKIP}(10)${ONLY}("name");\n`));
		assert.deepEqual(findings, []);
	});

	it("finds added suppressions in tests and in application code", () => {
		const findings = check(TS_FILES, (dir) => {
			edit(dir, "src/price.ts", (text) => `// ${TS_IGNORE}\n${text}/* ${ESLINT_OFF} no-console */\n// ${OXLINT_OFF}-next-line\n`);
			edit(dir, "src/price.test.ts", (text) => text.replace("\t\texpect(price(100))", `\t\t// ${TS_EXPECT}\n\t\texpect(price(100))`));
		});
		assert.deepEqual(where(findings), ["suppression src/price.test.ts:6", "suppression src/price.ts:1", "suppression src/price.ts:5", "suppression src/price.ts:6"]);
		assert.deepEqual(
			findings.map((finding) => finding.detail),
			[`suppression added: ${TS_EXPECT}`, `suppression added: ${TS_IGNORE}`, `suppression added: ${ESLINT_OFF}`, `suppression added: ${OXLINT_OFF}`],
		);
	});

	it("does not count a marker that was there before and only moved or changed its line", () => {
		const files = { ...TS_FILES, "src/old.ts": lines(`// ${ESLINT_OFF}-next-line no-console`, "console.log(1);", "export {};") };
		const findings = check(files, (dir) => edit(dir, "src/old.ts", (text) => `export const first = 1;\n${text.replace("no-console", "no-console, no-alert")}`));
		assert.deepEqual(findings, []);
	});

	it("finds changes to lint, type and test configuration, added and deleted ones included", () => {
		const findings = check(TS_FILES, (dir) => {
			edit(dir, "tsconfig.json", (text) => text.replace('"strict": true', '"strict": false'));
			rmSync(join(dir, "eslint.config.js"));
			mkdirSync(join(dir, "test"), { recursive: true });
			writeFileSync(join(dir, "test/.eslintrc.json"), lines('{ "rules": {} }'));
			edit(dir, "vitest.config.ts", (text) => `${text}// exclude\n`);
		});
		assert.deepEqual(
			findings.map((finding) => `${finding.path}${finding.line ? `:${finding.line}` : ""} ${finding.detail}`).sort(),
			[
				"eslint.config.js lint, type or test configuration deleted",
				"test/.eslintrc.json:1 lint, type or test configuration added",
				"tsconfig.json:2 lint, type or test configuration changed",
				"vitest.config.ts:2 lint, type or test configuration changed",
			],
		);
	});

	it("finds a changed or removed script and test configuration in package.json", () => {
		const changed = check(TS_FILES, (dir) => edit(dir, "package.json", (text) => text.replace("tsc && eslint . && vitest run", "true")));
		assert.deepEqual(changed, [{ kind: "config", path: "package.json", line: 4, detail: 'script "check" changed' }]);
		const removed = check(TS_FILES, (dir) => edit(dir, "package.json", (text) => text.replace('\t\t"check": "tsc && eslint . && vitest run",\n', "").replace('"dependencies": {}', '"jest": { "testPathIgnorePatterns": ["src"] }')));
		assert.deepEqual(
			removed.map((finding) => finding.detail),
			['script "check" removed', '"jest" changed (lint or test configuration)'],
		);
	});

	it("applies the repository's own patterns to added lines", () => {
		const patterns = [{ pattern: "\\bas any\\b", reason: "no `as any`" }];
		const findings = check(TS_FILES, (dir) => edit(dir, "src/price.ts", (text) => `${text}export const loose = price as any;\n`), patterns);
		assert.deepEqual(findings, [{ kind: "pattern", path: "src/price.ts", line: 4, detail: "no `as any`" }]);
	});
});

describe("weakened-test check on a Python repository", () => {
	it("finds nothing in an honest change", () => {
		const findings = check(PY_FILES, (dir) => {
			edit(dir, "shop/price.py", (text) => `${text}\n\nVAT = 0.19\n`);
			edit(dir, "tests/test_price.py", (text) => `${text}\n\ndef test_rate():\n    assert True\n`);
			edit(dir, "pyproject.toml", (text) => text.replace('dependencies = ["httpx"]', 'dependencies = ["httpx", "pydantic"]').replace("dev-dependencies = []", 'dev-dependencies = ["pytest"]'));
			edit(dir, "setup.cfg", (text) => text.replace("name = shop", "name = shop\nversion = 1"));
		});
		assert.deepEqual(findings, []);
	});

	it("finds a deleted test file and fewer test cases", () => {
		const findings = check(PY_FILES, (dir) => {
			writeFileSync(join(dir, "tests/test_extra.py"), "def test_extra():\n    assert True\n");
			sh(dir, "add", "-A");
			sh(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "more");
		});
		assert.deepEqual(findings, [], "a new test file is no finding");
		const deleted = check({ ...PY_FILES, "tests/test_extra.py": "def test_extra():\n    assert True\n" }, (dir) => {
			rmSync(join(dir, "tests/test_extra.py"));
			edit(dir, "tests/test_price.py", (text) => text.replace(/def test_keeps_zero\(\):\n {4}assert price\(0\) == 0\n\n\n/, "").replace(/class TestRounding:[\s\S]*$/, ""));
		});
		assert.deepEqual(where(deleted), ["deleted-test tests/test_extra.py", "fewer-tests tests/test_price.py:9"]);
		assert.match(deleted[1].detail, /^2 test cases fewer than before/);
	});

	it("finds added skip markers and xfail", () => {
		const findings = check(PY_FILES, (dir) =>
			edit(dir, "tests/test_price.py", (text) =>
				text
					.replace("def test_adds_vat():", `@pytest.mark${SKIP}(reason="later")\ndef test_adds_vat():`)
					.replace("def test_keeps_zero():", "@pytest.mark.xfail\ndef test_keeps_zero():")
					.replace("        assert price(1) == 1.19", `        pytest${SKIP}("flaky")\n        assert price(1) == 1.19`),
			),
		);
		assert.deepEqual(where(findings), ["skip tests/test_price.py:5", "skip tests/test_price.py:10", "skip tests/test_price.py:17"]);
		assert.deepEqual(
			findings.map((finding) => finding.detail),
			["skip or focus marker added: @pytest.mark.skip", "skip or focus marker added: xfail", "skip or focus marker added: pytest.skip"],
		);
	});

	it("finds added suppressions", () => {
		const findings = check(PY_FILES, (dir) => edit(dir, "shop/price.py", (text) => text.replace("    return net * 1.19", `    x: int = "a"  ${TYPE_IGNORE}[assignment]\n    import os  ${NOQA}: F401\n    y = net.z  ${PYRIGHT_IGNORE}\n    return net * 1.19`)));
		assert.deepEqual(where(findings), ["suppression shop/price.py:2", "suppression shop/price.py:3", "suppression shop/price.py:4"]);
		assert.deepEqual(
			findings.map((finding) => finding.detail),
			["suppression added: # type: ignore", "suppression added: # noqa", "suppression added: pyright: ignore"],
		);
	});

	it("finds changes to the lint, type and test tables of pyproject.toml and setup.cfg, by section", () => {
		const findings = check(PY_FILES, (dir) => {
			edit(dir, "pyproject.toml", (text) => text.replace('select = ["E", "F", "B"]', 'select = ["E"]').replace('typeCheckingMode = "strict"', 'typeCheckingMode = "basic"').replace('addopts = "-q"', 'addopts = "-q --deselect tests/test_price.py"'));
			edit(dir, "setup.cfg", (text) => `${text}extend-ignore = E501\n`);
		});
		assert.deepEqual(
			findings.map((finding) => `${finding.path}:${finding.line} ${finding.detail}`),
			[
				"pyproject.toml:9 [tool.ruff.lint] changed (lint, type or test configuration)",
				"pyproject.toml:12 [tool.pyright] changed (lint, type or test configuration)",
				"pyproject.toml:15 [tool.pytest.ini_options] changed (lint, type or test configuration)",
				"setup.cfg:6 [flake8] changed (lint, type or test configuration)",
			],
		);
	});

	it("finds a removed tool table and a changed standalone configuration file", () => {
		const findings = check({ ...PY_FILES, "pytest.ini": "[pytest]\naddopts = -q\n", "ruff.toml": "line-length = 100\n" }, (dir) => {
			edit(dir, "pyproject.toml", (text) => text.replace('[tool.pyright]\ntypeCheckingMode = "strict"\n\n', ""));
			edit(dir, "pytest.ini", (text) => `${text}testpaths = none\n`);
			rmSync(join(dir, "ruff.toml"));
		});
		assert.deepEqual(
			findings.map((finding) => `${finding.path}${finding.line ? `:${finding.line}` : ""} ${finding.detail}`).sort(),
			["pyproject.toml:11 [tool.pyright] changed (lint, type or test configuration)", "pytest.ini:3 lint, type or test configuration changed", "ruff.toml lint, type or test configuration deleted"],
		);
	});
});

describe("weakened-test check helpers", () => {
	it("knows test files of both languages", () => {
		for (const path of ["src/a.test.ts", "src/a.spec.tsx", "test/a.ts", "pkg/__tests__/a.js", "e2e/login.mjs", "tests/test_a.py", "pkg/a_test.py", "tests/helpers.py", "test_a.py"]) {
			assert.ok(isTestFile(path), path);
		}
		for (const path of ["src/a.ts", "src/latest/a.ts", "contest/a.py", "tests/data.json", "docs/test.md", "src/testing.py"]) assert.ok(!isTestFile(path), path);
	});
	it("knows configuration files by name, in any directory", () => {
		for (const path of ["tsconfig.json", "packages/a/tsconfig.build.json", ".eslintrc.cjs", "eslint.config.mjs", ".oxlintrc.json", "biome.json", "vitest.workspace.ts", "jest.config.js", "playwright.config.ts", "pytest.ini", "tox.ini", "mypy.ini", "pyrightconfig.json", ".ruff.toml", ".flake8"]) {
			assert.ok(isCheckConfig(path), path);
		}
		for (const path of ["package.json", "pyproject.toml", "src/config.ts", "tsconfig.ts", "vitest.setup.ts"]) assert.ok(!isCheckConfig(path), path);
	});
	it("parses added, deleted, renamed files and line numbers of a -U0 diff", () => {
		const patch = lines(
			"diff --git a/src/a.ts b/src/a.ts",
			"index 1..2 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -3 +3,2 @@ export",
			"-old line",
			"+new line",
			"+second new line",
			"@@ -10,2 +10,0 @@",
			"-gone 1",
			"-gone 2",
			"diff --git a/with space.py b/with space.py",
			"deleted file mode 100644",
			"--- a/with space.py\t",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-x = 1",
			"diff --git a/old/name.ts b/new/name.ts",
			"similarity index 100%",
			"rename from old/name.ts",
			"rename to new/name.ts",
			"diff --git a/bin.png b/bin.png",
			"new file mode 100644",
			"Binary files /dev/null and b/bin.png differ",
		);
		const files = parseDiff(patch);
		assert.deepEqual(
			files.map((file) => [file.status, file.path, file.oldPath]),
			[
				["modified", "src/a.ts", undefined],
				["deleted", "with space.py", undefined],
				["renamed", "new/name.ts", "old/name.ts"],
				["added", "bin.png", undefined],
			],
		);
		assert.deepEqual(files[0].added, [
			{ line: 3, text: "new line" },
			{ line: 4, text: "second new line" },
		]);
		assert.deepEqual(files[0].removed, [
			{ line: 3, text: "old line", at: 3 },
			{ line: 10, text: "gone 1", at: 11 },
			{ line: 11, text: "gone 2", at: 11 },
		]);
	});
	it("works on a parsed diff without file contents", () => {
		const findings = findTampering([{ path: "a.test.ts", status: "modified", added: [{ line: 7, text: `\tit${SKIP}("x", () => {});` }], removed: [{ line: 7, text: '\tit("x", () => {});', at: 7 }] }]);
		assert.deepEqual(where(findings), ["skip a.test.ts:7"]);
	});
	it("formats findings as path:line and caps a long list", () => {
		const many = Array.from({ length: 35 }, (_, index): Finding => ({ kind: "suppression", path: "a.ts", line: index + 1, detail: "suppression added" }));
		const formatted = formatFindings([{ kind: "deleted-test", path: "t/a.test.ts", detail: "test file deleted" }, ...many]);
		assert.equal(formatted[0], "- t/a.test.ts: test file deleted");
		assert.equal(formatted[1], "- a.ts:1: suppression added");
		assert.equal(formatted.length, 31);
		assert.equal(formatted.at(-1), "- … and 6 more");
	});
	it("takes the working tree with untracked files, without ignored ones, and leaves the index alone", () => {
		const dir = repo({ "a.ts": "export {};\n", ".gitignore": "ignored/\n" });
		const before = snapshotTree(dir);
		mkdirSync(join(dir, "ignored"));
		writeFileSync(join(dir, "ignored/x.test.ts"), "x\n");
		assert.equal(snapshotTree(dir), before, "ignored files are not part of the state");
		writeFileSync(join(dir, "b.ts"), "export {};\n");
		const withUntracked = snapshotTree(dir);
		assert.notEqual(withUntracked, before);
		assert.equal(sh(dir, "status", "--porcelain").trim(), "?? b.ts", "the index is untouched");
		assert.equal(snapshotTree(mkdtempSync(join(tmpdir(), "nest-tamper-nogit-"))), undefined);
	});
});
