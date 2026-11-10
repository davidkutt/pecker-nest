/**
 * scripts/doctor.sh against stub tools: `pi`, `node`, `pnpm`, `uv`, `docker` and `security` on
 * PATH answer as the test says, HOME is a scratch directory with ~/dev/pecker-nest pointing at
 * this checkout. Nothing here needs Pi, Docker, a Keychain or a key.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
};

interface Options {
	env?: Record<string, string>;
	/** Stub tools to leave out, so the tool is "not installed". */
	without?: string[];
	/** Link the agent files into the scratch HOME first, as scripts/link.sh --claude does. */
	linked?: boolean;
	/** Put the repo at ~/dev/pecker-nest in the scratch HOME. */
	atExpectedPath?: boolean;
	args?: string[];
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
		// Only the stubs and the system tools: the real pi, pnpm and uv are not on this PATH.
		PATH: `${bin}:/usr/bin:/bin`,
		HOME: dir,
		USER: "tester",
		STUB_DIR: dir,
		STUB_REAL_NODE: process.execPath,
		STUB_PI_VERSION: PI_VERSION,
		STUB_PI_LOGIN: "1",
		STUB_PI_MODELS: `${FLASH} ${GLM} ${KIMI}`,
		STUB_FOREIGN_MODEL: "claude-x",
		STUB_NODE_VERSION: "v22.18.0",
		STUB_PNPM_VERSION: "10.34.9",
		STUB_DOCKER_UP: "1",
		STUB_IMAGE_LABELS: `${HEAD}|0`,
		STUB_KEYCHAIN_ITEM: "1",
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
	const result = spawnSync(DOCTOR, options.args ?? [], { encoding: "utf-8", env });
	const lines = result.stdout.trimEnd().split("\n");
	const securityCalls = existsSync(join(dir, "security-calls")) ? readFileSync(join(dir, "security-calls"), "utf-8") : "";
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		lines,
		securityCalls,
		/** The single check line that contains `text`. */
		line(text: string): string {
			const found = lines.filter((line) => line.includes(text));
			assert.equal(found.length, 1, `expected one line with "${text}", got:\n${result.stdout}`);
			return found[0];
		},
		count: (level: "PASS" | "WARN" | "FAIL") => lines.filter((line) => line.startsWith(`${level}  `)).length,
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
		const run = doctor();
		assert.equal(run.status, 0, run.stdout + run.stderr);
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

	it("fails when the Docker daemon is down and does not guess about the image", () => {
		const run = doctor({ env: { STUB_DOCKER_UP: "0" } });
		assert.equal(run.status, 1);
		assert.match(run.line("docker:"), /^FAIL {2}docker: the daemon is not reachable\. Fix: start Docker Desktop$/);
		assert.match(run.line("image:"), /^FAIL {2}image: not checked, Docker is not reachable\. Fix: .*build-image\.sh$/);
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

	it("checks the Keychain item for existence only", () => {
		const present = doctor();
		assert.equal(present.securityCalls.trim(), "find-generic-password -a tester -s pecker-nest-container-key", "no -w: the key is not read");
		const missing = doctor({ env: { STUB_KEYCHAIN_ITEM: "0" } });
		assert.equal(missing.status, 1);
		assert.match(
			missing.line("credential: Keychain item"),
			/^FAIL .*is missing.*Fix: security add-generic-password -U -a "tester" -s pecker-nest-container-key -w$/,
		);
		assert.doesNotMatch(missing.securityCalls, /-w/);
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
			const run = doctor({ env: { STUB_IMAGE_LABELS: labels } });
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

	it("rejects unknown arguments", () => {
		assert.equal(doctor({ args: ["--nope"] }).status, 2);
		assert.equal(doctor({ args: ["--repo"] }).status, 2);
	});
});
