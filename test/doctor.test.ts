/**
 * scripts/doctor.sh against stub tools: `pi`, `node`, `pnpm`, `uv`, `docker`, `security` and `gh`
 * on PATH answer as the test says, HOME is a scratch directory with ~/dev/pecker-nest pointing at
 * this checkout. Nothing here needs Pi, Docker, a Keychain, GitHub or a key. The `docker` stub
 * records its calls, so the tests can tell that Docker is not asked without `--docker`. `git` is
 * the real one behind a stub that records its calls; the notes checkouts of scripts/kb-sources.sh
 * are real repositories whose GitHub origin git rewrites to a local bare repository.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { FLASH, GLM, KIMI } from "../extensions/lib/router-logic.ts";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCTOR = join(NEST, "scripts/doctor.sh");
const HEAD = spawnSync("git", ["-C", NEST, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
const PI_VERSION = JSON.parse(readFileSync(join(NEST, "package.json"), "utf-8")).devDependencies["@earendil-works/pi-coding-agent"] as string;
const SECRET = "sk-or-interactive-secret";
const KB_SOURCES = join(NEST, "scripts/kb-sources.sh");
const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).stdout.trim();

/** What \`pi mcp list --json\` prints for the knowledge base in a given state. */
function mcpList(state: string, extra: Record<string, unknown> = {}): string {
	const tools = state === "connected" ? ["search_knowledge_base", "get_document", "list_sources", "ingest_url"] : [];
	return JSON.stringify({ servers: [{ name: "kb", scope: "global", enabled: true, exposure: "deferred", transport: "http://localhost:8000/mcp", state, tools, ...extra }], errors: [] });
}

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const STUBS: Record<string, string> = {
	pi: `#!/usr/bin/env bash
case "$1" in
  --version) echo "$STUB_PI_VERSION" ;;
  auth)
    [[ "$*" == "auth check --provider openrouter" ]] || { echo "pi stub: unexpected $*" >&2; exit 2; }
    if [[ "$STUB_PI_LOGIN" == 1 || -n "\${OPENROUTER_API_KEY:-}" ]]; then echo ready; exit 0; fi
    echo not_ready; exit 1 ;;
  mcp)
    [[ "$*" == "mcp list --json" ]] || { echo "pi stub: unexpected $*" >&2; exit 2; }
    printf '%s\\n' "$*" >> "$STUB_DIR/pi-mcp-calls"
    echo "$STUB_PI_MCP"
    [[ "$STUB_PI_MCP" == *'"state":"connected"'* ]]; exit ;;
  --list-models)
    echo "provider    model    context  max-out  thinking  images"
    echo "anthropic   $STUB_FOREIGN_MODEL    200K  64K  yes  yes"
    for id in $STUB_PI_MODELS; do echo "openrouter  $id  1.0M  128K  yes  yes"; done ;;
  *) echo "pi stub: unexpected $*" >&2; exit 2 ;;
esac
`,
	node: `#!/usr/bin/env bash
if [[ "$1" == --version ]]; then echo "$STUB_NODE_VERSION"; exit 0; fi
exec "$STUB_REAL_NODE" "$@"
`,
	pnpm: `#!/usr/bin/env bash
echo "$STUB_PNPM_VERSION"
`,
	uv: `#!/usr/bin/env bash
echo "uv 0.13.6"
`,
	docker: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/docker-calls"
if [[ "$1" == info ]]; then [[ "$STUB_DOCKER_UP" == 1 ]]; exit; fi
if [[ "$1 $2" == "image inspect" ]]; then
  [[ -n "$STUB_IMAGE_LABELS" ]] || { echo "Error response from daemon: No such image" >&2; exit 1; }
  echo "$STUB_IMAGE_LABELS"
  exit 0
fi
echo "docker stub: unexpected $*" >&2
exit 1
`,
	security: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/security-calls"
[[ "$1" == find-generic-password && "$STUB_KEYCHAIN_ITEM" == 1 ]] && { echo "keychain: \\"login.keychain-db\\""; exit 0; }
exit 44
`,
	// The real git, with its calls recorded; STUB_GIT_HANG=1 makes ls-remote hang like a dead network.
	git: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/git-calls"
if [[ "\${STUB_GIT_HANG:-0}" == 1 && " $* " == *" ls-remote "* ]]; then exec sleep 30; fi
exec "\${STUB_REAL_GIT:-/usr/bin/git}" "$@"
`,
	// Only the read-only call of scripts/kb-sources.sh; open pull requests from ~/gh-prs/<owner>_<repo>.json.
	gh: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/gh-calls"
[[ "$1 $2 $3 $5 $6 $7 $8" == "pr list --repo --state open --json number,title,headRefName" && $# -eq 8 ]] || { echo "gh stub: unexpected $*" >&2; exit 2; }
[[ "$STUB_GH_AUTH" == 1 ]] || { echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4; }
file="$STUB_DIR/gh-prs/\${4//\\//_}.json"
if [[ -f "$file" ]]; then cat "$file"; else echo "[]"; fi
`,
};

/**
 * The system tools from /usr/bin and /bin, linked into one directory without the programs the
 * stubs stand in for. macOS ships /usr/bin/security, so with /usr/bin itself on PATH a test that
 * leaves the `security` stub out would reach the real Keychain instead of finding no Keychain.
 */
const SYSTEM = mkdtempSync(join(tmpdir(), "nest-doctor-system-"));
dirs.push(SYSTEM);
for (const source of ["/usr/bin", "/bin"]) {
	for (const name of readdirSync(source)) {
		if (name in STUBS || existsSync(join(SYSTEM, name))) continue;
		symlinkSync(join(source, name), join(SYSTEM, name));
	}
}

interface Options {
	env?: Record<string, string>;
	/** Stub tools to leave out, so the tool is "not installed". */
	without?: string[];
	/** Link the agent files into the scratch HOME first, as scripts/link.sh --claude does. */
	linked?: boolean;
	/** Put the repo at ~/dev/pecker-nest in the scratch HOME. */
	atExpectedPath?: boolean;
	/** Runs after the links, with the scratch HOME and the environment doctor gets. */
	setup?: (home: string, env: Record<string, string>) => void;
	args?: string[];
	/** The script to run instead of doctor.sh. */
	script?: string;
}

