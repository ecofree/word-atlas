import assert from "node:assert/strict";
import { test } from "node:test";
import type { Atlas, WordRef } from "../atlas/types";
import { buildSession, newToday, todayPlan } from "../store/session";
import { dayKey, defaultSettings, emptyProgress } from "../store/store";
import { nextTodayRefresh } from "./today-clock";

const words: WordRef[] = ["known", "fresh-a", "fresh-b"].map((id, order) => ({ id, word: id, zh: `n. ${id}`, ipa: "", cefr: 0, topic: 0, media: 0, order }));
const atlas = { words, byId: new Map(words.map((word) => [word.id, word])) } as Atlas;
const card = (due: number) => ({ due, s: 2, d: 5, el: 0, sd: 1, ls: 0, reps: 1, lapses: 0, st: 2 as const, seen: 1 });

test("today refreshes at the nearest future due card and ignores already due records", () => {
  const now = new Date(2026, 9, 26, 10, 10, 10).getTime();
  assert.equal(nextTodayRefresh({ old: card(now - 1), next: card(now + 1500), later: card(now + 5000) }, now), now + 1500);
  assert.equal(nextTodayRefresh({ old: card(now) }, now), now + 50_000);
});

test("the local calendar boundary is a scheduled refresh even with no cards", () => {
  const now = new Date(2026, 9, 26, 23, 59, 59, 500).getTime();
  assert.equal(nextTodayRefresh({}, now), new Date(2026, 9, 27).getTime());
});

test("one supplied timestamp controls due cards and the daily new-word allowance", () => {
  const before = new Date(2026, 9, 26, 23, 59, 59).getTime();
  const after = before + 1000;
  const p = { ...emptyProgress("test"), cards: { known: card(after) }, days: { [dayKey(new Date(before))]: { n: 2, r: 2, c: 2, t: 10 } } };
  const settings = { ...defaultSettings, dailyNew: 2 };
  assert.equal(newToday(p, before), 2);
  assert.equal(newToday(p, after), 0);
  assert.deepEqual(todayPlan(atlas, p, settings, before), { due: [], fresh: [], minutes: 1 });
  assert.deepEqual(todayPlan(atlas, p, settings, after), { due: ["known"], fresh: ["fresh-a", "fresh-b"], minutes: 2 });
  const session = buildSession(atlas, p, settings, undefined, after);
  assert.equal(session.started, after);
  assert.deepEqual(session.reviewIds, ["known"]);
  assert.deepEqual(session.newIds, ["fresh-a", "fresh-b"]);
});
