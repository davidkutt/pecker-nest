import { basename, isAbsolute, relative, resolve, sep } from "node:path";

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
const SECRET_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore)$/i;
const SECRET_NAMES = /^(secrets?|\.secrets?)(\..+)?$|\.secrets?$/i;

/** Reason why `path` must not be written, or undefined when it is not protected. */
export function protectedPathReason(path: string): string | undefined {
	const cleaned = path.trim().replace(/^["']|["']$/g, "");
	if (!cleaned) return undefined;
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

function writeTargetReason(program: string, args: string[]): string | undefined {
	let targets: string[] = [];
	if (WRITES_ALL_ARGS.has(program)) targets = pathArgs(args);
	else if (WRITES_LAST_ARG.has(program)) targets = pathArgs(args).slice(-1);
	else if ((program === "sed" || program === "perl") && args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith("--in-place"))) {
		targets = pathArgs(args);
	} else if (program === "dd") {
		targets = args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3));
	}
	for (const target of targets) {
		const reason = protectedPathReason(target);
		if (reason) return `${program} would modify ${reason}`;
	}
	return undefined;
}

function redirectReason(command: string): string | undefined {
	const unquoted = command.replace(/["']/g, "");
	for (const match of unquoted.matchAll(/(?:&>>?|\d?>>?\|?)\s*([^\s;&|<>()]+)/g)) {
		const target = match[1];
		if (target.startsWith("&") || target === "/dev/null") continue;
		const reason = protectedPathReason(target);
		if (reason) return `redirect would write ${reason}`;
	}
	return undefined;
}

/** Reason why a bash command must not run, or undefined when it may run. */
export function bashCommandReason(command: string): string | undefined {
	const unquoted = command.replace(/["']/g, "");
	if (DOWNLOAD_INTO_SHELL.some((pattern) => pattern.test(unquoted))) {
		return "piping a download into a shell or interpreter is blocked";
	}
	const redirect = redirectReason(command);
	if (redirect) return redirect;
	for (const words of splitCommands(command)) {
		// `find … -exec rm -rf {} ;` runs a second command inside the first.
		const execAt = words.findIndex((word) => word === "-exec" || word === "-execdir" || word === "-ok");
		const candidates = execAt >= 0 ? [words, words.slice(execAt + 1)] : [words];
		for (const candidate of candidates) {
			const reason = simpleCommandReason(candidate);
			if (reason) return reason;
		}
	}
	return undefined;
}

function simpleCommandReason(words: string[]): string | undefined {
	const [first, ...args] = stripWrappers(words);
	if (!first) return undefined;
	const program = basename(first);
	// `bash -c "…"` and `eval …` run their arguments as a command.
	const commandAt = new RegExp(`^${SHELLS}$`).test(program) ? args.indexOf("-c") : -1;
	if (commandAt >= 0) return simpleCommandReason(args.slice(commandAt + 1));
	if (program === "eval") return simpleCommandReason(args);
	return (
		(program === "rm" ? rmReason(args) : undefined) ??
		(program === "git" ? gitReason(args) : undefined) ??
		writeTargetReason(program, args)
	);
}