function doctor(options: Options = {}) {
	const dir = mkdtempSync(join(tmpdir(), "nest-doctor-"));
	dirs.push(dir);
	const bin = join(dir, "bin");
	mkdirSync(bin);
	for (const [name, script] of Object.entries(STUBS)) {
		if (options.without?.includes(name)) continue;
		writeFileSync(join(bin, name), script);
		chmodSync(join(bin, name), 0o755);
	}
	const env = {
		// Only the stubs and the system tools: the real pi, node, pnpm, uv, docker and security are
		// not on this PATH.
		PATH: `${bin}:${SYSTEM}`,
		HOME: dir,
		USER: "tester",
		STUB_DIR: dir,
		STUB_REAL_NODE: process.execPath,
		STUB_PI_VERSION: PI_VERSION,
		STUB_PI_LOGIN: "1",
		STUB_PI_MODELS: `${FLASH} ${GLM} ${KIMI}`,
		STUB_FOREIGN_MODEL: "claude-x",
		STUB_PI_MCP: mcpList("connected"),
		STUB_NODE_VERSION: "v22.18.0",
		STUB_PNPM_VERSION: "10.34.9",
		STUB_DOCKER_UP: "1",
		STUB_IMAGE_LABELS: `${HEAD}|0`,
		STUB_KEYCHAIN_ITEM: "1",
		STUB_REAL_GIT: REAL_GIT,
		STUB_GH_AUTH: "1",
		...options.env,
	};
	if (options.atExpectedPath !== false) {
		mkdirSync(join(dir, "dev"));
		symlinkSync(NEST, join(dir, "dev/pecker-nest"));
		if (options.linked !== false) {
			const link = spawnSync(join(NEST, "scripts/link.sh"), ["--claude"], { encoding: "utf-8", env: { PATH: env.PATH, HOME: dir } });
			assert.equal(link.status, 0, link.stderr);
		}
	}
	options.setup?.(dir, env);
	const result = spawnSync(options.script ?? DOCTOR, options.args ?? [], { encoding: "utf-8", env });
	const lines = result.stdout.trimEnd().split("\n");
	const securityCalls = existsSync(join(dir, "security-calls")) ? readFileSync(join(dir, "security-calls"), "utf-8") : "";
	const dockerCalls = existsSync(join(dir, "docker-calls")) ? readFileSync(join(dir, "docker-calls"), "utf-8") : "";
	const gitCalls = existsSync(join(dir, "git-calls")) ? readFileSync(join(dir, "git-calls"), "utf-8") : "";
	const ghCalls = existsSync(join(dir, "gh-calls")) ? readFileSync(join(dir, "gh-calls"), "utf-8") : "";
	return {
		dir,
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		lines,
		securityCalls,
		dockerCalls,
		gitCalls,
		ghCalls,
		/** The single check line that contains `text`. */
		line(text: string): string {
			const found = lines.filter((line) => line.includes(text));
			assert.equal(found.length, 1, `expected one line with "${text}", got:\n${result.stdout}`);
			return found[0];
		},
		count: (level: "PASS" | "WARN" | "FAIL" | "SKIP") => lines.filter((line) => line.startsWith(`${level}  `)).length,
	};
}

/** A repository nest could work in: protection rules, gate and a filled-in AGENTS.md. */
function targetRepo(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "nest-doctor-target-"));
	dirs.push(dir);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}

