import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { publishOfflineRelease, type OfflineRelease } from "../../scripts/offline-release";
import { offlineResource } from "./offline";

const template = fs.readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const scope = "https://example.test/words/";
const version = "a".repeat(64), oldVersion = "b".repeat(64);
const prefix = `word-atlas:${encodeURIComponent(scope)}:`;
const release: OfflineRelease = {
  format: 1, version, atlasRevision: "c".repeat(64), mediaRevision: "d".repeat(64),
  files: [{ path: "index.html", integrity: "sha256-test" }, { path: "assets/font.woff2", integrity: "sha256-font" }],
};
const key = (value: Request | string) => typeof value === "string" ? value : value.url;

function worker(network: (request: Request) => Promise<Response> = async () => new Response("0123456789", { headers: { "Content-Type": "audio/mpeg" } })) {
  const stores = new Map<string, Map<string, Response>>();
  const requests: Request[] = [];
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  let claimed = 0, skipped = 0, failWrites = false, failReads = false;
  const fetcher = async (request: Request) => { requests.push(request); return network(request); };
  const caches = {
    keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name),
    open: async (name: string) => {
      if (failReads) throw new Error("Cache storage unavailable");
      if (!stores.has(name)) stores.set(name, new Map());
      const values = stores.get(name)!;
      return {
        match: async (request: Request | string) => values.get(key(request))?.clone(),
        keys: async () => [...values.keys()].map((url) => new Request(url)),
        delete: async (request: Request | string) => values.delete(key(request)),
        put: async (request: Request | string, response: Response) => {
          if (failWrites) throw new Error("Quota exceeded");
          if (response.status === 206) throw new TypeError("Partial responses cannot be cached");
          values.set(key(request), response.clone());
        },
        addAll: async (list: Request[]) => {
          const responses = await Promise.all(list.map(fetcher));
          if (responses.some((response) => !response.ok || response.status === 206)) throw new TypeError("Incomplete precache");
          responses.forEach((response, index) => values.set(list[index].url, response.clone()));
        },
      };
    },
  };
  const context = vm.createContext({
    URL, Request, Response, Headers, btoa, caches, fetch: fetcher,
    self: { registration: { scope }, clients: { claim: async () => { claimed++; } }, skipWaiting: async () => { skipped++; },
      addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => listeners.set(name, listener) },
  });
  vm.runInContext(template.replace("/* __ATLAS_OFFLINE_RELEASE__ */ null", JSON.stringify(release)), context);
  return {
    stores, requests, caches, claimed: () => claimed, skipped: () => skipped,
    failWrites: () => { failWrites = true; },
    failReads: () => { failReads = true; },
    evaluate: <T,>(expression: string): T => vm.runInContext(expression, context),
    async event(name: string, fields: Record<string, unknown> = {}) {
      const promises: Promise<unknown>[] = [];
      listeners.get(name)!({ ...fields, waitUntil: (promise: Promise<unknown>) => promises.push(promise) });
      await Promise.all(promises);
    },
    respond(request: Request): Promise<Response> | undefined {
      let response: Promise<Response> | undefined;
      listeners.get("fetch")!({ request, respondWith: (result: Promise<Response>) => { response = result; } });
      return response;
    },
  };
}

