import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { type CommandRule, globToRegExp, hasGlob, matchingGlob, PROTECT_CONFIG_PATH } from "./protect-config.ts";

/**
 * Pure decision logic for safety-gate.ts. Every check returns a reason string when the
 * action must be blocked and undefined otherwise. The rules err on the side of blocking:
 * a quoted mention such as `echo "rm -rf x"` is blocked too.
 */

const TEMPLATE_ENV_FILES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
const SECRET_FILE_NAMES = new Set([
	".npmrc",
	".pypirc",
	".netrc",
	".git-credentials",
	"auth.json",
	"mcp-auth.json",
	"credentials",
	"credentials.json",
	"id_rsa",
	"id_ecdsa",
	"id_ed25519",
]);
const SECRET_DIRS = new Set([".git", ".ssh", ".aws", ".gnupg"]);
/** Harness configuration: a repo's gate, protection rules and settings, and Pi's agent directory. */
const HARNESS_DIR = ".pi";
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore)$/i;
const SECRET_NAMES = /^(secrets?|\.secrets?)(\..+)?$|\.secrets?$/i;

/**
 * Repository rules from `.pi/protect.json` plus the harness's own directories. Built by
 * safety-gate.ts for each tool call; the rules here stay pure.
 */
export interface PathPolicy {
	/** Repository root: the directory that holds `.pi/`. */
	cwd: string;
	/** Repository-relative globs the agent must not write. */
	write: readonly string[];
	/** Repository-relative globs the agent must neither read nor write. */
	read: readonly string[];
	/** Existing files that match `read`, repository-relative, for wildcard and output checks. */
	readFiles?: readonly string[];
	/** Bash commands the agent must not run. */
	commands?: readonly CommandRule[];
	/** Absolute, canonical directories of the harness itself (this package, Pi's agent directory). */
	harnessDirs: readonly string[];
	/**
	 * Files that configure the harness wherever they lie, as globs over the absolute path without its
	 * leading `/` (lib/harness.ts: CURSOR_HARNESS_FILES). The Cursor adapter sets them; Pi does not.
	 */
	harnessFiles?: readonly string[];
	/** Absolute, canonical directories inside `harnessDirs` that are not harness (Cursor's worktrees). */
	harnessExceptions?: readonly string[];
	/** The agent's name in harness reasons ("change the harness outside pi"); defaults to pi. */
	agent?: string;
	/**
	 * Compare paths, path names and globs without regard to case, as APFS does on macOS: there
	 * `.Cursor/hooks.json` is `.cursor/hooks.json` and `.ENV` is `.env`. Set on macOS by Pi's
	 * safety-gate.ts and the Cursor adapter; off, every comparison is case-sensitive as before.
	 */
	caseInsensitive?: boolean;
	/** Resolves symlinks; defaults to the path itself. */
	canonical?: (absolute: string) => string;
}

