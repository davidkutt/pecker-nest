/**
 * docker/pi-run.sh and scripts/build-image.sh without Docker: stub `docker` and `security`
 * programs on PATH record what the scripts hand them. Covers where the container key comes from
 * and that it never leaks, the stale-image check, and the labels the build sets.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * `docker image inspect` answers with the image's labels in the format pi-run.sh asks for (or
 * fails when there is no image); `docker run` records the key from its environment and its
 * arguments, then succeeds.
 */
const DOCKER_STUB = `#!/usr/bin/env bash
if [[ "$1 $2" == "image inspect" ]]; then
  [[ -z "\${STUB_NO_IMAGE-}" ]] || { echo "Error response from daemon: No such image" >&2; exit 1; }
  echo "$STUB_IMAGE_LABELS"
  exit 0
fi
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

/** HEAD of this checkout: what the image's nest.commit label has to equal. */
const HEAD = spawnSync("git", ["-C", NEST, "rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim();
/** Labels of an image that scripts/build-image.sh built from HEAD with a clean working tree. */
const FRESH = `${HEAD}|0`;

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
			STUB_IMAGE_LABELS: FRESH,
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

describe("docker/pi-run.sh stale image", () => {
	const key = { PI_RUN_OPENROUTER_API_KEY: CONTAINER_KEY };
	const started = (run: Run) => run.dockerKey !== undefined;

	it("runs an image whose nest.commit label is the repo's HEAD", () => {
		const run = piRun({ ...key, STUB_IMAGE_LABELS: FRESH });
		assert.equal(run.status, 0, run.stderr);
		assert.ok(started(run));
		assert.doesNotMatch(run.stderr, /stale/);
	});

	it("stops for an image built from another commit and names the rebuild command", () => {
		const run = piRun({ ...key, STUB_IMAGE_LABELS: "0123456789abcdef0123456789abcdef01234567|0" });
		assert.equal(run.status, 65);
		assert.ok(!started(run), "docker run is not started");
		assert.match(run.stderr, new RegExp(`image pecker-nest-pi is stale: it was built from 0123456, the repo is at ${HEAD.slice(0, 7)}`));
		assert.match(run.stderr, /Build it again: .*\/scripts\/build-image\.sh/);
		assert.match(run.stderr, /PI_RUN_ALLOW_STALE_IMAGE=1/);
	});

	it("stops for an image built from a working tree with uncommitted changes", () => {
		const run = piRun({ ...key, STUB_IMAGE_LABELS: `${HEAD}|1` });
		assert.equal(run.status, 65);
		assert.ok(!started(run));
		assert.match(run.stderr, /uncommitted changes \(nest\.dirty=1\)/);
	});

	it("stops for an image without the label, as plain docker build leaves it", () => {
		for (const labels of ["|", "<no value>|<no value>"]) {
			const run = piRun({ ...key, STUB_IMAGE_LABELS: labels });
			assert.equal(run.status, 65, labels);
			assert.ok(!started(run));
			assert.match(run.stderr, /has no nest\.commit label/);
		}
	});

	it("PI_RUN_ALLOW_STALE_IMAGE=1 runs a stale image with a warning; other values do not", () => {
		for (const labels of ["0123456789abcdef0123456789abcdef01234567|0", `${HEAD}|1`, "|"]) {
			const run = piRun({ ...key, STUB_IMAGE_LABELS: labels, PI_RUN_ALLOW_STALE_IMAGE: "1" });
			assert.equal(run.status, 0, run.stderr);
			assert.ok(started(run), labels);
			assert.match(run.stderr, /warning: PI_RUN_ALLOW_STALE_IMAGE=1: running image pecker-nest-pi although/);
		}
		const run = piRun({ ...key, STUB_IMAGE_LABELS: `${HEAD}|1`, PI_RUN_ALLOW_STALE_IMAGE: "yes" });
		assert.equal(run.status, 65);
	});

	it("stops when the image does not exist, override or not", () => {
		const run = piRun({ ...key, PI_RUN_ALLOW_STALE_IMAGE: "1", STUB_NO_IMAGE: "1" });
		assert.equal(run.status, 65);
		assert.ok(!started(run), "docker run would try to pull the name from a registry");
		assert.match(run.stderr, /image pecker-nest-pi not found .*Build it: .*\/scripts\/build-image\.sh/);
	});

	it("checks the key before the image, so a missing key is reported first", () => {
		const run = piRun({ STUB_IMAGE_LABELS: "|" });
		assert.equal(run.status, 64);
	});
});

describe("scripts/build-image.sh", () => {
	/** A scratch repository with a copy of the script; `docker build` only records its arguments. */
	function scratchRepo() {
		const dir = mkdtempSync(join(tmpdir(), "nest-build-image-"));
		dirs.push(dir);
		const repo = join(dir, "repo");
		mkdirSync(join(repo, "scripts"), { recursive: true });
		mkdirSync(join(repo, "docker"));
		mkdirSync(join(dir, "bin"));
		copyFileSync(join(NEST, "scripts/build-image.sh"), join(repo, "scripts/build-image.sh"));
		chmodSync(join(repo, "scripts/build-image.sh"), 0o755);
		writeFileSync(join(repo, "docker/Dockerfile.pi"), "FROM scratch\n");
		writeFileSync(join(dir, "bin/docker"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$STUB_DIR/docker-args"\n`);
		chmodSync(join(dir, "bin/docker"), 0o755);
		const git = (...args: string[]) => spawnSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf-8" });
		git("init", "-q");
		git("add", "-A");
		git("commit", "-qm", "init");
		const build = (env: Record<string, string> = {}, ...args: string[]) => {
			const result = spawnSync(join(repo, "scripts/build-image.sh"), args, {
				encoding: "utf-8",
				env: { PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: dir, STUB_DIR: dir, ...env },
			});
			const recorded = existsSync(join(dir, "docker-args")) ? readFileSync(join(dir, "docker-args"), "utf-8").trim().split("\n") : [];
			return { ...result, args: recorded };
		};
		return { repo, head: git("rev-parse", "HEAD").stdout.trim(), build };
	}

	it("labels the image with HEAD and nest.dirty=0 for a clean working tree", () => {
		const { repo, head, build } = scratchRepo();
		const result = build();
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(result.args, [
			"build",
			"-t",
			"pecker-nest-pi",
			"-f",
			join(repo, "docker/Dockerfile.pi"),
			"--label",
			`nest.commit=${head}`,
			"--label",
			"nest.dirty=0",
			repo,
		]);
		assert.equal(result.stderr, "");
	});

	it("labels nest.dirty=1 and warns when the working tree has uncommitted changes", () => {
		const dirty = scratchRepo();
		writeFileSync(join(dirty.repo, "docker/Dockerfile.pi"), "FROM scratch\n# changed\n");
		const result = dirty.build();
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.args.includes(`nest.commit=${dirty.head}`));
		assert.ok(result.args.includes("nest.dirty=1"));
		assert.match(result.stderr, /warning: the working tree has uncommitted changes/);
		assert.match(result.stderr, /M docker\/Dockerfile\.pi/);
	});

	it("honours PI_IMAGE and passes extra arguments to docker build", () => {
		const { repo, build } = scratchRepo();
		const result = build({ PI_IMAGE: "nest-test" }, "--no-cache");
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.args[2], "nest-test");
		assert.deepEqual(result.args.slice(-2), ["--no-cache", repo]);
	});
});
