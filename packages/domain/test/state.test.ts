import test from "node:test";
import assert from "node:assert/strict";
import {
	allowedRatings,
	calibrationError,
	canPoseProblem,
	kindRequiresPremises,
	nextStepState,
	probeStateFromWrong,
	readWrongAnswer,
	stateAfterCheck,
} from "../src/index.ts";

test("wrong answer splits into a gap and a misconception", () => {
	assert.equal(readWrongAnswer(false, true, false), "no_answer");
	assert.equal(readWrongAnswer(true, false, false), "no_answer"); // shortcut: no "why" asked yet
	assert.equal(readWrongAnswer(true, true, true), "wrong_reasoning");
	assert.equal(probeStateFromWrong("wrong_reasoning"), "contradicted");
	assert.equal(probeStateFromWrong("no_answer"), "absent");
});

test("a step reaches accepted only through a passed check", () => {
	assert.equal(nextStepState("planned", "present"), "presented");
	assert.equal(nextStepState("presented", "check_passed"), "accepted");
	assert.equal(nextStepState("presented", "check_failed"), "repaired");
	assert.equal(nextStepState("repaired", "present"), "presented");
	assert.equal(nextStepState("accepted", "check_failed"), "repaired");
	const skipped = nextStepState("planned", "check_passed");
	assert.ok(typeof skipped === "object" && "error" in skipped);
	const noSkipToRepaired = nextStepState("planned", "repair_done");
	assert.ok(typeof noSkipToRepaired === "object" && "error" in noSkipToRepaired);
});

test("upper ratings are unreachable without a correct answer (D-037)", () => {
	assert.deepEqual(allowedRatings("incorrect", 0), ["again"]);
	assert.deepEqual(allowedRatings("partial", 0), ["again"]);
	assert.deepEqual(allowedRatings("correct", 2), ["again", "good"]);
	assert.deepEqual(allowedRatings("correct", 0), ["again", "hard", "good", "easy"]);
});

test("hinted answers stay on the frontier, wrong ones keep their kind", () => {
	assert.equal(stateAfterCheck("correct", 0, "no_answer"), "held");
	assert.equal(stateAfterCheck("correct", 1, "no_answer"), "frontier");
	assert.equal(stateAfterCheck("incorrect", 0, "wrong_reasoning"), "contradicted");
	assert.equal(stateAfterCheck("incorrect", 0, "no_answer"), "absent");
});

test("at most one active practice problem", () => {
	assert.deepEqual(canPoseProblem([]), { ok: true });
	assert.ok("error" in canPoseProblem(["p1"]));
	const two = canPoseProblem(["p1", "p2"]);
	assert.ok(typeof two === "object" && "error" in two && two.error.includes("2 active"));
});

test("derivations need premises, foundations do not", () => {
	assert.equal(kindRequiresPremises("derivation"), true);
	assert.equal(kindRequiresPremises("foundation"), false);
});

test("calibration error grows when confidence is high and the answer is wrong", () => {
	assert.equal(calibrationError(5, false), 1);
	assert.equal(calibrationError(1, false), 0.2);
	assert.equal(calibrationError(5, true), 0);
	assert.equal(calibrationError(1, true), 0.8);
});