describe("scripts/doctor.sh", () => {
	it("passes on a machine that is ready, one PASS/WARN/FAIL line per check", () => {
		const run = doctor({ args: ["--docker"] });
		assert.equal(run.status, 0, run.stdout + run.stderr);
		assert.equal(run.count("SKIP"), 0, "with --docker nothing is left out");
		assert.equal(run.count("FAIL"), 0, run.stdout);
		const checks = run.lines.slice(0, -1);
		for (const line of checks) assert.match(line, /^(PASS|WARN|FAIL) {2}\S/, "every check line starts with its result");
		for (const line of checks.filter((candidate) => !candidate.startsWith("PASS"))) assert.match(line, /Fix: /, "a line that is not a PASS ends with the fix");
		assert.match(run.lines.at(-1)!, /^doctor: 0 failed, \d+ warning\(s\)$/);
		for (const expected of [
			"repo: pecker-nest is at",
			`pi: version ${PI_VERSION}, as in package.json`,
			"node: version 22.18.0",
			"pnpm: version 10.34.9",
			"uv: uv 0.13.6",
			"docker: the daemon is reachable",
			"links: agent files and Claude Code skills are linked",
			"credential: Pi is logged in to OpenRouter",
			"credential: OPENROUTER_API_KEY is not exported",
			"credential: Keychain item pecker-nest-container-key exists",
			"knowledge base: kb answers at http://localhost:8000/mcp and Pi is signed in (4 tools)",
			`model: openrouter/${FLASH} is in`,
			`model: openrouter/${GLM} is in`,
			`model: openrouter/${KIMI} is in`,
			`image: pecker-nest-pi was built from HEAD (${HEAD.slice(0, 7)})`,
		]) {
			assert.ok(run.line(expected).startsWith("PASS  "), expected);
		}
		assert.equal(run.stderr, "");
	});

	it("fails when the repo is not at ~/dev/pecker-nest", () => {
		const run = doctor({ atExpectedPath: false });
		assert.equal(run.status, 1);
		assert.match(run.line("repo: pecker-nest is at"), /^FAIL .*Fix: move it there, or ln -s /);
		assert.ok(run.line("links:").startsWith("FAIL  "), "link.sh refuses to check a clone elsewhere");
	});

	it("fails for missing links and names link.sh --claude", () => {
		const run = doctor({ linked: false });
		assert.equal(run.status, 1);
		assert.match(run.line("links:"), /^FAIL {2}links: \d+ link\(s\) missing or pointing elsewhere\. Fix: .*scripts\/link\.sh --claude$/);
	});

	it("fails for a Pi older than package.json and warns for a newer one", () => {
		const older = doctor({ env: { STUB_PI_VERSION: "1.4.9" } });
		assert.equal(older.status, 1);
		assert.match(older.line("pi: version"), new RegExp(`^FAIL {2}pi: version 1\\.4\\.9 is older than ${PI_VERSION.replaceAll(".", "\\.")} .*Fix: pi update$`));
		const newer = doctor({ env: { STUB_PI_VERSION: "1.10.0" } });
		assert.equal(newer.status, 0, newer.stdout);
		assert.match(newer.line("pi: version"), /^WARN {2}pi: version 1\.10\.0 is newer than .*npm run e2e/, "1.10 is newer than 1.5: numbers, not strings");
	});

	it("fails for missing or outdated tools", () => {
		const run = doctor({ env: { STUB_NODE_VERSION: "v22.17.1", STUB_PNPM_VERSION: "9.15.0" }, without: ["uv", "pi"] });
		assert.equal(run.status, 1);
		assert.match(run.line("node:"), /^FAIL {2}node: version 22\.17\.1 is older than 22\.18\. Fix: /);
		assert.match(run.line("pnpm:"), /^FAIL {2}pnpm: version 9\.15\.0 is not 10\.x\. Fix: npm install -g pnpm@10$/);
		assert.match(run.line("uv:"), /^FAIL {2}uv: not found on PATH\. Fix: brew install uv$/);
		assert.match(run.line("pi: not found"), /^FAIL /);
		assert.match(run.line("credential: not checked, pi is missing"), /^FAIL /);
		assert.match(run.line("model: not checked, pi is missing"), /^FAIL /);
		assert.ok(doctor({ env: { STUB_NODE_VERSION: "v24.1.0" } }).line("node:").startsWith("PASS  "));
	});

	it("leaves Docker alone without --docker: one SKIP line, no daemon or image check, no failure", () => {
		// No daemon, no image, no Keychain item: nothing an interactive session needs.
		const run = doctor({ env: { STUB_DOCKER_UP: "0", STUB_IMAGE_LABELS: "", STUB_KEYCHAIN_ITEM: "0" } });
		assert.equal(run.status, 0, run.stdout);
		assert.equal(run.count("FAIL"), 0, run.stdout);
		assert.equal(run.count("SKIP"), 1);
		assert.match(run.line("docker:"), /^SKIP {2}docker: daemon and image not checked; only headless runs \(docker\/pi-run\.sh\) need them\. Include them: .*scripts\/doctor\.sh --docker$/);
		assert.ok(!run.stdout.includes("image:"), "no image line");
		assert.equal(run.dockerCalls, "", "docker is not called at all");
		for (const line of run.lines.slice(0, -1)) assert.match(line, /^(PASS|WARN|FAIL|SKIP) {2}\S/);
		// A SKIP is neither a warning nor a failure in the summary. The two warnings: the Keychain item
		// and the knowledge base's sources (this scratch HOME has no grove .env).
		assert.equal(run.count("WARN"), 2, run.stdout);
		assert.ok(run.line("kb sources: not checked").startsWith("WARN  "));
		assert.match(run.lines.at(-1)!, /^doctor: 0 failed, 2 warning\(s\)$/);
		assert.equal(doctor({ without: ["docker"] }).status, 0, "a machine without Docker is ready for interactive sessions");
	});

	it("--docker fails when the Docker daemon is down and does not guess about the image", () => {
		const run = doctor({ args: ["--docker"], env: { STUB_DOCKER_UP: "0" } });
		assert.equal(run.status, 1);
		assert.match(run.line("docker:"), /^FAIL {2}docker: the daemon is not reachable\. Fix: start Docker Desktop$/);
		assert.match(run.line("image:"), /^FAIL {2}image: not checked, Docker is not reachable\. Fix: .*build-image\.sh$/);
		assert.equal(run.dockerCalls.trim(), "info", "the image is not inspected through a daemon that is down");
	});

	it("fails without an OpenRouter login; an exported key only earns warnings and is never printed", () => {
		const none = doctor({ env: { STUB_PI_LOGIN: "0" } });
		assert.equal(none.status, 1);
		assert.match(none.line("credential: Pi has no OpenRouter credential"), /^FAIL .*Fix: start pi and run \/login openrouter$/);

		const envOnly = doctor({ env: { STUB_PI_LOGIN: "0", OPENROUTER_API_KEY: SECRET } });
		assert.equal(envOnly.status, 0, envOnly.stdout);
		assert.match(envOnly.line("only through the exported OPENROUTER_API_KEY"), /^WARN .*\/login openrouter/);
		assert.match(envOnly.line("credential: OPENROUTER_API_KEY is exported"), /^WARN .*fish: set -e OPENROUTER_API_KEY\)$/);
		assert.ok(!envOnly.stdout.includes(SECRET) && !envOnly.stderr.includes(SECRET), "the key is not printed");

		const both = doctor({ env: { OPENROUTER_API_KEY: SECRET } });
		assert.ok(both.line("credential: Pi is logged in to OpenRouter").startsWith("PASS  "), "the login is checked without the variable");
		assert.ok(both.line("credential: OPENROUTER_API_KEY is exported").startsWith("WARN  "));
	});

	it("checks the Keychain item for existence only: a warning for the probe, a failure with --docker", () => {
		const present = doctor();
		assert.equal(present.securityCalls.trim(), "find-generic-password -a tester -s pecker-nest-container-key", "no -w: the key is not read");
		assert.ok(present.line("credential: Keychain item pecker-nest-container-key exists").startsWith("PASS  "), "checked without --docker too");
		// Without --docker only the live probe reads the item, and it also takes PROBE_OPENROUTER_API_KEY.
		const forProbe = doctor({ env: { STUB_KEYCHAIN_ITEM: "0" } });
		assert.equal(forProbe.status, 0, forProbe.stdout);
		assert.match(
			forProbe.line("credential: Keychain item"),
			/^WARN .*is missing; the live probe \(scripts\/probe-openrouter\.ts\) reads it.*Fix: security add-generic-password -U -a "tester" -s pecker-nest-container-key -w$/,
		);
		const missing = doctor({ args: ["--docker"], env: { STUB_KEYCHAIN_ITEM: "0" } });
		assert.equal(missing.status, 1);
		assert.match(
			missing.line("credential: Keychain item"),
			/^FAIL .*is missing.*Fix: security add-generic-password -U -a "tester" -s pecker-nest-container-key -w$/,
		);
		assert.doesNotMatch(missing.securityCalls, /-w/);
		// No Keychain at all (Linux): a warning either way, with the variable that replaces it.
		assert.match(doctor({ without: ["security"] }).line("credential: no Keychain"), /^WARN .*Fix: set PROBE_OPENROUTER_API_KEY /);
		assert.match(doctor({ args: ["--docker"], without: ["security"] }).line("credential: no Keychain"), /^WARN .*Fix: set PI_RUN_OPENROUTER_API_KEY /);
	});

	it("never fails because of the knowledge base: a warning with the fix when grove is down, not signed in or switched off", () => {
		const down = doctor({ env: { STUB_PI_MCP: mcpList("failed", { error: "fetch failed" }) } });
		assert.equal(down.status, 0, down.stdout);
		assert.match(
			down.line("knowledge base:"),
			/^WARN {2}knowledge base: kb does not answer at http:\/\/localhost:8000\/mcp \(grove is not running\); sessions work without it\. Fix: cd .*\/dev\/pecker-grove && pnpm stack:up && pnpm dev, then \/mcp reconnect kb /,
		);
		assert.match(doctor({ env: { STUB_PI_MCP: mcpList("failed"), GROVE_DIR: "/somewhere/grove" } }).line("knowledge base:"), /Fix: cd \/somewhere\/grove && pnpm stack:up /);

		const signedOut = doctor({ env: { STUB_PI_MCP: mcpList("needs-auth") } });
		assert.equal(signedOut.status, 0, signedOut.stdout);
		assert.match(signedOut.line("knowledge base:"), /^WARN .*but Pi is not signed in; sessions work without it\. Fix: pi mcp login kb$/);

		const cases: [string, RegExp][] = [
			[mcpList("connected", { enabled: false }), /^WARN .*kb is switched off in Pi's mcp\.json.*Fix: /],
			[JSON.stringify({ servers: [], errors: [] }), /^WARN .*has no kb server.*Fix: .*scripts\/link\.sh$/],
			["pi: something went wrong", /^WARN .*gave no readable answer\. Fix: run pi mcp list /],
			["", /^WARN .*gave no readable answer\. Fix: /],
		];
		for (const [answer, expected] of cases) {
			const run = doctor({ env: { STUB_PI_MCP: answer } });
			assert.equal(run.status, 0, run.stdout);
			assert.match(run.line("knowledge base:"), expected);
		}

		// Pi missing is a failure of its own line; the knowledge-base line stays a warning.
		assert.match(doctor({ without: ["pi"] }).line("knowledge base:"), /^WARN {2}knowledge base: not checked, pi or node is missing\. Fix: /);
		assert.equal(readFileSync(join(down.dir, "pi-mcp-calls"), "utf-8").trim(), "mcp list --json", "one read-only call");
	});

	it("fails for a missing Flash or GLM, warns for a missing Kimi", () => {
		const noGlm = doctor({ env: { STUB_PI_MODELS: `${FLASH} ${KIMI}` } });
		assert.equal(noGlm.status, 1);
		assert.match(noGlm.line(`openrouter/${GLM}`), /^FAIL .*is not in pi --list-models\. Fix: pi update --models/);
		const noKimi = doctor({ env: { STUB_PI_MODELS: `${FLASH} ${GLM}` } });
		assert.equal(noKimi.status, 0, noKimi.stdout);
		assert.match(noKimi.line(`openrouter/${KIMI}`), /^WARN .*falls back to GLM 5\.3\. Fix: pi update --models/);
		// The ID has to be listed under openrouter, not under another provider or as a prefix.
		const elsewhere = doctor({ env: { STUB_PI_MODELS: `${FLASH}x ${KIMI}`, STUB_FOREIGN_MODEL: GLM } });
		assert.ok(elsewhere.line(`openrouter/${FLASH} `).startsWith("FAIL  "));
		assert.ok(elsewhere.line(`openrouter/${GLM} `).startsWith("FAIL  "));
	});

	it("fails for a missing, unlabelled, outdated or dirty image", () => {
		const cases: [string, RegExp][] = [
			["", /^FAIL {2}image: pecker-nest-pi does not exist\. Fix: .*build-image\.sh$/],
			["|", /^FAIL {2}image: pecker-nest-pi has no nest\.commit label.*build-image\.sh$/],
			["0123456789abcdef0123456789abcdef01234567|0", new RegExp(`^FAIL {2}image: pecker-nest-pi was built from 0123456, the repo is at ${HEAD.slice(0, 7)}\\. Fix: .*build-image\\.sh$`)],
			[`${HEAD}|1`, /^FAIL {2}image: pecker-nest-pi was built with uncommitted changes.*build-image\.sh$/],
		];
		for (const [labels, expected] of cases) {
			const run = doctor({ args: ["--docker"], env: { STUB_IMAGE_LABELS: labels } });
			assert.equal(run.status, 1, labels);
			assert.match(run.line("image:"), expected);
		}
	});

	it("--repo checks protect.json, gate.json and AGENTS.md of the target repository", () => {
		const good = targetRepo({ ".pi/protect.json": '{"write":[]}', ".pi/gate.json": '{"command":"pnpm run check"}', "AGENTS.md": "# Project\nAll filled in.\n" });
		const ok = doctor({ args: ["--repo", good] });
		assert.equal(ok.status, 0, ok.stdout);
		assert.ok(ok.line("target: .pi/protect.json").startsWith("PASS  "));
		assert.ok(ok.line("target: .pi/gate.json").startsWith("PASS  "));
		assert.ok(ok.line("target: AGENTS.md").startsWith("PASS  "));

		const empty = doctor({ args: ["--repo", targetRepo({ "README.md": "x\n" })] });
		assert.equal(empty.status, 1);
		assert.match(empty.line("target: .pi/protect.json"), /^FAIL .*is missing\. Fix: create .*templates\/undertext\/protect\.json\)$/);
		assert.match(empty.line("target: .pi/gate.json"), /^FAIL .*is missing\. Fix: cp .*templates\/gate\.ts\.json /);
		assert.match(empty.line("target: AGENTS.md"), /^FAIL .*is missing\. Fix: cp .*templates\/AGENTS\.ts\.md /);

		const broken = doctor({
			args: ["--repo", targetRepo({ ".pi/protect.json": '{"write":[', ".pi/gate.json": '{"command":"x"}', "AGENTS.md": "# Project\nTODO: describe\n\n## Rules\n- TODO\n" })],
		});
		assert.equal(broken.status, 1);
		assert.match(broken.line("target: .pi/protect.json"), /^FAIL .*is not valid JSON\. Fix: /);
		assert.ok(broken.line("target: .pi/gate.json").startsWith("PASS  "));
		assert.match(broken.line("target: AGENTS.md"), /^FAIL .*still has 2 line\(s\) with TODO\. Fix: /);

		const nowhere = doctor({ args: ["--repo", join(good, "missing")] });
		assert.equal(nowhere.status, 1);
		assert.match(nowhere.line("target:"), /^FAIL .*is not a directory/);
		assert.ok(!doctor().stdout.includes("target:"), "without --repo the target checks do not run");
	});

	it("takes --docker and --repo together, in either order", () => {
		const good = targetRepo({ ".pi/protect.json": '{"write":[]}', ".pi/gate.json": '{"command":"pnpm run check"}', "AGENTS.md": "# Project\nAll filled in.\n" });
		for (const args of [["--docker", "--repo", good], ["--repo", good, "--docker"]]) {
			const run = doctor({ args });
			assert.equal(run.status, 0, run.stdout);
			assert.ok(run.line("image:").startsWith("PASS  "));
			assert.ok(run.line("target: .pi/gate.json").startsWith("PASS  "));
		}
	});

	it("rejects unknown arguments", () => {
		assert.equal(doctor({ args: ["--nope"] }).status, 2);
		assert.equal(doctor({ args: ["--repo"] }).status, 2);
		assert.match(doctor({ args: ["--help"] }).stderr, /usage: scripts\/doctor\.sh \[--docker\] \[--repo <path>\] \[--cursor\]/);
	});
});

