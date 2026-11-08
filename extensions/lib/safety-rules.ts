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

/** Repository-relative `/` path, or undefined when `path` lies outside the repository. */
function repoPath(path: string, policy: PathPolicy): string | undefined {
	const canonical = policy.canonical ?? ((value: string) => value);
	const rel = relative(canonical(policy.cwd), canonical(absolutePath(path, policy.cwd)));
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
	return rel.split(sep).join("/");
}

function harnessReason(path: string, policy: PathPolicy): string | undefined {
	const canonical = policy.canonical ?? ((value: string) => value);
	const target = canonical(absolutePath(path, policy.cwd));
	const dir = policy.harnessDirs.find((candidate) => target === candidate || target.startsWith(candidate + sep));
	return dir ? `${path} is part of the agent harness (${dir}); change the harness outside pi` : undefined;
}

/** Reason why `path` must not be read under the repository's rules, or undefined. */
export function protectedReadReason(path: string, policy: PathPolicy): string | undefined {
	const rel = repoPath(unquote(path), policy);
	const glob = rel === undefined ? undefined : matchingGlob(rel, policy.read);
	return glob ? `${rel} is protected by ${PROTECT_CONFIG_PATH} (read: ${glob})` : undefined;
}

function policyWriteReason(path: string, policy: PathPolicy): string | undefined {
	const harness = harnessReason(path, policy);
	if (harness) return harness;
	const read = protectedReadReason(path, policy);
	if (read) return read;
	const rel = repoPath(path, policy);
	const glob = rel === undefined ? undefined : matchingGlob(rel, policy.write);
	return glob ? `${rel} is protected by ${PROTECT_CONFIG_PATH} (write: ${glob})` : undefined;
}

/**
 * Reason why `path` must not be written, or undefined when it is not protected. Without a policy
 * only the built-in rules apply (secrets, `.env*`, `.git/`, `.pi/`).
 */
export function protectedPathReason(path: string, policy?: PathPolicy): string | undefined {
	const cleaned = unquote(path);
	if (!cleaned) return undefined;
	return builtInPathReason(cleaned) ?? (policy ? policyWriteReason(cleaned, policy) : undefined);
}

function builtInPathReason(cleaned: string): string | undefined {
	const segments = cleaned.split(/[\\/]+/).filter(Boolean);
	const name = basename(cleaned);
	if (/^\.env(\..+)?$/.test(name) && !TEMPLATE_ENV_FILES.has(name)) {
		return `${cleaned} is an environment file and may hold secrets`;
	}
	const secretDir = segments.slice(0, -1).find((segment) => SECRET_DIRS.has(segment));
	if (secretDir || SECRET_DIRS.has(name)) {
		return `${cleaned} is inside ${secretDir ?? name}/, which is protected`;
	}
	if (SECRET_FILE_NAMES.has(name) || SECRET_EXTENSIONS.test(name) || SECRET_NAMES.test(name)) {
		return `${cleaned} looks like a credential or secret file`;
	}
	if (segments.includes(HARNESS_DIR)) {
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
	// bash -c "$(curl …)", eval "$(wget …)"
	new RegExp(`(?:\\b${SHELLS}\\s+-c|\\beval)\\s+\\$\\(\\s*(?:curl|wget)\\b`),
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

/** Drop leading `VAR=value` assignments and wrappers such as sudo, env or xargs. */
function stripWrappers(words: string[]): string[] {
	let index = 0;
	while (index < words.length) {
		const word = words[index];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			index++;
			continue;
		}
		if (PASS_THROUGH.has(basename(word))) {
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
	const names = new Set(files.map((file) => basename(file)));
	for (const word of splitCommands(command).flat()) {
		for (const candidate of [word, word.slice(word.indexOf("=") + 1), word.replace(/^[@<]+/, "")]) {
			if (!candidate || !/[./*?]/.test(candidate)) continue;
			if (hasGlob(candidate)) {
				const rel = repoPath(candidate, policy);
				const pattern = rel === undefined ? undefined : globToRegExp(rel);
				const hit = pattern && files.find((file) => pattern.test(file));
				if (hit) return `the command would read ${hit}, which is protected by ${PROTECT_CONFIG_PATH}`;
				continue;
			}
			const reason = protectedReadReason(candidate, policy);
			if (reason) return `the command would read ${reason}`;
			if (!candidate.includes("/") && names.has(candidate)) {
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
	const [first, ...args] = stripWrappers(words);
	if (!first) return undefined;
	const program = basename(first);
	// `bash -c "…"` and `eval …` run their arguments as a command.
	const commandAt = new RegExp(`^${SHELLS}$`).test(program) ? args.indexOf("-c") : -1;
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
