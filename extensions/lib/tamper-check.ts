/**
 * Weakened-test check for the quality gate. A green check is nest's definition of done, and the
 * cheapest way to a green check is to weaken what it checks. This looks at the diff between the
 * state at your prompt and now and reports, with file and line:
 *
 * - deleted test files;
 * - fewer test cases in a changed test file;
 * - added skip or focus markers (`.skip`, `.only`, `xit`, `xdescribe`, `@pytest.mark.skip`, `xfail`);
 * - added suppressions (`@ts-ignore`, `@ts-expect-error`, `eslint-disable`, `oxlint-disable`,
 *   `# type: ignore`, `# noqa`, `pyright: ignore`);
 * - changes to lint, type or test configuration;
 * - added lines that match the repository's own patterns (`tamperPatterns` in `.pi/gate.json`).
 *
 * Everything here is deterministic: no model judges the change. The detectors are pure and work on
 * a parsed diff; the git part below them takes the two states as tree objects, built in a
 * temporary index, so your index, branch and stash are not touched.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

// ---------------------------------------------------------------- diff (pure)

export interface DiffLine {
	/** Line number in the file the line belongs to: the new file for added lines, the old one for removed lines. */
	line: number;
	text: string;
	/** For a removed line: the line in the new file where it was. */
	at?: number;
}

export interface FileDiff {
	/** Path now; for a deleted file, the path it had. Relative to the repository root. */
	path: string;
	/** The earlier path of a renamed file. */
	oldPath?: string;
	status: "added" | "deleted" | "modified" | "renamed";
	added: DiffLine[];
	removed: DiffLine[];
}

/** `--- a/path` and `+++ b/path` carry a trailing tab when the path has spaces. */
function patchPath(value: string, prefix: "a/" | "b/"): string | undefined {
	const path = value.replace(/\t$/, "");
	if (path === "/dev/null") return undefined;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** Parses `git diff -U0` output (with `core.quotePath=false`). */
export function parseDiff(patch: string): FileDiff[] {
	const files: FileDiff[] = [];
	let file: FileDiff | undefined;
	let oldLine = 0;
	let newLine = 0;
	let inHunk = false;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			// Without rename, the header is `a/<path> b/<path>` with the same path twice.
			const rest = line.slice("diff --git a/".length);
			file = { path: rest.slice(0, Math.max(0, (rest.length - 3) / 2)), status: "modified", added: [], removed: [] };
			files.push(file);
			inHunk = false;
			continue;
		}
		if (!file) continue;
		if (!inHunk) {
			if (line.startsWith("deleted file mode")) file.status = "deleted";
			else if (line.startsWith("new file mode")) file.status = "added";
			else if (line.startsWith("rename from ")) {
				file.status = "renamed";
				file.oldPath = line.slice("rename from ".length);
			} else if (line.startsWith("rename to ")) file.path = line.slice("rename to ".length);
			else if (line.startsWith("--- ")) {
				const path = patchPath(line.slice(4), "a/");
				if (path && file.status !== "renamed") file.path = path;
			} else if (line.startsWith("+++ ")) {
				const path = patchPath(line.slice(4), "b/");
				if (path) file.path = path;
			}
		}
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (hunk) {
			inHunk = true;
			oldLine = Number(hunk[1]);
			// `+c,0` (lines only removed) names the line before the gap.
			newLine = hunk[4] === "0" ? Number(hunk[3]) + 1 : Number(hunk[3]);
			continue;
		}
		if (!inHunk) continue;
		if (line.startsWith("+")) file.added.push({ line: newLine++, text: line.slice(1) });
		else if (line.startsWith("-")) file.removed.push({ line: oldLine++, text: line.slice(1), at: Math.max(1, newLine) });
	}
	return files;
}

// ---------------------------------------------------------------- what counts as what (pure)

type Language = "js" | "py" | undefined;

