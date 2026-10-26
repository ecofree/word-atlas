import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { publishAtlasRelease } from "../../scripts/atlas-release";
import { loadOpenAtlas } from "./data";
import type { Entry, IndexRow } from "./types";

function entry(id: string, zh = id): Entry {
  return { id, w: id, uk: "", us: "", senses: [{ pos: "n.", zh, en: id }], ex: [{ en: id, zh }], col: [], fam: [], syn: [], ant: [], tip: "", cefr: "A1", topic: "daily", m: 0 };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-release-test-"));
  const source = path.join(root, "public", "atlas");
  const output = path.join(root, "dist", "atlas");
  fs.mkdirSync(path.join(source, "entries"), { recursive: true });
  const write = (entries: Entry[]) => {
    const words: IndexRow[] = entries.map((e) => [e.id, e.w, e.senses[0].zh, "", 0, 0, 0]);
    fs.writeFileSync(path.join(source, "index.json"), JSON.stringify({ id: "test", name: "Test", count: entries.length, examples: entries.length, illustrated: 0, chunk: 1, topics: [["daily", "生活"]], cefr: ["A1"], words }));
    entries.forEach((e, n) => fs.writeFileSync(path.join(source, "entries", `${n}.json`), JSON.stringify([e])));
  };
  write([entry("apple"), entry("banana")]);
  return { root, source, output, write, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Use the real Fetch integrity implementation with local data URLs; no HTTP server or browser crypto required. */
function serve(output: string, requested: string[] = [], bodyOverride?: (relative: string, body: string) => string): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    requested.push(url);
    const relative = url.slice(url.indexOf("/atlas/") + "/atlas/".length);
    let body = fs.readFileSync(path.join(output, relative), "utf8");
    if (bodyOverride) body = bodyOverride(relative, body);
    return fetch(`data:application/json;base64,${Buffer.from(body).toString("base64")}`, init);
  };
}

test("a release publishes only complete content-addressed chunks and leaves public sources untouched", () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(path.join(f.source, "index.json"));
    const sourceChunk = fs.readFileSync(path.join(f.source, "entries/0.json"));
    const release = publishAtlasRelease(f.source, f.output);
    const index = JSON.parse(fs.readFileSync(path.join(f.output, "index.json"), "utf8"));
    assert.deepEqual(index.release, release);
    assert.equal(release.chunks.length, 2);
    for (const chunk of release.chunks) {
      const bytes = fs.readFileSync(path.join(f.output, chunk.file));
      const hash = createHash("sha256").update(bytes).digest();
      assert.ok(chunk.file.endsWith(`.${hash.toString("hex")}.json`));
      assert.equal(chunk.integrity, `sha256-${hash.toString("base64")}`);
    }
    assert.deepEqual(fs.readFileSync(path.join(f.source, "index.json")), before);
    assert.deepEqual(fs.readFileSync(path.join(f.source, "entries/0.json")), sourceChunk);
  } finally { f.dispose(); }
});

test("new index order and corrected definitions cannot request a cached legacy or previous-release chunk", async () => {
  const f = fixture();
  try {
    const oldRelease = publishAtlasRelease(f.source, f.output);
    f.write([entry("banana", "修正后的释义"), entry("apple")]);
    const nextRelease = publishAtlasRelease(f.source, f.output);
    assert.notEqual(nextRelease.revision, oldRelease.revision);
    assert.notEqual(nextRelease.chunks[0].file, oldRelease.chunks[0].file);
    const requested: string[] = [];
    const atlas = await loadOpenAtlas(serve(f.output, requested), "/words/");
    const banana = await atlas.entry("banana");
    assert.equal(banana.senses[0].zh, "修正后的释义");
    assert.ok(requested.includes(`/words/atlas/${nextRelease.chunks[0].file}`));
    assert.ok(!requested.includes("/words/atlas/entries/0.json"));
    assert.ok(!requested.includes(`/words/atlas/${oldRelease.chunks[0].file}`));
  } finally { f.dispose(); }
});

test("wrong bytes at a versioned URL fail integrity and can be retried without poisoning the entry cache", async () => {
  const f = fixture();
  try {
    publishAtlasRelease(f.source, f.output);
    let broken = true;
    const request = serve(f.output, [], (file, body) => file.startsWith("entries/") && broken ? JSON.stringify([entry("apple", "旧释义")]) : body);
    const atlas = await loadOpenAtlas(request);
    await assert.rejects(atlas.entry("apple"));
    assert.equal(atlas.peek("apple"), undefined);
    broken = false;
    assert.equal((await atlas.entry("apple")).senses[0].zh, "apple");
  } finally { f.dispose(); }
});