test("offline build includes emitted fonts and assets, verifies every byte, and changes only with release content", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-offline-build-"));
  try {
    const contents: Record<string, string> = {
      "index.html": "<html>shell</html>", "atlas/index.json": JSON.stringify({ release: { revision: "c".repeat(64) } }),
      "manifest.webmanifest": "{}", "favicon.svg": "<svg/>", "icon-512.png": "icon", "brand/hero.webp": "hero",
      "assets/app.js": "app", "assets/style.css": "styles", "assets/font.woff2": "font", "assets/lazy/chunk.js": "lazy",
    };
    for (const [file, data] of Object.entries(contents)) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.writeFileSync(path.join(directory, file), data);
    }
    const first = publishOfflineRelease(directory, template);
    assert.deepEqual(first.files.map((file) => file.path), Object.keys(contents).sort());
    for (const file of first.files) {
      assert.equal(file.integrity, `sha256-${createHash("sha256").update(contents[file.path]).digest("base64")}`);
      assert.equal(fs.readFileSync(path.join(directory, file.path), "utf8"), contents[file.path]);
    }
    assert.deepEqual(publishOfflineRelease(directory, template), first);
    fs.mkdirSync(path.join(directory, "atlas/audio/uk"), { recursive: true });
    fs.writeFileSync(path.join(directory, "atlas/audio/uk/apple.mp3"), "corrected audio");
    const mediaChange = publishOfflineRelease(directory, template);
    assert.notEqual(mediaChange.version, first.version);
    assert.notEqual(mediaChange.mediaRevision, first.mediaRevision);
    assert.deepEqual(mediaChange.files, first.files, "Media changes update the release without downloading unseen recordings.");
    fs.writeFileSync(path.join(directory, "assets/font.woff2"), "new-font");
    assert.notEqual(publishOfflineRelease(directory, template).version, first.version);
    const existingWorker = fs.readFileSync(path.join(directory, "sw.js"));
    fs.unlinkSync(path.join(directory, "icon-512.png"));
    assert.throws(() => publishOfflineRelease(directory, template), /ENOENT/);
    assert.deepEqual(fs.readFileSync(path.join(directory, "sw.js")), existingWorker);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("installation waits for the complete verified shell and preserves normal update waiting", async () => {
  let finish!: () => void;
  const delayed = new Promise<void>((resolve) => { finish = resolve; });
  const h = worker(async (request) => { if (request.url.endsWith(".woff2")) await delayed; return new Response("body"); });
  const installed = h.event("install");
  await Promise.resolve();
  assert.equal(h.stores.get(`${prefix}${version}:shell`)?.size, 0);
  finish();
  await installed;
  assert.equal(h.stores.get(`${prefix}${version}:shell`)?.size, 2);
  assert.ok(h.requests.every((request) => request.integrity && request.cache === "reload"));
  assert.equal(h.skipped(), 0);
});

test("failed installation removes only its incomplete shell", async () => {
  const h = worker(async (request) => new Response("body", { status: request.url.endsWith(".woff2") ? 503 : 200 }));
  h.stores.set(`${prefix}${oldVersion}:shell`, new Map());
  await assert.rejects(h.event("install"), /Incomplete precache/);
  assert.equal(h.stores.has(`${prefix}${version}:shell`), false);
  assert.equal(h.stores.has(`${prefix}${oldVersion}:shell`), true);
});

test("activation deletes only this scope's obsolete namespaces and preserves other applications and legacy caches", async () => {
  const h = worker();
  const current = `${prefix}${version}:shell`, old = `${prefix}${oldVersion}:media`;
  const retained = [current, "foreign-app-v1", "atlas-v1-shell", "atlas-v1-media", `${prefix}not-an-atlas-cache`,
    `word-atlas:${encodeURIComponent("https://example.test/other/")}:${oldVersion}:shell`];
  for (const name of [old, ...retained]) h.stores.set(name, new Map());
  await h.event("activate");
  assert.deepEqual([...h.stores.keys()].sort(), retained.sort());
  assert.equal(h.claimed(), 1);
});

test("single byte ranges produce exact 206 bodies and 416 metadata without overflowing", async () => {
  const h = worker();
  const ranged = h.evaluate<(request: Request, response: Response) => Promise<Response>>("rangedResponse");
  for (const [range, status, body, contentRange] of [
    ["bytes=2-4", 206, "234", "bytes 2-4/10"], ["bytes=7-", 206, "789", "bytes 7-9/10"],
    ["bytes=-3", 206, "789", "bytes 7-9/10"], ["bytes=7-99", 206, "789", "bytes 7-9/10"],
    ["bytes=-999999999999999999999999", 206, "0123456789", "bytes 0-9/10"],
    ["bytes=10-", 416, "", "bytes */10"], ["bytes=-0", 416, "", "bytes */10"],
    ["bytes=999999999999999999999999-", 416, "", "bytes */10"],
  ] as const) {
    const response = await ranged(new Request(`${scope}atlas/audio/uk/test.mp3`, { headers: { Range: range } }), new Response("0123456789", { headers: { "Content-Type": "audio/mpeg" } }));
    assert.equal(response.status, status, range);
    assert.equal(await response.text(), body, range);
    assert.equal(response.headers.get("Content-Range"), contentRange);
    assert.equal(response.headers.get("Content-Length"), String(body.length));
    assert.equal(response.headers.get("Content-Type"), "audio/mpeg");
  }
  const empty = await ranged(new Request(scope, { headers: { Range: "bytes=0-" } }), new Response(""));
  assert.equal(empty.status, 416);
  assert.equal(empty.headers.get("Content-Range"), "bytes */0");
});

test("encoded media, unsupported ranges and failed If-Range validators return the intact full representation", async () => {
  const ranged = worker().evaluate<(request: Request, response: Response) => Promise<Response>>("rangedResponse");
  for (const [range, requestHeaders, responseHeaders] of [
    ["items=0-1", {}, {}], ["bytes=0-1,5-6", {}, {}], ["bytes=invalid", {}, {}],
    ["bytes=0-1", {}, { "Content-Encoding": "gzip" }],
    ["bytes=0-1", { "If-Range": '"old"' }, { ETag: '"new"' }],
    ["bytes=0-1", { "If-Range": 'W/"new"' }, { ETag: 'W/"new"' }],
  ] as [string, Record<string, string>, Record<string, string>][]) {
    const response = await ranged(new Request(scope, { headers: { Range: range, ...requestHeaders } }), new Response("0123456789", { headers: responseHeaders }));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "0123456789");
  }
  const matching = await ranged(new Request(scope, { headers: { Range: "bytes=0-1", "If-Range": '"same"' } }), new Response("0123456789", { headers: { ETag: '"same"' } }));
  assert.equal(matching.status, 206);
});

