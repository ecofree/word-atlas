import assert from "node:assert/strict";
import { test } from "node:test";
import { requestEntry, type EntryResult } from "./entry-request";
import type { Entry } from "./types";

const entry: Entry = { id: "library", w: "library", uk: "", us: "", senses: [], ex: [], col: [], fam: [], syn: [], ant: [], tip: "", cefr: "A1", topic: "education", m: 0 };
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a failed entry request reports an error and an explicit retry can load the same word", async () => {
  let fail = true;
  let requests = 0;
  const states: EntryResult[] = [];
  const atlas = {
    peek: () => undefined,
    entry: async () => {
      requests++;
      if (fail) throw new Error("词条加载失败（503）");
      return entry;
    },
  };
  const cancel = requestEntry(atlas, entry.id, (state) => states.push(state));
  await settled();
  assert.equal(states.at(-1)?.error, "词条加载失败（503）");
  assert.equal(states.at(-1)?.entry, undefined);

  cancel();
  fail = false;
  requestEntry(atlas, entry.id, (state) => states.push(state));
  assert.deepEqual(states.at(-1), { entry: undefined, error: null });
  await settled();
  assert.equal(requests, 2);
  assert.deepEqual(states.at(-1), { entry, error: null });
});

test("changing the word or disposing the view ignores an older response and error", async () => {
  let resolveOld!: (value: Entry) => void;
  const old = new Promise<Entry>((resolve) => { resolveOld = resolve; });
  const states: EntryResult[] = [];
  const cancel = requestEntry({ peek: () => undefined, entry: () => old }, "old", (state) => states.push(state));
  await settled();
  cancel();
  requestEntry({ peek: () => entry, entry: async () => entry }, entry.id, (state) => states.push(state));
  resolveOld({ ...entry, id: "old" });
  await settled();
  assert.deepEqual(states.at(-1), { entry, error: null });
  assert.equal(states.length, 2);

  const errors: EntryResult[] = [];
  const stop = requestEntry({ peek: () => undefined, entry: async () => { throw new Error("late failure"); } }, entry.id, (state) => errors.push(state));
  stop();
  await settled();
  assert.deepEqual(errors, [{ entry: undefined, error: null }]);
});

test("cached entries and an empty selection do not start a network request", () => {
  let requests = 0;
  const atlas = { peek: () => entry, entry: async () => { requests++; return entry; } };
  const states: EntryResult[] = [];
  requestEntry(atlas, entry.id, (state) => states.push(state));
  requestEntry(atlas, null, (state) => states.push(state));
  assert.equal(requests, 0);
  assert.deepEqual(states, [{ entry, error: null }, { entry: undefined, error: null }]);
});
