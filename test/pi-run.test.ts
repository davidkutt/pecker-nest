/**
 * docker/pi-run.sh without Docker: stub `docker` and `security` programs on PATH record what the
 * script hands them. Covers where the container key comes from and that it never leaks.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const NEST = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_RUN = join(NEST, "docker/pi-run.sh");
const CONTAINER_KEY = "sk-or-container-key";
const KEYCHAIN_KEY = "sk-or-keychain-key";
const INTERACTIVE_KEY = "sk-or-interactive-key";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** `docker run` records the key from its environment and its arguments, then succeeds. */
const DOCKER_STUB = `#!/usr/bin/env bash
if [[ "$1" == run ]]; then
  printf '%s' "\${OPENROUTER_API_KEY-}" > "$STUB_DIR/docker-key"
  printf '%s\\n' "$@" > "$STUB_DIR/docker-args"
  exit 0
fi
echo "docker stub: unexpected $*" >&2
exit 1
`;

/** `security find-generic-password` answers for one service, like the macOS Keychain. */
const SECURITY_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DIR/security-calls"
if [[ "$1" == find-generic-password && "$2" == -a && "$4" == -s && "$6" == -w && "$5" == "\${STUB_KEYCHAIN_SERVICE-}" ]]; then
  echo "\${STUB_KEYCHAIN_KEY-}"
  exit 0
fi
echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2
exit 44
`;

interface Run {
	status: number | null;
	stdout: string;
	stderr: string;
	/** The key `docker run` found in its environment; undefined when docker was not started. */
	dockerKey: string | undefined;
	dockerArgs: string;
	securityCalls: string;
}

function piRun(env: Record<string, string>): Run {
	const dir = mkdtempSync(join(tmpdir(), "nest-pi-run-"));
	dirs.push(dir);
	const bin = join(dir, "bin");
	const repo = join(dir, "repo");
	mkdirSync(bin);
	mkdirSync(repo);
	for (const [name, script] of [["docker", DOCKER_STUB], ["security", SECURITY_STUB]] as const) {
		writeFileSync(join(bin, name), script);
		chmodSync(join(bin, name), 0o755);
	}
	const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf-8") : undefined);
	const result = spawnSync(PI_RUN, ["-C", repo, "do the task"], {
		encoding: "utf-8",
		env: {
			PATH: `${bin}:${process.env.PATH}`,
			HOME: dir,
			USER: userInfo().username,
			STUB_DIR: dir,
			PI_RUN_LOG_DIR: join(dir, "logs"),
			...env,
		},
	});
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		dockerKey: read("docker-key"),
		dockerArgs: read("docker-args") ?? "",
		securityCalls: read("security-calls") ?? "",
	};
}

const keychain = { STUB_KEYCHAIN_SERVICE: "pecker-nest-container-key", STUB_KEYCHAIN_KEY: KEYCHAIN_KEY };

function assertNoLeak(run: Run) {
	for (const key of [CONTAINER_KEY, KEYCHAIN_KEY, INTERACTIVE_KEY]) {
		assert.ok(!run.stdout.includes(key) && !run.stderr.includes(key), "the key is never printed");
		assert.ok(!run.dockerArgs.includes(key), "the key is not on docker's command line");
	}
	assert.match(run.dockerArgs, /^-e\nOPENROUTER_API_KEY$/m, "docker forwards the variable by name");
}

describe("docker/pi-run.sh container key", () => {
	it("prefers PI_RUN_OPENROUTER_API_KEY over the Keychain and the interactive key", () => {
		const run = piRun({ PI_RUN_OPENROUTER_API_KEY: CONTAINER_KEY, OPENROUTER_API_KEY: INTERACTIVE_KEY, ...keychain });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.dockerKey, CONTAINER_KEY);
		assert.equal(run.securityCalls, "", "the Keychain is not asked when the variable is set");
		assertNoLeak(run);
	});

	it("reads the Keychain item pecker-nest-container-key when the variable is not set", () => {
		const run = piRun({ OPENROUTER_API_KEY: INTERACTIVE_KEY, ...keychain });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.dockerKey, KEYCHAIN_KEY, "the Keychain key wins over an exported interactive key");
		assert.equal(run.securityCalls.trim(), `find-generic-password -a ${userInfo().username} -s pecker-nest-container-key -w`);
		assert.doesNotMatch(run.stderr, /warning/);
		assertNoLeak(run);
	});

	it("honours PI_RUN_KEYCHAIN_SERVICE", () => {
		const run = piRun({ PI_RUN_KEYCHAIN_SERVICE: "other-item", STUB_KEYCHAIN_SERVICE: "other-item", STUB_KEYCHAIN_KEY: KEYCHAIN_KEY });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.dockerKey, KEYCHAIN_KEY);
		assert.match(run.securityCalls, /-s other-item -w/);
	});

	it("uses OPENROUTER_API_KEY only with PI_RUN_ALLOW_INTERACTIVE_KEY=1, and warns", () => {
		const run = piRun({ OPENROUTER_API_KEY: INTERACTIVE_KEY, PI_RUN_ALLOW_INTERACTIVE_KEY: "1" });
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.dockerKey, INTERACTIVE_KEY);
		assert.match(run.stderr, /warning: PI_RUN_ALLOW_INTERACTIVE_KEY=1: this run spends OPENROUTER_API_KEY, which has no credit limit/);
		assertNoLeak(run);
	});

	it("refuses to spend an exported OPENROUTER_API_KEY and names the Keychain command", () => {
		const run = piRun({ OPENROUTER_API_KEY: INTERACTIVE_KEY });
		assert.equal(run.status, 64);
		assert.equal(run.dockerKey, undefined, "docker is not started");
		assert.match(run.stderr, /security add-generic-password -U -a "[^"]+" -s pecker-nest-container-key -w/);
		assert.match(run.stderr, /OPENROUTER_API_KEY is set but not used/);
		assert.match(run.stderr, /PI_RUN_ALLOW_INTERACTIVE_KEY=1/);
		assert.ok(!run.stderr.includes(INTERACTIVE_KEY) && !run.stdout.includes(INTERACTIVE_KEY), "the key is never printed");
	});

	it("refuses without any key, also for other values of PI_RUN_ALLOW_INTERACTIVE_KEY", () => {
		const none = piRun({});
		assert.equal(none.status, 64);
		assert.equal(none.dockerKey, undefined);
		assert.doesNotMatch(none.stderr, /OPENROUTER_API_KEY is set/);
		const wrongValue = piRun({ OPENROUTER_API_KEY: INTERACTIVE_KEY, PI_RUN_ALLOW_INTERACTIVE_KEY: "true" });
		assert.equal(wrongValue.status, 64, "only the value 1 allows the interactive key");
		assert.equal(wrongValue.dockerKey, undefined);
	});
});