describe("scripts/doctor.sh --cursor", () => {
	/** link.sh --cursor in the scratch HOME, with the stub `node` that runs the real one. */
	function installCursor(home: string, env: Record<string, string>) {
		const link = spawnSync(join(NEST, "scripts/link.sh"), ["--cursor"], { encoding: "utf-8", env: { ...env, HOME: home } });
		assert.equal(link.status, 0, link.stdout + link.stderr);
	}
	function trusted(home: string, ...roots: string[]) {
		mkdirSync(join(home, ".config/pecker-nest"), { recursive: true });
		writeFileSync(join(home, ".config/pecker-nest/cursor-trusted"), roots.map((root) => `${root}\n`).join(""));
	}
	const recordNode = (home: string, path: string) => writeFileSync(join(home, ".config/pecker-nest/cursor-node"), `${path}\n`);

	it("passes when the adapter is installed, its Node starts and a repository is trusted", () => {
		const repo = targetRepo({ ".pi/gate.json": '{"command":"x"}' });
		const run = doctor({ args: ["--cursor"], setup: (home, env) => (installCursor(home, env), trusted(home, repo)) });
		assert.equal(run.status, 0, run.stdout);
		assert.ok(run.line("cursor: hooks, reviewer subagent and skills are installed").startsWith("PASS  "));
		assert.match(run.line("cursor: the hooks start Node"), new RegExp(`^PASS {2}cursor: the hooks start Node ${process.versions.node.replaceAll(".", "\\.")} at /`));
		assert.ok(run.line("cursor: 1 repository trusted").startsWith("PASS  "));
		// link.sh --claude also put the supervision skills into ~/.claude/skills, which Cursor reads too.
		assert.match(run.line("are visible to Cursor through"), /^WARN {2}cursor: nest-supervise, nest-handoff and nest-review are visible to Cursor through .*\.claude\/skills\/ .*Fix: /);
	});

	it("fails without the adapter, and says that Cursor then blocks everything", () => {
		const run = doctor({ args: ["--cursor"] });
		assert.equal(run.status, 1);
		assert.match(run.line("of the adapter's links missing"), /^FAIL .*Fix: .*scripts\/link\.sh --cursor$/);
		assert.match(run.line("no Node recorded"), /^FAIL .*Cursor blocks every command and file access\. Fix: .*link\.sh --cursor$/);
		assert.match(run.line("no repository is trusted"), /^WARN .*Fix: .*cursor-trust\.sh add <repo>$/);
	});

	it("fails for a recorded Node that is gone, in an fnm shell directory, or too old", () => {
		const gone = doctor({ args: ["--cursor"], setup: (home, env) => (installCursor(home, env), recordNode(home, join(home, "no-such/node"))) });
		assert.equal(gone.status, 1);
		assert.match(gone.line("cursor: the recorded Node"), /^FAIL .*no-such\/node is gone .*Fix: .*link\.sh --cursor$/);

		const multishell = doctor({
			args: ["--cursor"],
			setup: (home, env) => {
				installCursor(home, env);
				const dir = join(home, ".local/state/fnm_multishells/4242_1/bin");
				mkdirSync(dir, { recursive: true });
				symlinkSync(process.execPath, join(dir, "node"));
				recordNode(home, join(dir, "node"));
			},
		});
		assert.equal(multishell.status, 1);
		assert.match(multishell.line("cursor: the recorded Node"), /^FAIL .*per-shell directory of fnm .*Fix: .*link\.sh --cursor \(it records the resolved path\)$/);

		const old = doctor({
			args: ["--cursor"],
			setup: (home, env) => {
				installCursor(home, env);
				writeFileSync(join(home, "old-node"), "#!/bin/sh\necho v20.11.0\n");
				chmodSync(join(home, "old-node"), 0o755);
				recordNode(home, join(home, "old-node"));
			},
		});
		assert.equal(old.status, 1);
		assert.match(old.line("cursor: the recorded Node"), /^FAIL .*is 20\.11\.0, older than 22\.18\. Fix: /);
	});

	it("warns for trust-list entries that are gone and for Claude Code hooks Cursor would run", () => {
		const run = doctor({
			args: ["--cursor"],
			setup: (home, env) => {
				installCursor(home, env);
				trusted(home, join(home, "gone-repo"));
				writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ hooks: { PreToolUse: [], Stop: [] } }));
			},
		});
		assert.equal(run.status, 0, run.stdout);
		assert.match(run.line("trust list names repositories that do not exist"), /gone-repo\. Fix: .*cursor-trust\.sh remove <path>$/);
		assert.match(run.line("settings.json has hooks"), /^WARN .*\(PreToolUse, Stop\); Cursor runs them as well.*Fix: /);
	});

	it("checks nothing of Cursor without the switch", () => {
		const run = doctor();
		assert.ok(!run.stdout.includes("cursor:"), run.stdout);
	});
});