function unquote(path: string): string {
	return path.trim().replace(/^["']|["']$/g, "");
}

/** Absolute path for a tool or shell argument, with `~` and `$HOME` expanded. */
function absolutePath(path: string, cwd: string): string {
	const expanded = path.replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir());
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

/** `value` as compared under the policy: lower case when it ignores case. */
function folded(value: string, caseInsensitive: boolean | undefined): string {
	return caseInsensitive ? value.toLowerCase() : value;
}

const outside = (rel: string) => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);

/**
 * `target` relative to `base`, like path.relative. Ignoring case, a target that lies below `base`
 * in another spelling counts as inside, and the result keeps the target's own spelling.
 */
function relativeTo(base: string, target: string, caseInsensitive: boolean | undefined): string {
	const rel = relative(base, target);
	if (!caseInsensitive || !outside(rel)) return rel;
	const loose = relative(base.toLowerCase(), target.toLowerCase());
	if (outside(loose)) return rel;
	return loose === "" ? "" : target.split(sep).slice(-loose.split(sep).length).join(sep);
}

/** Repository-relative `/` path, or undefined when `path` lies outside the repository. */
function repoPath(path: string, policy: PathPolicy): string | undefined {
	const canonical = policy.canonical ?? ((value: string) => value);
	const rel = relativeTo(canonical(policy.cwd), canonical(absolutePath(path, policy.cwd)), policy.caseInsensitive);
	if (rel === "" || outside(rel)) return undefined;
	return rel.split(sep).join("/");
}

function harnessReason(path: string, policy: PathPolicy): string | undefined {
	const canonical = policy.canonical ?? ((value: string) => value);
	const target = canonical(absolutePath(path, policy.cwd));
	const agent = policy.agent ?? "pi";
	const fold = (value: string) => folded(value, policy.caseInsensitive);
	const inside = (candidate: string) => fold(target) === fold(candidate) || fold(target).startsWith(fold(candidate) + sep);
	const dir = policy.harnessExceptions?.some(inside) ? undefined : policy.harnessDirs.find(inside);
	if (dir) return `${path} is part of the agent harness (${dir}); change the harness outside ${agent}`;
	const slashed = target.split(sep).join("/").replace(/^\/+/, "");
	const file = policy.harnessFiles?.find((glob) => globToRegExp(glob, policy.caseInsensitive).test(slashed));
	return file ? `${path} configures the agent harness (${file}); change it outside ${agent}` : undefined;
}

/** Reason why `path` must not be read under the repository's rules, or undefined. */
export function protectedReadReason(path: string, policy: PathPolicy): string | undefined {
	const rel = repoPath(unquote(path), policy);
	const glob = rel === undefined ? undefined : matchingGlob(rel, policy.read, policy.caseInsensitive);
	return glob ? `${rel} is protected by ${PROTECT_CONFIG_PATH} (read: ${glob})` : undefined;
}

/**
 * Reason why a search must not run under `root` with the include glob `glob`, for search tools
 * that cannot remove lines from their output (Cursor's Grep): `root` is read-protected, or an
 * existing read-protected file lies below it and matches the glob, or the glob itself points out of
 * the root (`..`, an absolute path, `~`), so its reach cannot be told from the root. A missing
 * `root` means the repository root; a root above the repository covers all of it. Globs follow
 * ripgrep: without a `/` they match the file name at any depth. Braces, character classes and
 * negations count as matching everything, so the rule errs on the side of blocking.
 */
export function searchReadReason(root: string | undefined, glob: string | undefined, policy: PathPolicy): string | undefined {
	const pattern = glob?.trim();
	if (pattern && (/^[/~$]/.test(pattern) || /(?:^|\/)\.\.(?:\/|$)/.test(pattern))) {
		return `the glob ${pattern} reaches outside the search root; search that folder by its path instead`;
	}
	const start = root === undefined || !unquote(root) ? policy.cwd : unquote(root);
	const direct = protectedReadReason(start, policy);
	if (direct) return direct;
	const files = policy.readFiles ?? [];
	if (!policy.read.length || !files.length) return undefined;
	const canonical = policy.canonical ?? ((value: string) => value);
	const base = canonical(policy.cwd);
	const target = canonical(absolutePath(start, policy.cwd));
	const rel = relativeTo(base, target, policy.caseInsensitive);
	let prefix = "";
	if (outside(rel)) {
		if (outside(relativeTo(target, base, policy.caseInsensitive))) return undefined;
	} else prefix = rel.split(sep).join("/");
	const included = includeMatcher(glob, policy.caseInsensitive);
	const fold = (value: string) => folded(value, policy.caseInsensitive);
	const hit = files.find((file) => {
		if (prefix && fold(file) !== fold(prefix) && !fold(file).startsWith(`${fold(prefix)}/`)) return false;
		return included(prefix ? file.slice(prefix.length + 1) : file, file);
	});
	if (!hit) return undefined;
	const shown = root === undefined || !unquote(root) ? "the repository root" : unquote(root);
	return `a search under ${shown}${glob?.trim() ? ` for ${glob.trim()}` : ""} can reach ${hit}, which is protected by ${PROTECT_CONFIG_PATH} (read); search a narrower path or use a glob that leaves it out`;
}

/** ripgrep's include glob as a test on a file's path below the search root and in the repository. */
function includeMatcher(glob: string | undefined, caseInsensitive?: boolean): (belowRoot: string, inRepo: string) => boolean {
	const cleaned = glob?.trim();
	if (!cleaned || /[{}[\]!]/.test(cleaned)) return () => true;
	const pattern = globToRegExp(cleaned.replace(/^\//, ""), caseInsensitive);
	if (!cleaned.includes("/")) return (belowRoot) => pattern.test(basename(belowRoot));
	return (belowRoot, inRepo) => pattern.test(belowRoot) || pattern.test(inRepo);
}

function policyWriteReason(path: string, policy: PathPolicy): string | undefined {
	const harness = harnessReason(path, policy);
	if (harness) return harness;
	const read = protectedReadReason(path, policy);
	if (read) return read;
	const rel = repoPath(path, policy);
	const glob = rel === undefined ? undefined : matchingGlob(rel, policy.write, policy.caseInsensitive);
	return glob ? `${rel} is protected by ${PROTECT_CONFIG_PATH} (write: ${glob})` : undefined;
}

/**
 * Reason why `path` must not be written, or undefined when it is not protected. Without a policy
 * only the built-in rules apply (secrets, `.env*`, `.git/`, `.pi/`).
 */
export function protectedPathReason(path: string, policy?: PathPolicy): string | undefined {
	const cleaned = unquote(path);
	if (!cleaned) return undefined;
	return builtInPathReason(cleaned, policy?.caseInsensitive) ?? (policy ? policyWriteReason(cleaned, policy) : undefined);
}

function builtInPathReason(cleaned: string, caseInsensitive?: boolean): string | undefined {
	const fold = (value: string) => folded(value, caseInsensitive);
	const segments = cleaned.split(/[\\/]+/).filter(Boolean);
	const name = basename(cleaned);
	if (/^\.env(\..+)?$/.test(fold(name)) && !TEMPLATE_ENV_FILES.has(fold(name))) {
		return `${cleaned} is an environment file and may hold secrets`;
	}
	const secretDir = segments.slice(0, -1).find((segment) => SECRET_DIRS.has(fold(segment)));
	if (secretDir || SECRET_DIRS.has(fold(name))) {
		return `${cleaned} is inside ${secretDir ?? name}/, which is protected`;
	}
	if (SECRET_FILE_NAMES.has(fold(name)) || SECRET_EXTENSIONS.test(name) || SECRET_NAMES.test(name)) {
		return `${cleaned} looks like a credential or secret file`;
	}
	if (segments.some((segment) => fold(segment) === HARNESS_DIR)) {
		return `${cleaned} is inside ${HARNESS_DIR}/, the harness configuration (gate, protection rules, settings); the user changes it`;
	}
	return undefined;
}

/** In plan mode only PLAN.md in the working directory may be written. */
export function planModeReason(path: string, cwd: string): string | undefined {
	const target = isAbsolute(path) ? path : resolve(cwd, path);
	if (target === resolve(cwd, "PLAN.md")) return undefined;
	const shown = relative(cwd, target) || path;
	return `/plan only writes PLAN.md; ${shown.startsWith(`..${sep}`) ? target : shown} must stay unchanged`;
}

/** Whether the raw user input starts the /plan prompt template. */
export function isPlanCommand(text: string): boolean {
	return /^\/plan(\s|$)/.test(text.trimStart());
}

const SHELLS = "(?:ba|z|da|k|fi)?sh";
const INTERPRETERS = `(?:${SHELLS}|python[0-9.]*|node|perl|ruby)`;
const DOWNLOAD_INTO_SHELL = [
	// curl … | sh, wget -qO- … | sudo bash, curl … | python3 -
	new RegExp(`\\b(?:curl|wget)\\b[^;&\\n]*\\|\\s*(?:sudo\\s+(?:-\\S+\\s+)*)?(?:env\\s+)?${INTERPRETERS}\\b`),
	// sh <(curl …), source <(wget …), . <(curl …)
	new RegExp(`(?:\\b${SHELLS}|\\bsource|(?:^|[\\s;&|])\\.)\\s+(?:-\\S+\\s+)*<\\(\\s*(?:curl|wget)\\b`),
	// bash -c "$(curl …)", bash -lc "$(curl …)", eval "$(wget …)"
	new RegExp(`(?:\\b${SHELLS}\\s+-[A-Za-z]*c[A-Za-z]*|\\beval)\\s+\\$\\(\\s*(?:curl|wget)\\b`),
];

/** Wrappers that run the command that follows them. */
const PASS_THROUGH = new Set(["sudo", "doas", "command", "exec", "nohup", "time", "env", "xargs", "nice", "timeout", "stdbuf"]);
/** Git global options that take a separate value: `git -C dir push`. */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
/** Commands whose every path argument is written, moved or deleted. */
const WRITES_ALL_ARGS = new Set(["tee", "mv", "rm", "shred", "truncate", "unlink", "chmod", "chown"]);
/** Commands whose last path argument is the destination. */
const WRITES_LAST_ARG = new Set(["cp", "install", "ln", "rsync"]);

/**
 * Split a shell command into simple-command word lists. Quotes are dropped so the text of
 * `bash -c "…"` is analyzed as commands too.
 */
export function splitCommands(command: string): string[][] {
	const unquoted = command.replace(/\\\n/g, " ").replace(/["']/g, " ");
	return unquoted
		.split(/&&|\|\||[;|&\n()`{}]|\$\(/)
		.map((segment) => segment.trim().split(/\s+/).filter(Boolean))
		.filter((words) => words.length > 0);
}

/**
 * Drop leading `VAR=value` assignments and wrappers such as sudo, env or xargs. Ignoring case, `ENV`
 * is a wrapper too: on macOS's file system the shell finds `/usr/bin/env` under that name.
 */
function stripWrappers(words: string[], caseInsensitive?: boolean): string[] {
	let index = 0;
	while (index < words.length) {
		const word = words[index];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			index++;
			continue;
		}
		if (PASS_THROUGH.has(folded(basename(word), caseInsensitive))) {
			index++;
			// Skip the wrapper's own options, e.g. `sudo -u root`, `timeout 10`, `xargs -0`.
			while (index < words.length && (words[index].startsWith("-") || /^\d+[smhd]?$/.test(words[index]))) {
				const option = words[index];
				index++;
				if ((option === "-u" || option === "-g") && index < words.length) index++;
			}
			continue;
		}
		break;
	}
	return words.slice(index);
}

function hasShortFlag(args: string[], letter: string): boolean {
	return args.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.includes(letter));
}

function rmReason(args: string[]): string | undefined {
	const options = args.slice(0, args.includes("--") ? args.indexOf("--") : args.length);
	const recursive = hasShortFlag(options, "r") || hasShortFlag(options, "R") || options.includes("--recursive");
	const force = hasShortFlag(options, "f") || options.includes("--force");
	if (recursive && force) return "recursive forced delete (rm -rf) is blocked";
	const targets = args.filter((arg) => !arg.startsWith("-"));
	const dangerous = targets.find((target) => /^(\/|~\/?|\$HOME\/?|\.\.?\/?|\*|\/\*)$/.test(target));
	if (recursive && dangerous) return `recursive delete of ${dangerous} is blocked`;
	return undefined;
}

function gitReason(args: string[]): string | undefined {
	let index = 0;
	while (index < args.length && args[index].startsWith("-")) {
		index += GIT_OPTIONS_WITH_VALUE.has(args[index]) ? 2 : 1;
	}
	const subcommand = args[index];
	const rest = args.slice(index + 1);
	switch (subcommand) {
		case "push":
			return "git push is blocked; the user pushes";
		case "reset":
			return rest.includes("--hard") ? "git reset --hard discards work and is blocked" : undefined;
		case "clean":
			return hasShortFlag(rest, "f") || rest.includes("--force")
				? "git clean -f deletes untracked files and is blocked"
				: undefined;
		default:
			return undefined;
	}
}

function pathArgs(args: string[]): string[] {
	return args.filter((arg) => !arg.startsWith("-"));
}

function writeTargetReason(program: string, args: string[], policy?: PathPolicy): string | undefined {
	let targets: string[] = [];
	if (WRITES_ALL_ARGS.has(program)) targets = pathArgs(args);
	else if (WRITES_LAST_ARG.has(program)) targets = pathArgs(args).slice(-1);
	else if ((program === "sed" || program === "perl") && args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith("--in-place"))) {
		targets = pathArgs(args);
	} else if (program === "dd") {
		targets = args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3));
	}
	for (const target of targets) {
		const reason = protectedPathReason(target, policy);
		if (reason) return `${program} would modify ${reason}`;
	}
	return undefined;
}

function redirectReason(command: string, policy?: PathPolicy): string | undefined {
	const unquoted = command.replace(/["']/g, "");
	for (const match of unquoted.matchAll(/(?:&>>?|\d?>>?\|?)\s*([^\s;&|<>()]+)/g)) {
		const target = match[1];
		if (target.startsWith("&") || target === "/dev/null") continue;
		const reason = protectedPathReason(target, policy);
		if (reason) return `redirect would write ${reason}`;
	}
	return undefined;
}

/**
 * Whether any word of the command names a read-protected file: directly, through a wildcard that
 * matches an existing protected file, or by the bare file name. A tripwire against reading the
 * files by accident, not a sandbox: `cd dir && cat "$(ls)"` gets through, and safety-gate.ts
 * also removes protected paths from tool output.
 */
function readReason(command: string, policy: PathPolicy): string | undefined {
	if (!policy.read.length) return undefined;
	const files = policy.readFiles ?? [];
	const fold = (value: string) => folded(value, policy.caseInsensitive);
	const names = new Set(files.map((file) => fold(basename(file))));
	for (const word of splitCommands(command).flat()) {
		for (const candidate of [word, word.slice(word.indexOf("=") + 1), word.replace(/^[@<]+/, "")]) {
			if (!candidate || !/[./*?]/.test(candidate)) continue;
			if (hasGlob(candidate)) {
				const rel = repoPath(candidate, policy);
				const pattern = rel === undefined ? undefined : globToRegExp(rel, policy.caseInsensitive);
				const hit = pattern && files.find((file) => pattern.test(file));
				if (hit) return `the command would read ${hit}, which is protected by ${PROTECT_CONFIG_PATH}`;
				continue;
			}
			const reason = protectedReadReason(candidate, policy);
			if (reason) return `the command would read ${reason}`;
			if (!candidate.includes("/") && names.has(fold(candidate))) {
				return `the command names ${candidate}, a file protected by ${PROTECT_CONFIG_PATH}`;
			}
		}
	}
	return undefined;
}

function commandRuleReason(command: string, rules: readonly CommandRule[]): string | undefined {
	const unquoted = command.replace(/["']/g, "");
	const rule = rules.find((candidate) => candidate.pattern.test(unquoted));
	return rule ? `${rule.reason} (${PROTECT_CONFIG_PATH})` : undefined;
}

/** Reason why a bash command must not run, or undefined when it may run. */
export function bashCommandReason(command: string, policy?: PathPolicy): string | undefined {
	const unquoted = command.replace(/["']/g, "");
	if (DOWNLOAD_INTO_SHELL.some((pattern) => pattern.test(unquoted))) {
		return "piping a download into a shell or interpreter is blocked";
	}
	if (policy) {
		const rule = commandRuleReason(command, policy.commands ?? []);
		if (rule) return rule;
	}
	const redirect = redirectReason(command, policy);
	if (redirect) return redirect;
	for (const words of splitCommands(command)) {
		// `find … -exec rm -rf {} ;` runs a second command inside the first.
		const execAt = words.findIndex((word) => word === "-exec" || word === "-execdir" || word === "-ok");
		const candidates = execAt >= 0 ? [words, words.slice(execAt + 1)] : [words];
		for (const candidate of candidates) {
			const reason = simpleCommandReason(candidate, policy);
			if (reason) return reason;
		}
	}
	return policy ? readReason(command, policy) : undefined;
}

function simpleCommandReason(words: string[], policy?: PathPolicy): string | undefined {
	const [first, ...args] = stripWrappers(words, policy?.caseInsensitive);
	if (!first) return undefined;
	// Ignoring case, `RM` and `GIT` are rm and git: the shell finds them under any spelling.
	const program = folded(basename(first), policy?.caseInsensitive);
	// `bash -c "…"`, `sh -lc "…"`, `zsh -ic "…"` and `eval …` run their arguments as a command.
	const commandAt = new RegExp(`^${SHELLS}$`).test(program) ? args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg)) : -1;
	if (commandAt >= 0) return simpleCommandReason(args.slice(commandAt + 1), policy);
	if (program === "eval") return simpleCommandReason(args, policy);
	return (
		(program === "rm" ? rmReason(args) : undefined) ??
		(program === "git" ? gitReason(args) : undefined) ??
		writeTargetReason(program, args, policy)
	);
}

/**
 * `text` without the lines that mention a read-protected file (grep matches, find results,
 * `git grep` output), plus how many lines were removed. Files are matched by name, because tools
 * print paths relative to where they searched (`samples/holdout.jsonl:7:` for `grep x evals`).
 */
export function redactProtectedLines(text: string, files: readonly string[]): { text: string; removed: number } {
	const names = [...new Set(files.map((file) => basename(file)).filter(Boolean))];
	if (!names.length) return { text, removed: 0 };
	const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const pattern = new RegExp(`(?:^|[\\s/\\\\'"=:])(?:${escaped.join("|")})(?=$|[\\s:'",)-])`);
	let removed = 0;
	const kept = text.split("\n").filter((line) => {
		const hit = pattern.test(line);
		if (hit) removed++;
		return !hit;
	});
	return { text: kept.join("\n"), removed };
}
