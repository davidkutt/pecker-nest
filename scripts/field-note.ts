/**
 * Facts for the field notes of supervised sessions (claude/skills/nest-supervise, nest-handoff),
 * read from the repository instead of typed by hand. A before-and-after comparison of two sessions
 * is only valid when the note says exactly which configuration ran.
 *
 *   node scripts/field-note.ts config                 # the "Config under test" line
 *   node scripts/field-note.ts config --repo <name>   # … plus how it compares to that repository's previous note
 *   node scripts/field-note.ts open --repo <name>     # path of the repository's open note (no end HEAD yet)
 *   … --json                                          # machine-readable
 *   … --notes <dir>                                   # another notes folder than field-notes/
 *
 * `config` reads the pecker-nest commit, whether the checkout has uncommitted changes, the Pi
 * version, the thinking level per router tier and the default strong model
 * (extensions/lib/router-logic.ts), and model and thinking level per subagent role
 * (agent/agents/*.md). `open` exits with 1 when the repository has no open note. Nothing is
 * written, and no request is made.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_STRONG, FLASH, levelFor, PROVIDER, STRONG_MODELS } from "../extensions/lib/router-logic.ts";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- config under test

export interface Role {
	name: string;
	/** Model as the role file names it, e.g. `openrouter/z-ai/glm-5.3`. */
	model: string;
	thinking: string;
}

export interface ConfigUnderTest {
	/** Short commit of the pecker-nest checkout. */
	commit: string;
	/** The checkout has uncommitted changes: what ran is not exactly this commit. */
	dirty: boolean;
	piVersion: string;
	/** Thinking level of the router's tiers. */
	flashLevel: string;
	strongLevel: string;
	/** The strong model the router calls in unless `/strong` picks another. */
	strong: string;
	roles: Role[];
}

/** `name`, `model` and `thinking` from the front matter of a subagent role file. */
export function parseRole(markdown: string): Role | undefined {
	const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
	if (!frontMatter) return undefined;
	const field = (name: string) => new RegExp(`^${name}:\\s*(.+?)\\s*$`, "m").exec(frontMatter)?.[1];
	const name = field("name");
	if (!name) return undefined;
	return { name, model: field("model") ?? "?", thinking: field("thinking") ?? "?" };
}

const MODEL_NAMES: Record<string, string> = {
	[`${PROVIDER}/${FLASH}`]: "Flash",
	...Object.fromEntries(Object.values(STRONG_MODELS).map((model) => [`${PROVIDER}/${model.id}`, model.name])),
};

/** A short display name for a configured model; unknown models keep their ID. */
export function modelName(model: string): string {
	return MODEL_NAMES[model] ?? model;
}

