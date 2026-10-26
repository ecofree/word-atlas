import assert from "node:assert/strict";
import { test } from "node:test";
import type { Atlas, WordRef } from "../atlas/types";
import { Rating } from "../store/srs";
import type { ActiveSession } from "../store/store";
import { shareSession } from "./shareSession";

test("a twenty-word shared card renders the full total while its mosaic remains nine words", async () => {
  const previous = new Map(["document", "navigator"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const drawn: string[] = [];
  const shared: File[] = [];
  const context = {
    fillRect() {}, save() {}, restore() {}, beginPath() {}, roundRect() {}, clip() {},
    fillText(text: string) { drawn.push(text); }, measureText(text: string) { return { width: text.length * 10 }; },
  };
  const canvas = { getContext: () => context, toBlob: (resolve: (blob: Blob) => void) => resolve(new Blob(["test png"], { type: "image/png" })) };
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement(tag: string) { assert.equal(tag, "canvas"); return canvas; },
    fonts: { load: async () => [] },
  } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    canShare: () => true,
    share: async ({ files }: { files: File[] }) => { shared.push(...files); },
  } });
  try {
    const words: WordRef[] = Array.from({ length: 20 }, (_, i) => ({ id: `word-${i}`, word: `Word ${i}`, zh: "词", ipa: "", cefr: 0, topic: 0, media: 0, order: i }));
    const atlas = { byId: new Map(words.map((w) => [w.id, w])), img: () => null } as unknown as Atlas;
    const session: ActiveSession = {
      id: "share-test", started: 0, finished: 1, index: 21,
      steps: [...words.map((w) => ({ id: w.id, kind: "meaning" as const })), { id: words[0].id, kind: "meaning", retry: true }],
      newIds: words.slice(0, 10).map((w) => w.id), reviewIds: words.slice(10).map((w) => w.id),
      graded: Object.fromEntries(words.map((w) => [w.id, Rating.Good])),
    };
    await shareSession(atlas, session);
    assert.equal(shared.length, 1, "the actual export path must receive a generated card");
    assert.equal(shared[0].type, "image/png");
    assert.ok(drawn.some((text) => text.includes("今天点亮了 20 颗星")));
    assert.ok(drawn.includes("学了 20 个词，首次正确 100%"));
    assert.equal(drawn.filter((text) => /^Word \d+$/.test(text)).length, 9);
    assert.ok(drawn.includes("新词 10 · 复习 10 · 需要再见面 0"));
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