test("a first audio Range fetches and caches the full 200 then serves subsequent ranges without network", async () => {
  let offline = false;
  const h = worker(async (request) => {
    assert.equal(request.headers.get("Range"), null);
    if (offline) throw new Error("offline");
    return new Response("0123456789", { headers: { "Content-Type": "audio/mpeg" } });
  });
  const url = `${scope}atlas/audio/uk/test.mp3`;
  const first = await h.respond(new Request(url, { headers: { Range: "bytes=2-4" } }));
  assert.equal(first?.status, 206); assert.equal(await first?.text(), "234");
  const cached = await (await h.caches.open(`${prefix}${version}:media`)).match(url);
  assert.equal(cached?.status, 200); assert.equal(await cached?.text(), "0123456789");
  offline = true;
  assert.equal(await (await h.respond(new Request(url, { headers: { Range: "bytes=-3" } })))?.text(), "789");
  assert.equal(h.requests.length, 1);
});

test("partial origin responses are never promoted into complete cached media", async () => {
  const h = worker(async () => new Response("01", { status: 206, headers: { "Content-Range": "bytes 0-1/10" } }));
  const url = `${scope}atlas/audio/uk/partial.mp3`;
  const response = await h.respond(new Request(url, { headers: { Range: "bytes=0-1" } }));
  assert.equal(response?.status, 206);
  assert.equal((await (await h.caches.open(`${prefix}${version}:media`)).keys()).length, 0);
  assert.equal(h.requests.length, 2, "Fall back to the original range without treating a partial body as complete.");
});

test("concurrent audio reads share one full download and cache quota failure does not break playback", async () => {
  const h = worker();
  h.failWrites();
  const url = `${scope}atlas/audio/us/word.mp3`;
  const [a, b] = await Promise.all([h.respond(new Request(url, { headers: { Range: "bytes=0-1" } })), h.respond(new Request(url, { headers: { Range: "bytes=8-" } }))]);
  assert.equal(await a?.text(), "01"); assert.equal(await b?.text(), "89");
  assert.equal(h.requests.length, 1);
});

test("unavailable CacheStorage degrades to an online full download and a valid Range response", async () => {
  const h = worker();
  h.failReads();
  const response = await h.respond(new Request(`${scope}atlas/audio/uk/test.mp3`, { headers: { Range: "bytes=3-5" } }));
  assert.equal(response?.status, 206);
  assert.equal(await response?.text(), "345");
  assert.equal(h.requests.length, 1);
});

test("an explicit runtime reload replaces a stale full response and falls back to cached bytes while offline", async () => {
  let body = "bad recording";
  let offline = false;
  const h = worker(async () => { if (offline) throw new Error("offline"); return new Response(body); });
  const url = `${scope}atlas/audio/uk/retry.mp3`;
  assert.equal(await (await h.respond(new Request(url)))?.text(), body);
  body = "repaired recording";
  assert.equal(await (await h.respond(new Request(url)))?.text(), "bad recording");
  assert.equal(await (await h.respond(new Request(url, { cache: "reload" })))?.text(), body);
  offline = true;
  assert.equal(await (await h.respond(new Request(url, { cache: "reload" })))?.text(), body);
  assert.equal(await (await h.respond(new Request(url)))?.text(), body);
  assert.equal(h.requests.length, 3);
});

test("first-visit messages cache only approved resources from an in-scope client", async () => {
  const h = worker();
  const allowed = `${scope}atlas/img/apple.webp`;
  const denied = ["https://elsewhere.test/words/atlas/img/apple.webp", "https://example.test/other/atlas/img/apple.webp",
    `${scope}../private.json`, `${scope}atlas/entries/0.json`, `${allowed}?redirect=elsewhere`, "http://["];
  let acknowledgement: { cached: string[] } | undefined;
  await h.event("message", { source: { url: `${scope}index.html` }, data: { type: "CACHE_VISITED", urls: [allowed, ...denied] },
    ports: [{ postMessage: (value: { cached: string[] }) => { acknowledgement = value; } }] });
  assert.deepEqual(h.requests.map((request) => request.url), [allowed]);
  assert.deepEqual(Array.from(acknowledgement?.cached ?? []), [allowed]);
  await h.event("message", { source: { url: "https://example.test/other/" }, data: { type: "CACHE_VISITED", urls: [allowed] } });
  assert.equal(h.requests.length, 1);
  for (const url of [allowed, `${scope}atlas/entries/0.${"f".repeat(64)}.json`, `${scope}sfx/key.mp3`]) assert.equal(offlineResource(url, scope), true);
  for (const url of denied) assert.equal(offlineResource(url, scope), false, url);
});