test("a malformed or missing source chunk does not replace an already published manifest", () => {
  const f = fixture();
  try {
    publishAtlasRelease(f.source, f.output);
    const before = fs.readFileSync(path.join(f.output, "index.json"));
    fs.writeFileSync(path.join(f.source, "entries/1.json"), JSON.stringify([entry("wrong")]));
    assert.throws(() => publishAtlasRelease(f.source, f.output), /does not match/);
    assert.deepEqual(fs.readFileSync(path.join(f.output, "index.json")), before);
    fs.unlinkSync(path.join(f.source, "entries/1.json"));
    assert.throws(() => publishAtlasRelease(f.source, f.output), /ENOENT/);
    assert.deepEqual(fs.readFileSync(path.join(f.output, "index.json")), before);
  } finally { f.dispose(); }
});

test("legacy development data rejects a mismatched chunk and remains retryable", async () => {
  const f = fixture();
  try {
    let broken = true;
    const requested: string[] = [];
    const atlas = await loadOpenAtlas(serve(f.source, requested, (file, body) => file === "entries/0.json" && broken ? JSON.stringify([entry("banana")]) : body));
    await assert.rejects(atlas.entry("apple"), /分块与索引不一致/);
    assert.equal(atlas.peek("banana"), undefined);
    broken = false;
    assert.equal((await atlas.entry("apple")).id, "apple");
    assert.equal(requested.filter((url) => url.endsWith("entries/0.json")).length, 2);
  } finally { f.dispose(); }
});

test("repeated release is deterministic and does not truncate existing immutable files", () => {
  const f = fixture();
  try {
    const first = publishAtlasRelease(f.source, f.output);
    const file = path.join(f.output, first.chunks[0].file);
    const fixedTime = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(file, fixedTime, fixedTime);
    const second = publishAtlasRelease(f.source, f.output);
    assert.deepEqual(second, first);
    assert.equal(fs.statSync(file).mtimeMs, fixedTime.getTime());
    assert.throws(() => publishAtlasRelease(f.source, f.source), /must not overlap/);
    assert.throws(() => publishAtlasRelease(f.source, path.dirname(f.source)), /must not overlap/);
    assert.throws(() => publishAtlasRelease(f.source, path.parse(f.source).root), /must not overlap/);
    assert.throws(() => publishAtlasRelease(f.source, path.join(f.source, "dist")), /must not overlap/);
    const alias = path.join(f.root, "public-alias");
    fs.symlinkSync(f.source, alias, "dir");
    assert.throws(() => publishAtlasRelease(f.source, path.join(alias, "new-output")), /must not overlap/);
  } finally { f.dispose(); }
});

test("production loading refuses an unversioned legacy index while local development remains compatible", async () => {
  const f = fixture();
  try {
    const requests: string[] = [];
    await assert.rejects(loadOpenAtlas(serve(f.source, requests), "/words/", true), /索引版本无效/);
    assert.deepEqual(requests, ["/words/atlas/index.json"]);
    const development = await loadOpenAtlas(serve(f.source), "/words/", false);
    assert.equal((await development.entry("apple")).id, "apple");
    publishAtlasRelease(f.source, f.output);
    const production = await loadOpenAtlas(serve(f.output), "/words/", true);
    assert.equal((await production.entry("banana")).id, "banana");
  } finally { f.dispose(); }
});

test("malformed production manifests are rejected before any chunk request", async () => {
  const f = fixture();
  try {
    publishAtlasRelease(f.source, f.output);
    const indexFile = path.join(f.output, "index.json");
    const original = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    const badIndexes = [
      { ...original, release: { ...original.release, chunks: [] } },
      { ...original, release: { ...original.release, chunks: [{ file: "../other.json", integrity: original.release.chunks[0].integrity }, original.release.chunks[1]] } },
      { ...original, release: { ...original.release, chunks: [{ ...original.release.chunks[0], integrity: "" }, original.release.chunks[1]] } },
    ];
    for (const index of badIndexes) {
      fs.writeFileSync(indexFile, JSON.stringify(index));
      const requests: string[] = [];
      await assert.rejects(loadOpenAtlas(serve(f.output, requests)), /索引版本无效/);
      assert.equal(requests.length, 1);
    }
  } finally { f.dispose(); }
});
