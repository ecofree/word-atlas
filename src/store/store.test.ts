import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings, emptyProgress, sanitizeProgress, sanitizeSettings, validateBackup } from "./store";

const card = { due: 1, s: 2, d: 5, el: 0, sd: 1, ls: 0, reps: 1, lapses: 0, st: 2, seen: 1 };

test("keeps valid progress and drops malformed records", () => {
  const p = sanitizeProgress(
    {
      version: 2,
      cards: { ok: card, bad: { ...card, d: 99 }, worse: "x" },
      bookmarks: ["ok", 3],
      days: { "2026-10-25": { n: 1, r: 2, c: 1, t: 30 }, nope: { n: 1, r: 1, c: 1, t: 1 } },
      typing: [{ at: 1, mode: "word", items: 10, wpm: 40, accuracy: 98 }, { at: 1, mode: "hack", items: 1, wpm: 1, accuracy: 1 }],
    },
    "word-atlas-open",
  );
  assert.deepEqual(Object.keys(p.cards), ["ok"]);
  assert.deepEqual(p.bookmarks, ["ok"]);
  assert.deepEqual(Object.keys(p.days), ["2026-10-25"]);
  assert.equal(p.typing.length, 1);
});

test("rejects other versions and unknown settings", () => {
  assert.deepEqual(sanitizeProgress({ version: 1, cards: { ok: card } }, "x").cards, {});
  const s = sanitizeSettings({ accent: "fr", dailyNew: 1e9, theme: "dark", retention: 0.5 });
  assert.equal(s.accent, "uk");
  assert.equal(s.dailyNew, 10);
  assert.equal(s.theme, "dark");
  assert.equal(s.retention, 0.9);
});

const backup = () => ({
  app: "word-atlas", version: 2,
  progress: { ...emptyProgress("word-atlas-open"), cards: { ok: card }, bookmarks: ["ok"] },
  settings: { ...defaultSettings },
});

test("backup replacement rejects missing or unsupported inner versions", () => {
  for (const version of [undefined, null, 1, 3, "2"]) {
    const data = { ...backup(), progress: { ...backup().progress, version } };
    assert.equal(validateBackup(data, "word-atlas-open").ok, false, `inner version ${version}`);
    assert.equal(Object.keys(data.progress.cards).length, 1, "validation cannot mutate its input");
  }
});

test("backup replacement rejects partial malformed data instead of dropping records", () => {
  const changes = [
    { cards: { ok: card, broken: { ...card, d: 99 } } },
    { bookmarks: ["ok", 4] },
    { days: { "2026-10-26": { n: 1, r: 1, c: 2, t: 5 } } },
    { typing: [{ at: 1, mode: "word", items: 10, wpm: 35, accuracy: 101 }] },
    { session: { index: 1, steps: [] } },
    { cards: JSON.parse('{"__proto__":{}}') },
  ];
  for (const change of changes) {
    assert.equal(validateBackup({ ...backup(), progress: { ...backup().progress, ...change } }, "word-atlas-open").ok, false);
  }
});

test("valid populated and empty backups remain importable for their own dataset", () => {
  const full = backup();
  const valid = validateBackup(full, "word-atlas-open");
  assert.equal(valid.ok, true);
  if (valid.ok) assert.deepEqual(valid.progress.cards, full.progress.cards);
  assert.equal(validateBackup({ ...full, progress: emptyProgress("word-atlas-open") }, "word-atlas-open").ok, true);
  assert.equal(validateBackup(full, "another-dataset").ok, false);
});
