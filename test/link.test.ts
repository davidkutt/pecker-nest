/**
 * scripts/link.sh --claude / --cursor / --pi: the supervision skills in each tool's skills directory,
 * the review skill in Claude Code's and Cursor's only, idempotent, and nothing foreign moved or replaced. HOME is a scratch directory with
 * ~/dev/pecker-nest pointing at this checkout. Also checks that Pi's package leaves the skills out.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINK = join(NEST, "scripts/link.sh");
const SKILLS = ["nest-supervise", "nest-handoff"];
/** Not for Pi: there nest's own models would grade nest's work. */
const REVIEW = "nest-review";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratchHome(): string {
	const home = mkdtempSync(join(tmpdir(), "nest-link-"));
	dirs.push(home);
	mkdirSync(join(home, "dev"));
	symlinkSync(NEST, join(home, "dev", "pecker-nest"));
	return home;
}

// --cursor also installs the Cursor adapter, which records the Node it finds (test/cursor-adapter.test.ts).
const link = (home: string, ...args: string[]) =>
	spawnSync(LINK, args, { encoding: "utf-8", env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PI_CODING_AGENT_DIR: join(home, "pi-agent") } });

const skillDirs = (home: string) => ({ claude: join(home, ".claude/skills"), cursor: join(home, ".cursor/skills"), pi: join(home, "pi-agent/skills") });

describe("scripts/link.sh skill links", () => {
	it("links both supervision skills into Claude Code, Cursor and Pi, the review skill not into Pi, and a second run changes nothing", () => {
		const home = scratchHome();
		assert.equal(link(home, "--check", "--claude", "--cursor", "--pi").status, 1);
		const run = link(home, "--claude", "--cursor", "--pi");
		assert.equal(run.status, 0, run.stdout + run.stderr);
		for (const [tool, dir] of Object.entries(skillDirs(home))) {
			const expected = tool === "pi" ? SKILLS : [...SKILLS, REVIEW];
			assert.deepEqual(readdirSync(dir).sort(), [...expected].sort(), dir);
			for (const name of expected) {
				assert.equal(readlinkSync(join(dir, name)), join(NEST, "skills", name));
				assert.match(readFileSync(join(dir, name, "SKILL.md"), "utf-8"), new RegExp(`^---\\nname: ${name}\\n`));
			}
		}
		const again = link(home, "--claude", "--cursor", "--pi");
		assert.equal(again.status, 0);
		assert.doesNotMatch(again.stdout, /^(linked|backup)/m);
		assert.equal(link(home, "--check", "--claude", "--cursor", "--pi").status, 0);
	});

	it("only links the tools it is asked for", () => {
		const home = scratchHome();
		assert.equal(link(home, "--cursor").status, 0);
		assert.ok(existsSync(join(skillDirs(home).cursor, "nest-supervise")));
		assert.ok(existsSync(join(skillDirs(home).cursor, REVIEW)));
		assert.ok(!existsSync(skillDirs(home).claude));
		assert.ok(!existsSync(skillDirs(home).pi));
	});

	it("replaces its own link from before the move and leaves foreign entries alone", () => {
		const home = scratchHome();
		const { claude, cursor } = skillDirs(home);
		mkdirSync(claude, { recursive: true });
		mkdirSync(join(cursor, "nest-handoff"), { recursive: true });
		symlinkSync(join(NEST, "claude/skills/nest-supervise"), join(claude, "nest-supervise"));
		symlinkSync("/elsewhere/nest-handoff", join(claude, "nest-handoff"));
		writeFileSync(join(cursor, "nest-handoff/SKILL.md"), "mine\n");

		const check = link(home, "--check", "--claude", "--cursor");
		assert.equal(check.status, 1);
		assert.match(check.stdout, /^missing .*\/\.claude\/skills\/nest-supervise -> /m);
		assert.match(check.stdout, /^foreign .*\/\.claude\/skills\/nest-handoff is not a link into /m);

		const run = link(home, "--claude", "--cursor");
		assert.equal(run.status, 1, "a foreign entry is reported");
		assert.equal(readlinkSync(join(claude, "nest-supervise")), join(NEST, "skills/nest-supervise"));
		assert.equal(readlinkSync(join(claude, "nest-handoff")), "/elsewhere/nest-handoff");
		assert.equal(readFileSync(join(cursor, "nest-handoff/SKILL.md"), "utf-8"), "mine\n");
		assert.equal(readlinkSync(join(cursor, "nest-supervise")), join(NEST, "skills/nest-supervise"));
		for (const dir of [claude, cursor]) assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".bak.")), [], "no backup that would load as a second skill");
	});

	it("refuses to mix the capture switches with skill links", () => {
		const home = scratchHome();
		for (const flag of ["--cursor", "--pi"]) assert.equal(link(home, "--cursor-capture", flag).status, 2, flag);
	});
});

describe("Pi's package", () => {
	it("leaves the supervision skills out, so only link.sh --pi brings them to Pi", async () => {
		const home = mkdtempSync(join(tmpdir(), "nest-link-pi-"));
		dirs.push(home);
		const settingsManager = SettingsManager.inMemory({ packages: [NEST] }, { projectTrusted: false });
		const resolved = await new DefaultPackageManager({ cwd: home, agentDir: join(home, "agent"), settingsManager }).resolve();
		const names = resolved.skills.filter((skill) => skill.enabled && skill.path.startsWith(join(NEST, "skills"))).map((skill) => basename(dirname(skill.path)));
		assert.deepEqual(names.sort(), ["best-practices", "grill-me", "testing-py", "testing-ts"]);
	});
});