describe("scripts/kb-sources.sh and the kb sources lines of doctor.sh", () => {
	const GIT_ENV = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_AUTHOR_NAME: "Tester",
		GIT_AUTHOR_EMAIL: "tester@example.com",
		GIT_COMMITTER_NAME: "Tester",
		GIT_COMMITTER_EMAIL: "tester@example.com",
	};
	/** The real git for the fixtures, without the recording stub. */
	function git(cwd: string, ...args: string[]): string {
		const result = spawnSync(REAL_GIT, args, { cwd, encoding: "utf-8", env: GIT_ENV });
		assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
		return result.stdout.trim();
	}
	function commit(dir: string, file: string, text = `${file}\n`) {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), text);
		git(dir, "add", file);
		git(dir, "commit", "-q", "-m", `add ${file}`);
	}

	/**
	 * A notes checkout at `dir`, cloned from a local bare repository, with one committed note. Its
	 * origin says https://github.com/<repo>.git, and git's insteadOf sends that to the bare
	 * repository, so ls-remote answers without a network. `seed` is a second clone that can push
	 * commits the checkout has never fetched.
	 */
	function notesCheckout(dir: string, origin = "https://github.com/acme/notes.git") {
		const remote = `${dir}.remote.git`;
		const seed = `${dir}.seed`;
		mkdirSync(dirname(dir), { recursive: true });
		git(dirname(dir), "init", "-q", "--bare", "-b", "main", remote);
		git(dirname(dir), "init", "-q", "-b", "main", seed);
		commit(seed, "first.md");
		git(seed, "push", "-q", remote, "main");
		git(dirname(dir), "clone", "-q", remote, dir);
		git(dir, "remote", "set-url", "origin", origin);
		git(dir, "config", `url.${remote}.insteadOf`, origin);
		git(seed, "remote", "add", "origin", remote);
		return { dir, seed, remote, origin };
	}

	/** grove's .env at the default place, ~/dev/pecker-grove/.env. */
	function groveEnv(home: string, lines: string[]) {
		mkdirSync(join(home, "dev/pecker-grove"), { recursive: true });
		writeFileSync(join(home, "dev/pecker-grove/.env"), `${lines.join("\n")}\n`);
	}

	/** kb-sources.sh with the same stubs and scratch HOME as doctor.sh. */
	const kbSources = (options: Options = {}) => doctor({ ...options, script: KB_SOURCES, atExpectedPath: false });
	const kbJson = (options: Options = {}) => {
		const run = kbSources({ ...options, args: ["--json"] });
		assert.equal(run.status, 0, run.stderr);
		return { run, report: JSON.parse(run.stdout) };
	};

	/** One clean checkout as the single label `notes`; `change` runs on it before the script. */
	function single(change: (notes: ReturnType<typeof notesCheckout>, home: string) => void = () => {}) {
		return (home: string) => {
			const notes = notesCheckout(join(home, "notes"));
			groveEnv(home, [`NOTES_DIR=${notes.dir}`]);
			change(notes, home);
		};
	}

	const READ_ONLY_GIT = /^-C \S+ (symbolic-ref --short -q (HEAD|refs\/remotes\/origin\/HEAD)|rev-parse -q (--verify|--short) HEAD|-c core\.quotePath=false status --porcelain --untracked-files=all -- \*\.md|config --get remote\.origin\.url|ls-remote --symref origin HEAD|cat-file -e [0-9a-f]{40}\^\{commit\}|merge-base --is-ancestor [0-9a-f]{40} [0-9a-f]{40})$/;

	it("passes a checkout on the default branch at the remote's commit, clean, with no open pull requests", () => {
		const run = doctor({ setup: single() });
		assert.equal(run.status, 0, run.stdout);
		assert.match(run.line("kb sources:"), /^PASS {2}kb sources: notes: \/\S+\/notes \(main at [0-9a-f]{7}\), as on origin\/main; no uncommitted notes, no open pull requests$/);
		assert.equal(run.ghCalls.trim(), "pr list --repo acme/notes --state open --json number,title,headRefName", "one read-only gh call");
		const notesCalls = run.gitCalls.split("\n").filter((call) => call.startsWith(`-C ${join(run.dir, "notes")} `));
		assert.ok(notesCalls.some((call) => call.includes("ls-remote")), run.gitCalls);
		for (const call of notesCalls) assert.match(call.replace(join(run.dir, "notes"), "<dir>"), READ_ONLY_GIT);
		const human = kbSources({ setup: single() });
		assert.equal(human.status, 0);
		assert.match(human.stdout, /^ok {4}notes: \/\S+\/notes on main at [0-9a-f]{7}, as on the remote; no uncommitted notes, no open pull requests\n$/);
	});

	it("warns with the fix for a checkout that is not on the default branch", () => {
		const run = doctor({ setup: single(({ dir }) => git(dir, "switch", "-q", "-c", "notes/draft")) });
		assert.equal(run.status, 0, run.stdout);
		const dir = join(run.dir, "notes");
		assert.equal(run.line("kb sources:"), `WARN  kb sources: notes: ${dir} (notes/draft at ${git(dir, "rev-parse", "--short", "HEAD")}): on notes/draft, not on main. Fix: git -C ${dir} switch main`);
		const detached = doctor({ setup: single(({ dir }) => git(dir, "switch", "-q", "--detach")) });
		assert.match(detached.line("kb sources:"), /\(detached HEAD at [0-9a-f]{7}\): detached HEAD, not on main\. Fix: git -C \S+ switch main$/);
	});

	it("warns for a checkout behind, missing commits of, diverged from or ahead of the remote", () => {
		const behind = doctor({
			setup: single(({ dir }) => {
				commit(dir, "second.md");
				git(dir, "push", "-q", "origin", "main");
				git(dir, "reset", "-q", "--hard", "HEAD~1");
			}),
		});
		assert.match(behind.line("kb sources:"), /: behind origin\/main\. Fix: git -C \S+\/notes pull --ff-only$/);

		const unfetched = doctor({
			setup: single(({ seed }) => {
				commit(seed, "from-elsewhere.md");
				git(seed, "push", "-q", "origin", "main");
			}),
		});
		assert.match(unfetched.line("kb sources:"), /: origin\/main has commits this checkout has not fetched\. Fix: git -C \S+\/notes pull --ff-only$/);

		const diverged = doctor({
			setup: single(({ dir }) => {
				commit(dir, "pushed.md");
				git(dir, "push", "-q", "origin", "main");
				git(dir, "reset", "-q", "--hard", "HEAD~1");
				commit(dir, "local.md");
			}),
		});
		assert.match(diverged.line("kb sources:"), /: diverged from origin\/main\. Fix: bring the local commits and origin\/main together by hand$/);

		const ahead = doctor({ setup: single(({ dir }) => commit(dir, "local.md")) });
		assert.match(ahead.line("kb sources:"), /: ahead of origin\/main: local commits not on the remote\. Fix: push the local commits or open a pull request for them$/);

		for (const run of [behind, unfetched, diverged, ahead]) assert.equal(run.status, 0, run.stdout);
		const { report } = kbJson({ setup: single(({ seed }) => (commit(seed, "x.md"), git(seed, "push", "-q", "origin", "main"))) });
		assert.equal(report.sources[0].relation, "unfetched");
	});

	it("lists uncommitted and untracked notes, and only notes", () => {
		const run = doctor({
			setup: single(({ dir }) => {
				writeFileSync(join(dir, "first.md"), "changed\n");
				mkdirSync(join(dir, "drafts/deep"), { recursive: true });
				writeFileSync(join(dir, "drafts/deep/idea.md"), "new\n");
				writeFileSync(join(dir, "scratch.txt"), "not a note\n");
			}),
		});
		assert.equal(run.status, 0, run.stdout);
		assert.match(
			run.line("kb sources:"),
			/: 2 uncommitted notes \(first\.md, drafts\/deep\/idea\.md\), indexed but in no commit\. Fix: commit or remove first\.md, drafts\/deep\/idea\.md$/,
		);
		assert.ok(!run.stdout.includes("scratch.txt"));
	});

	it("names the open pull requests to merge, then the pull", () => {
		const prs = [
			{ number: 7, title: 'Add "retro" notes \\ with a backslash', headRefName: "notes/retro" },
			{ number: 9, title: "Tabs\tand ünïcode", headRefName: "notes/tabs" },
		];
		const setup = single((_notes, home) => {
			mkdirSync(join(home, "gh-prs"));
			writeFileSync(join(home, "gh-prs/acme_notes.json"), JSON.stringify(prs));
		});
		const run = doctor({ setup });
		assert.equal(run.status, 0, run.stdout);
		assert.match(run.line("kb sources:"), /: 2 open pull requests \(#7, #9\), not on main yet\. Fix: merge #7, #9, then git -C \S+\/notes pull --ff-only$/);
		assert.ok(!run.stdout.includes("retro"), "doctor names numbers, not titles");
		const { report } = kbJson({ setup });
		assert.deepEqual(report.sources[0].pullRequests.open, [
			{ number: 7, title: 'Add "retro" notes \\ with a backslash', branch: "notes/retro" },
			{ number: 9, title: "Tabs and ünïcode", branch: "notes/tabs" },
		]);
	});

	it("says the remote was not checked when it is unreachable or silent, and still checks the branch", () => {
		const offline = doctor({
			setup: single(({ dir, remote, origin }, home) => {
				git(dir, "config", "--unset", `url.${remote}.insteadOf`);
				git(dir, "config", `url.${join(home, "gone.git")}.insteadOf`, origin);
				git(dir, "switch", "-q", "-c", "notes/draft");
			}),
		});
		assert.equal(offline.status, 0, offline.stdout);
		assert.match(
			offline.line("kb sources:"),
			/: on notes\/draft, not on main; remote not checked, unreachable \(offline, or no access\)\. Fix: git -C \S+ switch main; run this again when online$/,
		);

		const started = Date.now();
		const { report } = kbJson({ env: { STUB_GIT_HANG: "1", KB_SOURCES_TIMEOUT: "1" }, setup: single() });
		assert.ok(Date.now() - started < 8000, "stopped after the time limit, not after the hanging command");
		const [source] = report.sources;
		assert.deepEqual(source.remote, { checked: false, commit: null, reason: "no answer within 1s" });
		assert.equal(source.defaultBranch, "main", "the clone still knows the remote's default branch");
		assert.equal(source.defaultBranchFrom, "clone");
		assert.equal(source.relation, null);
		assert.deepEqual(source.fixes, ["run this again when online"]);
	});

	it("says the pull requests were not checked without gh or without a gh login", () => {
		const noGh = doctor({ without: ["gh"], setup: single() });
		assert.equal(noGh.status, 0, noGh.stdout);
		assert.match(noGh.line("kb sources:"), /: pull requests not checked, gh is not installed\. Fix: brew install gh, then gh auth login$/);
		const signedOut = doctor({ env: { STUB_GH_AUTH: "0" }, setup: single() });
		assert.equal(signedOut.status, 0, signedOut.stdout);
		assert.match(signedOut.line("kb sources:"), /: pull requests not checked, gh pr list failed \(not signed in, offline, or no access\)\. Fix: gh auth status shows why; gh auth login if signed out$/);
		const notGitHub = doctor({ setup: (home) => (notesCheckout(join(home, "notes"), "https://git.example.com/notes"), groveEnv(home, [`NOTES_DIR=${join(home, "notes")}`])) });
		assert.match(notGitHub.line("kb sources:"), /: pull requests not checked, origin is not a GitHub repository\. Fix: nothing, if the notes live outside GitHub$/);
		assert.equal(notGitHub.ghCalls, "");
	});

	it("is not checked without grove's .env or without NOTES_DIR, and follows GROVE_DIR", () => {
		const none = doctor();
		assert.equal(none.status, 0, none.stdout);
		assert.match(none.line("kb sources:"), /^WARN {2}kb sources: not checked, there is no \/\S+\/dev\/pecker-grove\/\.env\. Fix: if grove lives elsewhere, name it in GROVE_DIR; /);
		assert.equal(none.gitCalls.includes("ls-remote"), false);

		const noDir = doctor({ setup: (home) => groveEnv(home, ["NOTES_SOURCES=", "OTHER=1"]) });
		assert.equal(noDir.status, 0, noDir.stdout);
		assert.match(noDir.line("kb sources:"), /^WARN {2}kb sources: not checked, \/\S+\/\.env sets no NOTES_DIR\. Fix: set NOTES_DIR in /);

		const elsewhere = doctor({
			env: { GROVE_DIR: "/somewhere/else" },
			setup: (home, env) => {
				const grove = join(home, "code/grove");
				mkdirSync(grove, { recursive: true });
				notesCheckout(join(home, "notes"));
				writeFileSync(join(grove, ".env"), `NOTES_DIR=${join(home, "notes")}\n`);
				env.GROVE_DIR = grove;
			},
		});
		assert.ok(elsewhere.line("kb sources: notes:").startsWith("PASS  "), elsewhere.stdout);

		const missing = doctor({ setup: (home) => groveEnv(home, [`NOTES_DIR=${join(home, "nowhere")}`]) });
		assert.match(missing.line("kb sources: notes:"), /^WARN {2}kb sources: notes: \/\S+\/nowhere: not checked, the folder does not exist\. Fix: clone the notes repository there, /);
		assert.equal(kbSources().status, 0);
	});

	it("checks every label of NOTES_SOURCES, its folder inside NOTES_DIR", () => {
		const run = doctor({
			setup: (home) => {
				notesCheckout(join(home, "notes/team-notes"));
				mkdirSync(join(home, "notes/loose"), { recursive: true });
				groveEnv(home, [`NOTES_DIR='${join(home, "notes")}/'`, 'NOTES_SOURCES="team=team-notes, loose=loose"']);
			},
		});
		assert.equal(run.status, 0, run.stdout);
		assert.match(run.line("kb sources: team:"), /^PASS {2}kb sources: team: \/\S+\/notes\/team-notes \(main at /);
		assert.match(run.line("kb sources: loose:"), /^WARN {2}kb sources: loose: \/\S+\/notes\/loose: not checked, the folder is not a git checkout\. Fix: /);
		const human = kbSources({ setup: (home) => (notesCheckout(join(home, "n/a")), groveEnv(home, [`NOTES_DIR=${join(home, "n")}`, "NOTES_SOURCES=one=a,two=b"])) });
		assert.deepEqual(
			human.lines.map((line) => line.split(":")[0]),
			["ok    one", "warn  two"],
			"one line per label",
		);
	});

	it("prints no value of grove's .env other than NOTES_DIR and NOTES_SOURCES, never sources it, and never prints the origin URL", () => {
		const setup = (home: string) => {
			const notes = notesCheckout(join(home, "notes/main-notes"), "https://x-access-token:canary-origin-token@github.com/acme/notes.git");
			// The last line of a key wins, so the look-alikes come after the real lines.
			groveEnv(home, [
				"OPENROUTER_API_KEY=canary-openrouter-1234",
				'KEYCLOAK_ADMIN_PASSWORD="canary-keycloak"',
				`export NOTES_DIR=${join(home, "notes")}   # where the notes live`,
				"NOTES_SOURCES=main=main-notes",
				"# NOTES_DIR=/canary-commented",
				"NOTES_DIR_BACKUP=/canary-prefix",
				"XNOTES_DIR=/canary-suffix",
				"NOTES_SOURCES_OLD=canary=canary-old",
				'PWNED=$(touch "$HOME/sourced")',
				"MORE_SECRET='canary-quoted'",
			]);
			commit(notes.dir, "canary-free.md");
		};
		const runs = [kbSources({ setup }), kbSources({ setup, args: ["--json"] }), doctor({ setup })];
		for (const run of runs) {
			assert.equal(run.status, 0, run.stdout + run.stderr);
			assert.doesNotMatch(run.stdout + run.stderr, /canary/, run.stdout + run.stderr);
			assert.ok(!existsSync(join(run.dir, "sourced")), "the .env was sourced");
			assert.match(run.stdout, /main-notes/, "the label was checked");
		}
		assert.equal(JSON.parse(runs[1].stdout).sources[0].repo, "acme/notes");
		assert.doesNotMatch(runs[2].ghCalls, /canary/);
	});

	it("writes nothing into a checkout", () => {
		const snapshot = (dir: string): string[] => {
			const out: string[] = [];
			const walk = (path: string) => {
				for (const name of readdirSync(path, { withFileTypes: true })) {
					const full = join(path, name.name);
					if (name.isDirectory()) walk(full);
					else out.push(`${full} ${readFileSync(full).toString("base64")}`);
				}
			};
			walk(dir);
			return out.sort();
		};
		let before: string[] = [];
		const run = kbSources({
			args: ["--json"],
			setup: single(({ dir, seed }) => {
				commit(seed, "elsewhere.md");
				git(seed, "push", "-q", "origin", "main");
				writeFileSync(join(dir, "draft.md"), "new\n");
				// Same content, older time stamp: a plain `git status` would refresh the index.
				utimesSync(join(dir, "first.md"), new Date(2020, 0, 1), new Date(2020, 0, 1));
				before = snapshot(dir);
			}),
		});
		assert.equal(run.status, 0, run.stderr);
		assert.deepEqual(snapshot(join(run.dir, "notes")), before, "no fetch, no index refresh, nothing else");
		assert.equal(JSON.parse(run.stdout).sources[0].relation, "unfetched");
	});

	it("keeps the shape of --json stable: /kb-status and doctor.sh read it", () => {
		const { run, report } = kbJson({
			setup: (home) => {
				const notes = notesCheckout(join(home, "notes/work"));
				mkdirSync(join(home, "gh-prs"));
				writeFileSync(join(home, "gh-prs/acme_notes.json"), JSON.stringify([{ number: 3, title: "Weekly", headRefName: "notes/weekly" }]));
				writeFileSync(join(notes.dir, "todo.md"), "x\n");
				groveEnv(home, [`NOTES_DIR=${join(home, "notes")}`, "NOTES_SOURCES=work=work,gone=gone"]);
			},
		});
		const home = run.dir;
		const dir = join(home, "notes/work");
		const head = git(dir, "rev-parse", "HEAD");
		assert.deepEqual(report, {
			version: 1,
			groveDir: join(home, "dev/pecker-grove"),
			envFile: join(home, "dev/pecker-grove/.env"),
			env: "found",
			notesDir: join(home, "notes"),
			status: "ok",
			problems: [],
			fixes: [],
			sources: [
				{
					label: "work",
					dir,
					checked: true,
					branch: "main",
					commit: git(dir, "rev-parse", "--short", "HEAD"),
					head,
					defaultBranch: "main",
					defaultBranchFrom: "remote",
					remote: { checked: true, commit: head, reason: null },
					relation: "same",
					uncommitted: ["todo.md"],
					repo: "acme/notes",
					pullRequests: { checked: true, open: [{ number: 3, title: "Weekly", branch: "notes/weekly" }], reason: null },
					status: "warn",
					problems: ["1 uncommitted note (todo.md), indexed but in no commit", "1 open pull request (#3), not on main yet"],
					fixes: ["commit or remove todo.md", `merge #3, then git -C ${dir} pull --ff-only`],
				},
				{
					label: "gone",
					dir: join(home, "notes/gone"),
					checked: false,
					branch: null,
					commit: null,
					head: null,
					defaultBranch: null,
					defaultBranchFrom: null,
					remote: { checked: false, commit: null, reason: null },
					relation: null,
					uncommitted: [],
					repo: null,
					pullRequests: { checked: false, open: [], reason: null },
					status: "warn",
					problems: ["not checked, the folder does not exist"],
					fixes: [`clone the notes repository there, or correct NOTES_DIR or NOTES_SOURCES in ${join(home, "dev/pecker-grove/.env")}`],
				},
			],
		});
		const empty = kbJson().report;
		assert.deepEqual(Object.keys(empty), ["version", "groveDir", "envFile", "env", "notesDir", "status", "problems", "fixes", "sources"]);
		assert.equal(empty.env, "missing");
		assert.equal(empty.status, "warn");
		assert.deepEqual(empty.sources, []);
	});

	it("is what /kb-status runs, next to grove's index_status, and that prompt changes nothing", () => {
		const prompt = readFileSync(join(NEST, "prompts/kb-status.md"), "utf-8");
		assert.match(prompt, /^---\ndescription: .+\n---\n/);
		assert.ok(prompt.includes("`~/dev/pecker-nest/scripts/kb-sources.sh --json`"));
		assert.ok(prompt.includes("`mcp__kb__index_status`"));
		assert.match(prompt, /do not merge, pull, fetch, switch, commit, sync or edit anything/);
		assert.match(prompt, /report the host side only and say so/);
	});

	it("rejects unknown arguments with exit code 2", () => {
		const run = kbSources({ args: ["--nope"] });
		assert.equal(run.status, 2);
		assert.match(run.stderr, /usage: scripts\/kb-sources\.sh \[--json\]/);
	});
});
