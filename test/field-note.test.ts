import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { compareWithPrevious, isOpen, modelName, nestCommitOf, notesFor, openNote, parseRole, readConfig, renderComparison, renderConfig, repositoryOf } from "../scripts/field-note.ts";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(NEST, "scripts/field-note.ts");
const TEMPLATE = readFileSync(join(NEST, "field-notes/TEMPLATE.md"), "utf-8");

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A note as /nest-supervise fills it in: the template with a start HEAD, and an end HEAD once handed off. */
function note(options: { commit?: string; end?: string; repo?: string } = {}): string {
	return TEMPLATE.replace("- Repository / branch:", `- Repository / branch: ${options.repo ?? "undertext"} / main`)
		.replace("- Start HEAD → end HEAD:", `- Start HEAD → end HEAD: 1a2b3c4 → ${options.end ?? ""}`)
		.replace(/- Config under test:.*/, `- Config under test: pecker-nest ${options.commit ?? "99e7124"}, Pi 1.5.0; router/escalate: Flash high, strong model GLM 5.3 max; roles: worker Flash high`);
}

function notesDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "nest-notes-"));
	dirs.push(dir);
	let age = Object.keys(files).length;
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
		// Listed oldest first: later entries are newer files.
		const time = new Date(Date.now() - age-- * 60_000);
		utimesSync(join(dir, name), time, time);
	}
	return dir;
}

describe("config under test", () => {
	const config = readConfig(NEST, "1.5.0");
	it("reads thinking levels per tier and role and the strong model from the repository", () => {
		assert.match(config.commit, /^[0-9a-f]{7,}$/);
		assert.equal(config.piVersion, "1.5.0");
		assert.equal(config.flashLevel, "high");
		assert.equal(config.strongLevel, "max");
		assert.equal(config.strong, "GLM 5.3");
		// The role files are the source: this fails when a role changes and the note would still say otherwise.
		for (const role of config.roles) {
			const file = readFileSync(join(NEST, "agent/agents", `${role.name}.md`), "utf-8");
			assert.match(file, new RegExp(`^model: ${role.model}$`, "m"));
			assert.match(file, new RegExp(`^thinking: ${role.thinking}$`, "m"));
		}
		assert.deepEqual(config.roles.map((role) => role.name), ["planner", "reviewer", "scout", "worker"]);
	});
	it("renders one line for the field note", () => {
		const line = renderConfig({ ...config, commit: "abc1234", dirty: false });
		assert.equal(
			line,
			"pecker-nest abc1234, Pi 1.5.0; router/escalate: Flash high, strong model GLM 5.3 max; roles: planner GLM 5.3 max, reviewer GLM 5.3 max, scout Flash low, worker Flash high",
		);
		assert.match(renderConfig({ ...config, commit: "abc1234", dirty: true }), /^pecker-nest abc1234 with uncommitted changes, Pi/);
		assert.match(renderConfig({ ...config, piVersion: "unknown", roles: [] }), /Pi unknown; .*roles: none found$/);
	});
	it("parses a role file and names the models", () => {
		assert.deepEqual(parseRole("---\nname: worker\nmodel: openrouter/x/y\nthinking: high\ntools: read\n---\nbody\nmodel: not this"), { name: "worker", model: "openrouter/x/y", thinking: "high" });
		assert.deepEqual(parseRole("---\nname: bare\n---\n"), { name: "bare", model: "?", thinking: "?" });
		assert.equal(parseRole("no front matter"), undefined);
		assert.equal(modelName("openrouter/moonshotai/kimi-k3.1-pro"), "Kimi K3.1 Pro");
		assert.equal(modelName("openrouter/other/model"), "openrouter/other/model");
	});
});