function languageOf(path: string): Language {
	if (/\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i.test(path)) return "js";
	if (/\.pyi?$/i.test(path)) return "py";
	return undefined;
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Test files of the two languages nest works in: by name, or code inside a test directory. */
export function isTestFile(path: string): boolean {
	const language = languageOf(path);
	if (!language) return false;
	const name = basename(path);
	const inTestDir = /(?:^|\/)(?:tests?|__tests__|e2e|spec|specs)\//i.test(path);
	if (language === "js") return /\.(?:test|spec|e2e)\.[^.]+$/i.test(name) || /\.test-d\.[^.]+$/i.test(name) || inTestDir;
	return /^test_.*\.py$/i.test(name) || /_test\.py$/i.test(name) || inTestDir;
}

/** One test case per matching line, so added and removed lines of a diff can be counted. */
const TEST_CASE: Record<"js" | "py", RegExp> = {
	// xit and fit are still test cases: skipping one is a skip finding, not a missing test.
	js: /^\s*(?:await\s+|return\s+|void\s+)?(?:[xf]?it|x?test|x?specify|Deno\.test|t\.test)\b(?:\.\w+)*\s*[(`]/,
	py: /^\s*(?:async\s+)?def\s+test\w*\s*\(/,
};

interface Marker {
	name: string;
	pattern: RegExp;
	/** Only in test files: the pattern is ordinary code elsewhere (`query.skip(10)`, `fit(model)`). */
	testFilesOnly?: boolean;
}

const SKIP_MARKERS: Record<"js" | "py", Marker[]> = {
	js: [
		{ name: ".skip", pattern: /\.skip(?:If)?\s*[(`]|\.skip\.\w+\s*[(`]/, testFilesOnly: true },
		{ name: ".only", pattern: /\.only\s*[(`]|\.only\.\w+\s*[(`]/, testFilesOnly: true },
		{ name: ".fixme", pattern: /\.fixme\s*[(`]/, testFilesOnly: true },
		{ name: "xit/xdescribe", pattern: /(?:^|[^\w.$])x(?:it|describe|test|context|specify)\s*[(`]/, testFilesOnly: true },
		{ name: "fit/fdescribe", pattern: /(?:^|[^\w.$])f(?:it|describe|context)\s*[(`]/, testFilesOnly: true },
		{ name: "skip option", pattern: /\b(?:skip|only|todo)\s*:\s*(?:true\b|["'`])/, testFilesOnly: true },
	],
	py: [
		{ name: "@pytest.mark.skip", pattern: /\bpytest\.mark\.skip(?:if)?\b/ },
		{ name: "xfail", pattern: /\bxfail\b/ },
		{ name: "pytest.skip", pattern: /\bpytest\.skip\s*\(|\bpytest\.importorskip\s*\(/ },
		{ name: "unittest.skip", pattern: /\bunittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b|@(?:skip|skipIf|skipUnless|expectedFailure)\b|\bself\.skipTest\s*\(/ },
	],
};

const SUPPRESSIONS: Record<"js" | "py", Marker[]> = {
	js: [
		{ name: "@ts-ignore", pattern: /@ts-ignore\b/ },
		{ name: "@ts-expect-error", pattern: /@ts-expect-error\b/ },
		{ name: "@ts-nocheck", pattern: /@ts-nocheck\b/ },
		{ name: "eslint-disable", pattern: /\beslint-disable\b/ },
		{ name: "oxlint-disable", pattern: /\boxlint-disable\b/ },
		{ name: "biome-ignore", pattern: /\bbiome-ignore\b/ },
	],
	py: [
		{ name: "# type: ignore", pattern: /#\s*type:\s*ignore\b/ },
		{ name: "# noqa", pattern: /#\s*(?:ruff:\s*|flake8:\s*)?noqa\b/i },
		{ name: "pyright: ignore", pattern: /#\s*pyright:\s*ignore\b/ },
		{ name: "# pylint: disable", pattern: /#\s*pylint:\s*disable\b/ },
		{ name: "# mypy: ignore", pattern: /#\s*mypy:\s*ignore/ },
	],
};

/** Files that are lint, type or test configuration as a whole, by basename. */
const CONFIG_FILES: RegExp[] = [
	/^tsconfig(?:\..+)?\.json$/,
	/^jsconfig\.json$/,
	/^\.eslintrc(?:\..+)?$/,
	/^eslint\.config\.[cm]?[jt]s$/,
	/^\.eslintignore$/,
	/^\.?oxlintrc(?:\.json)?$/,
	/^oxlint\.config\.[cm]?[jt]s$/,
	/^biome\.jsonc?$/,
	/^(?:vitest|jest|playwright|cypress|karma|wdio|ava)\.(?:config|workspace)\.[^.]+$/,
	/^\.mocharc(?:\..+)?$/,
	/^pytest\.ini$/,
	/^tox\.ini$/,
	/^\.?mypy\.ini$/,
	/^pyrightconfig\.json$/,
	/^\.?ruff\.toml$/,
	/^\.flake8$/,
	/^\.?pylintrc(?:\.toml)?$/,
	/^\.coveragerc$/,
];

export function isCheckConfig(path: string): boolean {
	const name = basename(path);
	return CONFIG_FILES.some((pattern) => pattern.test(name));
}

/** `[tool.<name>]` tables of pyproject.toml that configure linting, typing or tests. */
const PYPROJECT_TOOLS = /^tool\.(?:ruff|pyright|basedpyright|mypy|ty|pytest|coverage|pylint|flake8|pycodestyle|pydocstyle|bandit|tox)(?:\.|$)/;
/** Sections of setup.cfg with the same role. */
const SETUP_CFG_SECTIONS = /^(?:flake8|mypy(?:-.*)?|tool:pytest|pytest|pycodestyle|pydocstyle|coverage:.*|pylint.*)$/;
/** Keys of package.json that hold lint or test configuration. `scripts` is compared per script. */
const PACKAGE_JSON_KEYS = ["jest", "eslintConfig", "eslintIgnore", "mocha", "ava", "vitest", "c8", "nyc", "tap"];

// ---------------------------------------------------------------- findings (pure)

export type FindingKind = "deleted-test" | "fewer-tests" | "skip" | "suppression" | "config" | "pattern";

export interface Finding {
	kind: FindingKind;
	path: string;
	/** Line in the file as it is now; absent for a deleted file. */
	line?: number;
	/** What was found, without file content beyond the marker's name. */
	detail: string;
}

export interface TamperPattern {
	/** A regular expression tested against each added line. */
	pattern: string;
	reason: string;
}

export interface TamperOptions {
	patterns?: readonly TamperPattern[];
	/** File content before (`old`) or now (`new`), for files whose sections matter. Undefined when absent. */
	read?: (side: "old" | "new", path: string) => string | undefined;
}

const isDocs = (path: string) => /\.(?:md|mdx|markdown|rst|adoc)$/i.test(path);

/**
 * Added lines that carry a marker which was not there before: an edited line that keeps its
 * marker is one removed and one added line, and counts as nothing new.
 */
function newlyMarked(file: FileDiff, pattern: RegExp): DiffLine[] {
	const added = file.added.filter((line) => pattern.test(line.text));
	if (!added.length) return [];
	const removed = file.removed.filter((line) => pattern.test(line.text));
	const net = added.length - removed.length;
	if (net <= 0) return [];
	const before = removed.map((line) => line.text.trim());
	const fresh = added.filter((line) => {
		const index = before.indexOf(line.text.trim());
		if (index < 0) return true;
		before.splice(index, 1);
		return false;
	});
	return fresh.slice(0, net);
}

/** The section each line of an INI or TOML file belongs to, by 1-based line number. */
function sectionsByLine(text: string): string[] {
	const sections: string[] = [""];
	let current = "";
	for (const line of text.split("\n")) {
		const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:[#;].*)?$/.exec(line);
		if (header) current = header[1].replace(/["']/g, "");
		sections.push(current);
	}
	return sections;
}

function sectionFindings(file: FileDiff, wanted: RegExp, options: TamperOptions): Finding[] {
	const newSections = sectionsByLine(options.read?.("new", file.path) ?? "");
	const oldSections = sectionsByLine(options.read?.("old", file.oldPath ?? file.path) ?? "");
	const touched = new Map<string, number>();
	for (const line of file.added) {
		const section = newSections[line.line] ?? "";
		if (wanted.test(section) && !touched.has(section)) touched.set(section, line.line);
	}
	for (const line of file.removed) {
		const section = oldSections[line.line] ?? "";
		if (wanted.test(section) && !touched.has(section)) touched.set(section, line.at ?? 1);
	}
	return [...touched].map(([section, line]) => ({ kind: "config" as const, path: file.path, line, detail: `[${section}] changed (lint, type or test configuration)` }));
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
	if (text === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** The line of a top-level-looking key in JSON text, or of the first changed line. */
function keyLine(text: string | undefined, key: string, fallback: number): number {
	const index = (text ?? "").split("\n").findIndex((line) => new RegExp(`^\\s*${JSON.stringify(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(line));
	return index >= 0 ? index + 1 : fallback;
}

/** package.json: an existing script that changed or went away, or changed lint/test configuration keys. */
function packageJsonFindings(file: FileDiff, options: TamperOptions): Finding[] {
	const newText = options.read?.("new", file.path);
	const before = parseObject(options.read?.("old", file.oldPath ?? file.path));
	const after = parseObject(newText);
	if (!before || !after) return [];
	const fallback = file.added[0]?.line ?? file.removed[0]?.at ?? 1;
	const findings: Finding[] = [];
	const oldScripts = (before.scripts && typeof before.scripts === "object" ? before.scripts : {}) as Record<string, unknown>;
	const newScripts = (after.scripts && typeof after.scripts === "object" ? after.scripts : {}) as Record<string, unknown>;
	for (const name of Object.keys(oldScripts)) {
		if (oldScripts[name] === newScripts[name]) continue;
		const gone = !(name in newScripts);
		findings.push({ kind: "config", path: file.path, line: keyLine(newText, gone ? "scripts" : name, fallback), detail: `script "${name}" ${gone ? "removed" : "changed"}` });
	}
	for (const key of PACKAGE_JSON_KEYS) {
		if (stableJson(before[key]) === stableJson(after[key])) continue;
		findings.push({ kind: "config", path: file.path, line: keyLine(newText, key, fallback), detail: `"${key}" changed (lint or test configuration)` });
	}
	return findings;
}

function configFindings(file: FileDiff, options: TamperOptions): Finding[] {
	const name = basename(file.path);
	if (isCheckConfig(file.path)) {
		const what = file.status === "deleted" ? "deleted" : file.status === "added" ? "added" : "changed";
		const line = file.status === "deleted" ? undefined : (file.added[0]?.line ?? file.removed[0]?.at ?? 1);
		return [{ kind: "config", path: file.path, ...(line ? { line } : {}), detail: `lint, type or test configuration ${what}` }];
	}
	if (file.status === "deleted") return [];
	if (name === "package.json") return packageJsonFindings(file, options);
	if (name === "pyproject.toml") return sectionFindings(file, PYPROJECT_TOOLS, options);
	if (name === "setup.cfg") return sectionFindings(file, SETUP_CFG_SECTIONS, options);
	return [];
}

/** Every finding of the weakened-test check for a parsed diff, in file order. */
export function findTampering(files: readonly FileDiff[], options: TamperOptions = {}): Finding[] {
	const findings: Finding[] = [];
	const patterns = (options.patterns ?? []).map((entry) => ({ ...entry, regex: new RegExp(entry.pattern) }));
	for (const file of files) {
		if (isDocs(file.path)) continue;
		const language = languageOf(file.path);
		const test = isTestFile(file.path);

		if (file.status === "deleted") {
			if (test) findings.push({ kind: "deleted-test", path: file.path, detail: "test file deleted" });
			findings.push(...configFindings(file, options));
			continue;
		}

		if (test && language) {
			const removed = file.removed.filter((line) => TEST_CASE[language].test(line.text));
			const added = file.added.filter((line) => TEST_CASE[language].test(line.text));
			const fewer = removed.length - added.length;
			if (fewer > 0) {
				findings.push({
					kind: "fewer-tests",
					path: file.path,
					line: removed[0].at ?? 1,
					detail: `${fewer} test case${fewer === 1 ? "" : "s"} fewer than before (${removed.length} removed, ${added.length} added)`,
				});
			}
		}

		if (language) {
			for (const marker of SKIP_MARKERS[language]) {
				if (marker.testFilesOnly && !test) continue;
				for (const line of newlyMarked(file, marker.pattern)) findings.push({ kind: "skip", path: file.path, line: line.line, detail: `skip or focus marker added: ${marker.name}` });
			}
			for (const marker of SUPPRESSIONS[language]) {
				for (const line of newlyMarked(file, marker.pattern)) findings.push({ kind: "suppression", path: file.path, line: line.line, detail: `suppression added: ${marker.name}` });
			}
		}

		findings.push(...configFindings(file, options));

		for (const entry of patterns) {
			for (const line of newlyMarked(file, entry.regex)) findings.push({ kind: "pattern", path: file.path, line: line.line, detail: entry.reason });
		}
	}
	return findings;
}

/** `path:line: detail`, one finding per line, bounded for the model's context. */
export function formatFindings(findings: readonly Finding[], max = 30): string[] {
	const lines = findings.slice(0, max).map((finding) => `- ${finding.path}${finding.line ? `:${finding.line}` : ""}: ${finding.detail}`);
	if (findings.length > max) lines.push(`- … and ${findings.length - max} more`);
	return lines;
}

// ---------------------------------------------------------------- git

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

/**
 * The working tree as a git tree object: tracked and untracked files, without ignored ones.
 * Built in a temporary copy of the index, so only changed files are hashed and your index stays
 * as it is. Undefined outside a git work tree.
 */
export function snapshotTree(cwd: string): string | undefined {
	let root: string;
	try {
		root = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
	} catch {
		return undefined;
	}
	if (!root) return undefined;
	const scratch = mkdtempSync(join(tmpdir(), "nest-gate-tree-"));
	const index = { GIT_INDEX_FILE: join(scratch, "index") };
	try {
		const current = git(root, ["rev-parse", "--git-path", "index"]).trim();
		const source = isAbsolute(current) ? current : join(root, current);
		if (existsSync(source)) copyFileSync(source, index.GIT_INDEX_FILE);
		git(root, ["add", "-A", "--", "."], index);
		return git(root, ["write-tree"], index).trim() || undefined;
	} catch {
		return undefined;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** The findings between two tree objects of the repository that contains `cwd`. Throws when git fails. */
export function tamperFindings(cwd: string, baseTree: string, currentTree: string, patterns: readonly TamperPattern[] = []): Finding[] {
	if (baseTree === currentTree) return [];
	const patch = git(cwd, ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "-U0", baseTree, currentTree]);
	const read = (side: "old" | "new", path: string): string | undefined => {
		try {
			return git(cwd, ["cat-file", "blob", `${side === "old" ? baseTree : currentTree}:${path}`]);
		} catch {
			return undefined;
		}
	};
	return findTampering(parseDiff(patch), { patterns, read });
}