function run(command: string, args: string[], cwd?: string): string | undefined {
	try {
		return execFileSync(command, args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
}

export function readConfig(nestDir = NEST, piVersion = run("pi", ["--version"])?.split("\n").at(-1)): ConfigUnderTest {
	const agents = join(nestDir, "agent/agents");
	const roles = existsSync(agents)
		? readdirSync(agents)
				.filter((file) => file.endsWith(".md"))
				.sort()
				.flatMap((file) => parseRole(readFileSync(join(agents, file), "utf-8")) ?? [])
		: [];
	return {
		commit: run("git", ["-C", nestDir, "rev-parse", "--short", "HEAD"]) ?? "unknown",
		dirty: Boolean(run("git", ["-C", nestDir, "status", "--porcelain"])),
		piVersion: piVersion || "unknown",
		flashLevel: levelFor("flash", "default"),
		strongLevel: levelFor("strong", "gate"),
		strong: STRONG_MODELS[DEFAULT_STRONG].name,
		roles,
	};
}

/** The line for the field note's Session section. */
export function renderConfig(config: ConfigUnderTest): string {
	const roles = config.roles.map((role) => `${role.name} ${modelName(role.model)} ${role.thinking}`).join(", ");
	return [
		`pecker-nest ${config.commit}${config.dirty ? " with uncommitted changes" : ""}, Pi ${config.piVersion}`,
		`router/escalate: Flash ${config.flashLevel}, strong model ${config.strong} ${config.strongLevel}`,
		`roles: ${roles || "none found"}`,
	].join("; ");
}

// ---------------------------------------------------------------- field notes

/** The value of a `- Label: value` line of the note's Session section. */
function sessionField(note: string, label: RegExp): string | undefined {
	const section = /^## Session\s*$([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(note)?.[1] ?? note;
	for (const line of section.split("\n")) {
		const match = /^\s*-\s*([^:]+):\s*(.*)$/.exec(line);
		if (match && label.test(match[1])) return match[2].replace(/<!--[\s\S]*?-->/g, "").trim();
	}
	return undefined;
}

/** The repository a note names in `Repository / branch: <repo> / <branch>`, as a directory name. */
export function repositoryOf(note: string): string | undefined {
	const value = sessionField(note, /^repository/i)?.split(" / ")[0].replace(/[`*]/g, "").trim().replace(/\/+$/, "");
	return value ? value.slice(value.lastIndexOf("/") + 1) || undefined : undefined;
}

/**
 * Field notes of a repository (`<YYYY-MM-DD>-<repo>-<slug>.md`), newest first. The file name
 * alone cannot tell `undertext` from `undertext-web`, so a note that names another repository in
 * its Session section is left out.
 */
export function notesFor(notesDir: string, repo: string): string[] {
	if (!existsSync(notesDir)) return [];
	const prefix = /^\d{4}-\d{2}-\d{2}-/;
	return readdirSync(notesDir)
		.filter((name) => name.endsWith(".md") && prefix.test(name) && name.slice(11).startsWith(`${repo}-`))
		.map((name) => join(notesDir, name))
		.filter((file) => (repositoryOf(readFileSync(file, "utf-8")) ?? repo) === repo)
		.sort((a, b) => basename(b).slice(0, 10).localeCompare(basename(a).slice(0, 10)) || statSync(b).mtimeMs - statSync(a).mtimeMs);
}

/**
 * A note is open while its Session section has no end HEAD: the session it describes is still
 * running, perhaps over several days. A note without the line counts as closed.
 */
export function isOpen(note: string): boolean {
	const heads = sessionField(note, /start head/i);
	if (heads === undefined) return false;
	const end = heads.split(/→|->/)[1] ?? "";
	return !/\b[0-9a-f]{7,40}\b/.test(end);
}

/** The pecker-nest commit a note records in its Session section. */
export function nestCommitOf(note: string): string | undefined {
	const line = sessionField(note, /config under test|setup/i) ?? "";
	return /pecker-nest\s+`?([0-9a-f]{7,40})\b/.exec(line)?.[1];
}

/** The repository's open note: the newest one without an end HEAD. */
export function openNote(notesDir: string, repo: string): string | undefined {
	return notesFor(notesDir, repo).find((file) => isOpen(readFileSync(file, "utf-8")));
}

export interface Comparison {
	/** The previous note of the repository, if there is one. */
	previous?: string;
	previousCommit?: string;
	/** Undefined when there is nothing to compare with. */
	differs?: boolean;
}

/** Compares a commit with the one the repository's previous note records. `skip` is the note being written. */
export function compareWithPrevious(notesDir: string, repo: string, commit: string, skip?: string): Comparison {
	const previous = notesFor(notesDir, repo).find((file) => !skip || resolve(file) !== resolve(skip));
	if (!previous) return {};
	const previousCommit = nestCommitOf(readFileSync(previous, "utf-8"));
	if (!previousCommit) return { previous };
	const length = Math.min(previousCommit.length, commit.length);
	return { previous, previousCommit, differs: previousCommit.slice(0, length) !== commit.slice(0, length) };
}

export function renderComparison(comparison: Comparison): string {
	if (!comparison.previous) return "no previous note for this repository: nothing to compare with";
	const name = basename(comparison.previous);
	if (!comparison.previousCommit) return `the previous note (${name}) records no pecker-nest commit: nothing to compare with`;
	return comparison.differs
		? `pecker-nest commit differs from the previous note (${name}: ${comparison.previousCommit})`
		: `same pecker-nest commit as the previous note (${name})`;
}

// ---------------------------------------------------------------- CLI

function main(argv: string[]): number {
	const [command, ...rest] = argv;
	let repo: string | undefined;
	let notesDir = join(NEST, "field-notes");
	let skip: string | undefined;
	let json = false;
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "--repo") repo = rest[++index];
		else if (arg === "--notes") notesDir = resolve(rest[++index] ?? "");
		else if (arg === "--skip") skip = resolve(rest[++index] ?? "");
		else if (arg === "--json") json = true;
		else {
			console.error(`field-note.ts: unknown argument ${arg}`);
			return 2;
		}
	}
	if (command === "config") {
		const config = readConfig();
		const comparison = repo ? compareWithPrevious(notesDir, repo, config.commit, skip ?? openNote(notesDir, repo)) : undefined;
		if (json) console.log(JSON.stringify({ config, ...(comparison ? { comparison } : {}) }, null, 2));
		else {
			console.log(`- Config under test: ${renderConfig(config)}`);
			if (comparison) console.log(`- Compared with the previous note: ${renderComparison(comparison)}`);
		}
		return 0;
	}
	if (command === "open") {
		if (!repo) {
			console.error("field-note.ts open: --repo <name> is required");
			return 2;
		}
		const file = openNote(notesDir, repo);
		if (json) console.log(JSON.stringify({ open: file ?? null }));
		else if (file) console.log(file);
		else console.error(`no open field note for ${repo} in ${notesDir}`);
		return file ? 0 : 1;
	}
	console.error("usage: field-note.ts config [--repo <name>] | open --repo <name>   [--notes <dir>] [--skip <note>] [--json]");
	return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
