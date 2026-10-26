import assert from "node:assert/strict";
import { test } from "node:test";
import { practiceTarget, samplePracticeIds, TypingRun } from "./practice";

test("practice samples ten distinct ids from the whole eligible source", () => {
  const pool = Array.from({ length: 400 }, (_, i) => `word-${i}`);
  const before = [...pool];
  const selected = samplePracticeIds(pool, 12345);
  assert.equal(selected.length, 10);
  assert.equal(new Set(selected).size, 10);
  assert.ok(selected.some((id) => Number(id.slice(5)) >= 60));
  assert.deepEqual(pool, before);
  assert.deepEqual(samplePracticeIds(["a", "a", "b"], 1).sort(), ["a", "b"]);
});

test("typing follows an explicitly accepted spelling without showing it as an error", () => {
  const forms = ["cheque", "check"];
  assert.equal(practiceTarget(forms, ""), "cheque");
  assert.equal(practiceTarget(forms, "che"), "cheque");
  assert.equal(practiceTarget(forms, "chec"), "check");
  assert.equal(practiceTarget(forms, "CHECK"), "check");
});

test("a completed item rejects repeated input during its transition and advances once", () => {
  const run = new TypingRun(2);
  run.setActive(true, 0);
  run.change("c", "cat", false, 0);
  assert.deepEqual(run.change("cat", "cat", true, 1000), { inserted: 2, completed: true });
  const completed = run.snapshot();
  assert.equal(run.change("cat ", "cat", true, 1100), null);
  assert.equal(run.change("cat", "cat", true, 1200), null);
  assert.deepEqual(run.snapshot(), completed);
  assert.deepEqual(completed.totals, { typed: 3, correct: 3, accepted: 3, ms: 1000 });
  assert.equal(run.advance(), true);
  assert.equal(run.advance(), false);
  assert.equal(run.snapshot().index, 1);
});

test("hidden or readonly time pauses an unfinished item and preserves its input", () => {
  const run = new TypingRun(1);
  run.setActive(true, 0);
  run.change("c", "cat", false, 0);
  run.setActive(false, 400);
  const paused = run.snapshot();
  assert.equal(run.change("cat", "cat", true, 50_000), null);
  assert.deepEqual(run.snapshot(), paused);
  run.setActive(true, 60_000);
  run.change("cat", "cat", true, 60_600);
  assert.deepEqual(run.snapshot().totals, { typed: 3, correct: 3, accepted: 3, ms: 1000 });
  assert.equal(run.snapshot().phase, "saving");
});

test("a pending transition cannot advance while inactive and the next item starts a new timer", () => {
  const run = new TypingRun(2);
  run.setActive(true, 0);
  run.change("a", "a", true, 0);
  run.setActive(false, 100);
  assert.equal(run.advance(), false);
  run.setActive(true, 10_000);
  assert.equal(run.advance(), true);
  run.change("b", "be", false, 20_000);
  run.change("be", "be", true, 21_000);
  assert.equal(run.snapshot().totals.ms, 1000);
  assert.equal(run.snapshot().totals.accepted, 3);
});

test("the last item stays pending until persistence succeeds and cannot be completed twice", () => {
  const run = new TypingRun(1);
  run.setActive(true, 0);
  assert.equal(run.saved(), false);
  run.change("c", "cat", false, 0);
  run.change("cat", "cat", true, 1000);
  assert.equal(run.snapshot().phase, "saving");
  assert.equal(run.change("cat", "cat", true, 2000), null);
  assert.equal(run.advance(), false);
  assert.equal(run.saved(), true);
  assert.equal(run.saved(), false);
  assert.equal(run.snapshot().phase, "done");
  assert.equal(run.snapshot().totals.accepted, 3);
});