describe("field notes", () => {
	it("tells an open note from a closed one by the end HEAD", () => {
		assert.ok(isOpen(note()), "start HEAD only");
		assert.ok(isOpen(note({ end: "(open)" })));
		assert.ok(!isOpen(note({ end: "5d6e7f8" })));
		assert.ok(!isOpen(note({ end: "`5d6e7f8a9b0c`" })));
		assert.ok(isOpen(TEMPLATE), "the empty template has no end HEAD");
		assert.ok(!isOpen("# a note without a Session section\n"), "no line, nothing to continue");
		// Only the Session section counts: hashes elsewhere do not close a note.
		assert.ok(isOpen(note().replace("- Diff: files, +/− lines, commits:", "- Diff: files, +/− lines, commits: 1a2b3c4 → 5d6e7f8")));
	});
	it("finds a repository's notes, newest first, and not those of a repository with a longer name", () => {
		const dir = notesDir({
			"2026-11-07-undertext-m1-step1.md": note({ end: "aaaaaaa" }),
			"2026-11-09-undertext-m1-step2.md": note({ end: "bbbbbbb" }),
			"2026-11-10-undertext-web-m1.md": note({ repo: "undertext-web" }),
			"2026-11-10-pecker-grove-session-2.md": note({ repo: "pecker-grove" }),
			"2026-11-09-undertext-m1-step3.md": note(),
			// A note from before the Session section named the repository: the file name decides.
			"2026-11-01-undertext-first.md": "# nest field note\n\n## Session\n\n- Start HEAD → end HEAD: 1111111 → 2222222\n",
			"TEMPLATE.md": TEMPLATE,
			"README.md": "# Field notes\n",
		});
		assert.deepEqual(
			notesFor(dir, "undertext").map((file) => file.slice(dir.length + 1)),
			["2026-11-09-undertext-m1-step3.md", "2026-11-09-undertext-m1-step2.md", "2026-11-07-undertext-m1-step1.md", "2026-11-01-undertext-first.md"],
		);
		assert.deepEqual(notesFor(dir, "undertext-web").map((file) => file.slice(dir.length + 1)), ["2026-11-10-undertext-web-m1.md"]);
		assert.deepEqual(notesFor(dir, "pecker-grove").map((file) => file.slice(dir.length + 1)), ["2026-11-10-pecker-grove-session-2.md"]);
		assert.deepEqual(notesFor(dir, "pecker"), [], "a prefix of another repository's name is no match");
		assert.deepEqual(notesFor(join(dir, "missing"), "undertext"), []);
	});
	it("reads the repository from the Session section, however it is written", () => {
		assert.equal(repositoryOf(note({ repo: "pecker-grove" })), "pecker-grove");
		assert.equal(repositoryOf("## Session\n- Repository / branch: `~/dev/undertext` / feat/m1\n"), "undertext");
		assert.equal(repositoryOf("## Session\n- Repository / branch: davidkutt/undertext / main\n"), "undertext");
		assert.equal(repositoryOf(TEMPLATE), undefined, "the empty template names none");
	});
	it("picks the open note even when it is days old and newer closed ones exist", () => {
		const dir = notesDir({
			"2026-11-05-undertext-m1.md": note(),
			"2026-11-08-undertext-hotfix.md": note({ end: "ccccccc" }),
			"2026-11-09-undertext-docs.md": note({ end: "ddddddd" }),
		});
		assert.equal(openNote(dir, "undertext"), join(dir, "2026-11-05-undertext-m1.md"));
		assert.equal(openNote(dir, "pecker-grove"), undefined);
	});
	it("reads the pecker-nest commit from the current and the earlier Session line", () => {
		assert.equal(nestCommitOf(note({ commit: "c953625" })), "c953625");
		assert.equal(nestCommitOf("## Session\n\n- Setup: pecker-nest `9e7305d`, Pi 1.5.0, router/escalate\n\n## Outcome\n"), "9e7305d");
		assert.equal(nestCommitOf(TEMPLATE), undefined);
	});
	it("compares the commit with the previous note of the repository", () => {
		const dir = notesDir({
			"2026-11-08-undertext-m1-step1.md": note({ commit: "9e7305d", end: "aaaaaaa" }),
			"2026-11-10-undertext-m1-step2.md": note({ commit: "99e7124" }),
		});
		const current = join(dir, "2026-11-10-undertext-m1-step2.md");
		const differs = compareWithPrevious(dir, "undertext", "99e7124", current);
		assert.deepEqual(differs, { previous: join(dir, "2026-11-08-undertext-m1-step1.md"), previousCommit: "9e7305d", differs: true });
		assert.equal(renderComparison(differs), "pecker-nest commit differs from the previous note (2026-11-08-undertext-m1-step1.md: 9e7305d)");
		const same = compareWithPrevious(dir, "undertext", "9e7305d1c2b3", current);
		assert.equal(same.differs, false, "a long and a short hash of one commit are the same");
		assert.equal(renderComparison(same), "same pecker-nest commit as the previous note (2026-11-08-undertext-m1-step1.md)");
		assert.match(renderComparison(compareWithPrevious(dir, "pecker-grove", "99e7124")), /^no previous note/);
		const unrecorded = notesDir({ "2026-11-01-undertext-old.md": "# old note\n" });
		assert.match(renderComparison(compareWithPrevious(unrecorded, "undertext", "99e7124")), /records no pecker-nest commit/);
	});
});

describe("scripts/field-note.ts", () => {
	const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf-8", env: { ...process.env, PATH: "/usr/bin:/bin" } });
	const dir = notesDir({
		"2026-11-08-undertext-m1-step1.md": note({ commit: "0000000", end: "aaaaaaa" }),
		"2026-11-10-undertext-m1-step2.md": note(),
	});
	it("open prints the open note, or fails with 1", () => {
		const found = cli("open", "--repo", "undertext", "--notes", dir);
		assert.equal(found.status, 0, found.stderr);
		assert.equal(found.stdout.trim(), join(dir, "2026-11-10-undertext-m1-step2.md"));
		const none = cli("open", "--repo", "pecker-grove", "--notes", dir);
		assert.equal(none.status, 1);
		assert.match(none.stderr, /no open field note for pecker-grove/);
		assert.equal(cli("open", "--notes", dir).status, 2);
	});
	it("config prints the line and the comparison, leaving the open note out", () => {
		const run = cli("config", "--repo", "undertext", "--notes", dir);
		assert.equal(run.status, 0, run.stderr);
		const [config, comparison] = run.stdout.trim().split("\n");
		// Pi is not on this PATH: the line says so instead of guessing.
		assert.match(config, /^- Config under test: pecker-nest [0-9a-f]{7,}( with uncommitted changes)?, Pi unknown; router\/escalate: Flash high, strong model GLM 5\.3 max; roles: planner GLM 5\.3 max, /);
		assert.equal(comparison, "- Compared with the previous note: pecker-nest commit differs from the previous note (2026-11-08-undertext-m1-step1.md: 0000000)");
		const json = JSON.parse(cli("config", "--json").stdout);
		assert.equal(json.config.strong, "GLM 5.3");
		assert.ok(!("comparison" in json), "no comparison without --repo");
	});
	it("rejects unknown commands and arguments", () => {
		assert.equal(cli("nope").status, 2);
		assert.equal(cli("config", "--nope").status, 2);
	});
});
