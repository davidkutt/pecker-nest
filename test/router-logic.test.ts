import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { editedCodeSinceLastUser, nextPhase, physicalLevel } from "../extensions/lib/router-logic.ts";

const user = { role: "user", content: "add a parser" };
function edit(id: string, path: string, isError = false) {
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, name: "edit", arguments: { path } }] },
		{ role: "toolResult", toolCallId: id, toolName: "edit", isError },
	];
}

describe("editedCodeSinceLastUser", () => {
	it("is false before any edit", () => {
		assert.equal(editedCodeSinceLastUser([user]), false);
	});
	it("is true after a successful code edit", () => {
		assert.equal(editedCodeSinceLastUser([user, ...edit("c1", "src/a.ts")]), true);
	});
	it("ignores failed edits and documentation", () => {
		assert.equal(editedCodeSinceLastUser([user, ...edit("c1", "src/a.ts", true)]), false);
		assert.equal(editedCodeSinceLastUser([user, ...edit("c1", "PLAN.md")]), false);
	});
	it("only looks after the last user message", () => {
		assert.equal(editedCodeSinceLastUser([user, ...edit("c1", "src/a.ts"), user]), false);
	});
});

describe("nextPhase", () => {
	it("starts in plan and switches to build after the first code edit", () => {
		assert.equal(nextPhase(undefined, [user], false), "plan");
		assert.equal(nextPhase({ phase: "plan" }, [user, ...edit("c1", "src/a.ts")], false), "build");
	});
	it("stays in build", () => {
		assert.equal(nextPhase({ phase: "build" }, [user], false), "build");
	});
	it("returns to plan when /plan starts a task", () => {
		assert.equal(nextPhase({ phase: "build" }, [user], true), "plan");
	});
});

describe("physicalLevel", () => {
	it("plans at the selected level and builds one lower", () => {
		assert.equal(physicalLevel("plan", "high"), "high");
		assert.equal(physicalLevel("build", "high"), "medium");
		assert.equal(physicalLevel("build", "xhigh"), "high");
		assert.equal(physicalLevel("build", "medium"), "low");
	});
});
