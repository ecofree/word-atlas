#!/usr/bin/env node
/** Production-only SW regressions. Owns its builds, HTTP server, browser and isolated profiles.
 * node scripts/e2e-offline.mjs [--case install-root,audio-range] [--output /tmp/offline.json]
 * Uses the same ATLAS_CHROMIUM_* overrides as e2e-regressions.mjs.
 * Builds the real application and all 7,298 word entries; a few small valid media fixtures keep
 * this test independent of a multi-gigabyte full media checkout. No app-source imports in pages.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { chromium } from "playwright";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = {
  "install-root": (browser, origin) => installCase(browser, origin, "/"),
  "install-subpath": (browser, origin) => installCase(browser, origin, "/words/"),
  "audio-range": audioCase,
  "partial-media": partialCase,
  "scope-isolation": scopeCase,
  "message-boundaries": messageCase,
  "safe-upgrade": upgradeCase,
};
let output;
const selected = [];
for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i];
  if (argument === "--output" && process.argv[i + 1]) output = path.resolve(process.argv[++i]);
  else if (argument === "--case" && process.argv[i + 1]) selected.push(...process.argv[++i].split(","));
  else if (argument === "--list") { console.log(Object.keys(cases).join("\n")); process.exit(0); }
  else throw new Error(`Unknown or incomplete argument: ${argument}`);
}
const names = [...new Set(selected.length ? selected : Object.keys(cases))];
for (const name of names) if (!cases[name]) throw new Error(`Unknown case: ${name}`);
let extraArgs = process.env.ATLAS_CHROMIUM_ARGS ? JSON.parse(process.env.ATLAS_CHROMIUM_ARGS) : [];
if (process.env.ATLAS_CHROMIUM_ARGS_MODULE) {
  const module = await import(pathToFileURL(path.resolve(process.env.ATLAS_CHROMIUM_ARGS_MODULE)).href);
  extraArgs = [...(module.default?.args ?? module.args), ...extraArgs];
}
assert.ok(Array.isArray(extraArgs) && extraArgs.every((argument) => typeof argument === "string"));

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=", "base64");
const wave = Buffer.alloc(44 + 4800);
wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
wave.write("data", 36); wave.writeUInt32LE(wave.length - 44, 40);
for (let i = 44; i < wave.length; i += 2) wave.writeInt16LE(Math.round(Math.sin(i / 20) * 1000), i);
const settings = { accent: "uk", autoplay: false, dailyNew: 10, retention: 0.9, theme: "light", sfx: false,
  spell: true, startLevel: 0, onboarded: true, dataset: "open", ambience: "off", ambienceVolume: 0, splash: false };
const index = JSON.parse(await fs.readFile(path.join(root, "public/atlas/index.json"), "utf8"));
const targetIndex = index.words.findIndex((word) => word[6] & 1);
const target = index.words[targetIndex];
assert.ok(target, "The real atlas must include an illustrated word.");
const progress = { version: 2, datasetId: index.id, cards: {}, bookmarks: [], days: {}, typing: [], mistakes: [],
  session: { id: "offline-browser-session", started: Date.now(), index: 0, graded: {},
    steps: [{ id: target[0], kind: "intro" }, { id: target[0], kind: "meaning", options: index.words.slice(0, 4).map((row) => row[0]) }],
    newIds: [target[0]], reviewIds: [] } };
const state = { mounts: new Map(), delays: new Map(), failures: new Set(), mediaOverrides: new Map(), requests: [] };
let rootBuild, wordsBuild, nextBuild;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function buildFixture(temporary, base, label, publicDir) {
  const directory = path.join(temporary, label);
  await build({ root, publicDir, base, logLevel: "error", build: { outDir: directory, emptyOutDir: true } });
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "offline-manifest.json"), "utf8"));
  const atlas = JSON.parse(await fs.readFile(path.join(directory, "atlas/index.json"), "utf8"));
  for (const file of manifest.files) {
    const actual = createHash("sha256").update(await fs.readFile(path.join(directory, file.path))).digest("base64");
    assert.equal(file.integrity, `sha256-${actual}`, `Broken build address: ${file.path}`);
  }
  return { directory, manifest, atlas };
}

async function serve(request, response) {
  const url = new URL(request.url, "http://localhost");
  state.requests.push({ path: url.pathname, range: request.headers.range ?? null });
  await state.delays.get(url.pathname)?.promise;
  if (response.destroyed) return;
  if (state.failures.has(url.pathname)) { response.writeHead(503); response.end("fixture failure"); return; }
  if (["/seed.html", "/observer.html"].includes(url.pathname)) {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end("<!doctype html><title>Offline regression observer</title>"); return;
  }
  const mount = [...state.mounts.keys()].sort((a, b) => b.length - a.length).find((prefix) => url.pathname.startsWith(prefix));
  if (!mount) { response.writeHead(404); response.end(); return; }
  const relative = url.pathname.slice(mount.length) || "index.html";
  const directory = state.mounts.get(mount).directory;
  const file = path.resolve(directory, relative);
  if (!file.startsWith(`${directory}${path.sep}`)) { response.writeHead(404); response.end(); return; }
  let bytes;
  let type;
  if (/^atlas\/(?:img|thumb)\/[a-z0-9-]+\.webp$/.test(relative)) { bytes = pixel; type = "image/png"; }
  else if (/^atlas\/audio\/(?:uk|us|ex|ex2)\/[a-z0-9-]+\.mp3$/.test(relative)) { bytes = wave; type = "audio/wav"; }
  else {
    try { bytes = await fs.readFile(file); }
    catch { response.writeHead(404); response.end(); return; }
    type = ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
      ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp",
      ".jpg": "image/jpeg", ".woff2": "font/woff2", ".mp3": "audio/mpeg" })[path.extname(relative)] ?? "application/octet-stream";
  }
  const headers = { "Content-Type": type, "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
  bytes = state.mediaOverrides.get(url.pathname) ?? bytes;
  if (relative.endsWith("/encoded.mp3")) {
    const compressed = gzipSync(bytes);
    response.writeHead(200, { ...headers, "Content-Encoding": "gzip", "Content-Length": compressed.length });
    response.end(compressed); return;
  }
  if (relative.endsWith("/partial.mp3")) {
    response.writeHead(206, { ...headers, "Content-Range": `bytes 0-31/${bytes.length}`, "Content-Length": 32 });
    response.end(bytes.subarray(0, 32)); return;
  }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
  if (range) {
    const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    if (start > end || start >= bytes.length) { response.writeHead(416, { ...headers, "Content-Range": `bytes */${bytes.length}` }); response.end(); return; }
    response.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": end - start + 1 });
    response.end(bytes.subarray(start, end + 1)); return;
  }
  response.writeHead(200, { ...headers, "Content-Length": bytes.length });
  response.end(bytes);
}

const cacheName = (origin, base, build, kind) => `word-atlas:${encodeURIComponent(origin + base)}:${build.manifest.version}:${kind}`;
async function newCase(browser, origin, base = "/words/", slow = false) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "allow", reducedMotion: "reduce" });
  await context.addInitScript(({ origin, base, settings, progress, slow }) => {
    if (location.origin !== origin) return;
    if (localStorage.getItem("word-atlas:settings") === null) localStorage.setItem("word-atlas:settings", JSON.stringify(settings));
    const key = `word-atlas:v2:${progress.datasetId}`;
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(progress));
    window.__loaded = false;
    window.__initialController = navigator.serviceWorker.controller?.scriptURL ?? null;
    window.addEventListener("load", () => { window.__loaded = true; });
    if (slow) document.addEventListener("DOMContentLoaded", () => {
      const image = new Image(); image.id = "precontrol-image"; image.src = `${base}atlas/img/precontrol.webp`; document.body.append(image);
      window.__earlyAudio = fetch(`${base}atlas/audio/uk/precontrol.mp3`, { headers: { Range: "bytes=0-43" } }).then((response) => response.arrayBuffer()).then((bytes) => bytes.byteLength);
    });
  }, { origin, base, settings, progress, slow });
  const pageErrors = [];
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return { context, page, pageErrors };
}

async function controlled(page) {
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}
async function cacheContains(page, name, urls) {
  await page.waitForFunction(async ({ name, urls }) => {
    if (!(await caches.keys()).includes(name)) return false;
    const cache = await caches.open(name);
    return (await Promise.all(urls.map((url) => cache.match(url)))).every((response) => response?.status === 200);
  }, { name, urls });
}
async function responseBytes(page, url, range) {
  return page.evaluate(async ({ url, range }) => {
    const response = await fetch(url, { headers: range ? { Range: range } : {} });
    return { status: response.status, contentRange: response.headers.get("Content-Range"), length: response.headers.get("Content-Length"),
      bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  }, { url, range });
}

async function installCase(browser, origin, base) {
  const build = base === "/" ? rootBuild : wordsBuild;
  const scriptGate = gate(), imageGate = gate();
  state.delays.set(`${base}sw.js`, scriptGate);
  state.delays.set(`${base}atlas/img/precontrol.webp`, imageGate);
  const { context, page, pageErrors } = await newCase(browser, origin, base, true);
  try {
    await page.goto(`${origin}${base}#/learn`, { waitUntil: "domcontentloaded" });
    await page.locator(".intro").waitFor();
    assert.equal(await page.evaluate(() => window.__initialController), null);
    await page.waitForFunction(() => performance.getEntriesByType("resource").some((entry) => entry.name.includes("/precontrol.mp3")));
    // Registration must already be in flight while the slow image keeps window.load pending.
    assert.ok(state.requests.some((request) => request.path === `${base}sw.js`));
    assert.equal(await page.evaluate(() => window.__loaded), false);
    scriptGate.resolve();
    await controlled(page);
    assert.equal(await page.evaluate(() => window.__loaded), false, "Installing the worker must not wait for window.load.");
    const shell = cacheName(origin, base, build, "shell");
    await cacheContains(page, shell, build.manifest.files.map((file) => `${origin}${base}${file.path}`));
    imageGate.resolve();
    await page.waitForLoadState("load");
    const chunk = build.atlas.release.chunks[Math.floor(targetIndex / build.atlas.chunk)].file;
    await cacheContains(page, cacheName(origin, base, build, "data"), [`${origin}${base}atlas/${chunk}`]);
    await cacheContains(page, cacheName(origin, base, build, "media"), [
      `${origin}${base}atlas/img/precontrol.webp`, `${origin}${base}atlas/audio/uk/precontrol.mp3`,
    ]);
    const cachedAudioLength = await page.evaluate(async ({ name, url }) => (await (await (await caches.open(name)).match(url)).arrayBuffer()).byteLength,
      { name: cacheName(origin, base, build, "media"), url: `${origin}${base}atlas/audio/uk/precontrol.mp3` });
    assert.equal(cachedAudioLength, wave.length, "An early partial request must be supplemented with the complete recording.");
    await context.setOffline(true);
    await page.reload({ waitUntil: "load" });
    await page.locator(".intro").waitFor();
    assert.equal(await page.locator("#precontrol-image").evaluate((image) => image.complete && image.naturalWidth > 0), true);
    const offlineIndex = await page.evaluate(async (url) => (await (await fetch(url)).json()).release.revision, `${origin}${base}atlas/index.json`);
    assert.equal(offlineIndex, build.atlas.release.revision);
    await page.goto(`${origin}${base}?utm_source=offline-test#/learn`, { waitUntil: "load" });
    await page.locator(".intro").waitFor();
    assert.deepEqual(pageErrors, []);
    return { scope: base, shellFiles: build.manifest.files.length, fonts: build.manifest.files.filter((file) => file.path.endsWith(".woff2")).length,
      registeredBeforeLoad: true, initialController: null, firstVisitDataCached: true, lateImageCached: true,
      earlyAudioBytes: cachedAudioLength, firstOfflineRefresh: true, queryNavigationOffline: true, pageErrors };
  } finally { scriptGate.resolve(); imageGate.resolve(); state.delays.clear(); await context.close(); }
}

async function audioCase(browser, origin) {
  const { context, page, pageErrors } = await newCase(browser, origin);
  try {
    await page.goto(`${origin}/words/#/learn`, { waitUntil: "load" }); await controlled(page);
    const url = `${origin}/words/atlas/audio/uk/offline-test.mp3`;
    const before = state.requests.length;
    const first = await responseBytes(page, url, "bytes=10-29");
    assert.equal(first.status, 206); assert.deepEqual(first.bytes, [...wave.subarray(10, 30)]);
    const downloads = state.requests.slice(before).filter((request) => request.path.endsWith("/offline-test.mp3"));
    assert.deepEqual(downloads.map((request) => request.range), [null]);
    await cacheContains(page, cacheName(origin, "/words/", wordsBuild, "media"), [url]);
    const encodedURL = `${origin}/words/atlas/audio/uk/encoded.mp3`;
    const encoded = await responseBytes(page, encodedURL, "bytes=0-9");
    assert.equal(encoded.status, 200); assert.deepEqual(encoded.bytes, [...wave]);
    const retryURL = `${origin}/words/atlas/audio/uk/retry.mp3`;
    state.mediaOverrides.set("/words/atlas/audio/uk/retry.mp3", Buffer.from("bad recording"));
    assert.equal(await page.evaluate(async (url) => (await fetch(url)).text(), retryURL), "bad recording");
    state.mediaOverrides.delete("/words/atlas/audio/uk/retry.mp3");
    assert.equal(await page.evaluate(async (url) => (await fetch(url)).text(), retryURL), "bad recording");
    assert.equal(await page.evaluate(async (url) => (await (await fetch(url, { cache: "reload" })).arrayBuffer()).byteLength, retryURL), wave.length);
    await context.setOffline(true);
    assert.equal(await page.evaluate(async (url) => (await (await fetch(url, { cache: "reload" })).arrayBuffer()).byteLength, retryURL), wave.length);
    for (const [range, start, end] of [["bytes=4-19", 4, 20], ["bytes=4800-", 4800, wave.length], ["bytes=-16", wave.length - 16, wave.length]]) {
      const response = await responseBytes(page, url, range);
      assert.equal(response.status, 206); assert.equal(response.contentRange, `bytes ${start}-${end - 1}/${wave.length}`);
      assert.equal(response.length, String(end - start)); assert.deepEqual(response.bytes, [...wave.subarray(start, end)]);
    }
    const unsatisfied = await responseBytes(page, url, `bytes=${wave.length}-`);
    assert.equal(unsatisfied.status, 416); assert.equal(unsatisfied.contentRange, `bytes */${wave.length}`); assert.equal(unsatisfied.bytes.length, 0);
    const playback = await page.evaluate((url) => new Promise((resolve, reject) => {
      const audio = new Audio(url); const timer = setTimeout(() => reject(new Error("Offline audio did not end")), 10_000);
      audio.onended = () => { clearTimeout(timer); resolve({ duration: audio.duration, readyState: audio.readyState }); };
      audio.onerror = () => { clearTimeout(timer); reject(new Error(`Offline audio failed: ${audio.error?.code}`)); };
      void audio.play().catch(reject);
    }), url);
    assert.ok(playback.duration > 0);
    assert.deepEqual(pageErrors, []);
    return { completeDownloadCount: downloads.length, cachedBytes: wave.length, offlineRanges: 3, unsatisfied: 416,
      encodedReturnedFull200: true, runtimeReloadRepairedCached200: true, offlineReloadPreservedCachedAudio: true, nativeOfflinePlayback: playback, pageErrors };
  } finally { state.mediaOverrides.clear(); await context.close(); }
}

async function partialCase(browser, origin) {
  const { context, page, pageErrors } = await newCase(browser, origin);
  try {
    await page.goto(`${origin}/words/#/learn`, { waitUntil: "load" }); await controlled(page);
    const url = `${origin}/words/atlas/audio/uk/partial.mp3`;
    const response = await responseBytes(page, url, "bytes=0-31");
    assert.equal(response.status, 206); assert.deepEqual(response.bytes, [...wave.subarray(0, 32)]);
    const stored = await page.evaluate(async ({ name, url }) => !!await (await caches.open(name)).match(url),
      { name: cacheName(origin, "/words/", wordsBuild, "media"), url });
    assert.equal(stored, false);
    assert.deepEqual(pageErrors, []);
    return { originReturned206: true, partialStoredAsComplete: false, pageErrors };
  } finally { await context.close(); }
}

async function scopeCase(browser, origin) {
  const { context, page, pageErrors } = await newCase(browser, origin);
  const old = "f".repeat(64), ownPrefix = `word-atlas:${encodeURIComponent(`${origin}/words/`)}:`;
  const ownOld = `${ownPrefix}${old}:data`;
  const retained = ["foreign-app-cache", "atlas-v1-shell", "atlas-v1-media",
    `word-atlas:${encodeURIComponent(`${origin}/other/`)}:${old}:shell`, `word-atlas:${encodeURIComponent(`${origin}/`)}:${old}:media`];
  try {
    await page.goto(`${origin}/seed.html`);
    await page.evaluate(async ({ names, url }) => {
      for (const name of names) await (await caches.open(name)).put(url, new Response("foreign sentinel"));
    }, { names: [ownOld, ...retained], url: `${origin}/words/atlas/index.json` });
    await page.goto(`${origin}/words/#/learn`, { waitUntil: "load" }); await controlled(page);
    const keys = await page.evaluate(() => caches.keys());
    assert.equal(keys.includes(ownOld), false);
    for (const name of retained) assert.ok(keys.includes(name), name);
    const revision = await page.evaluate(async (url) => (await (await fetch(url)).json()).release.revision, `${origin}/words/atlas/index.json`);
    assert.equal(revision, wordsBuild.atlas.release.revision, "Foreign or legacy cache contents must never satisfy this app's requests.");
    assert.deepEqual(pageErrors, []);
    return { removedOwnOldCache: true, preservedForeignAndOtherScopes: retained.length, indexFromOwnRelease: true, pageErrors };
  } finally { await context.close(); }
}

async function messageCase(browser, origin) {
  const { context, page, pageErrors } = await newCase(browser, origin);
  try {
    await page.goto(`${origin}/words/#/learn`, { waitUntil: "load" }); await controlled(page);
    const allowed = `${origin}/words/atlas/img/message-test.webp`;
    const before = state.requests.length;
    const cached = await page.evaluate((urls) => new Promise((resolve, reject) => {
      const channel = new MessageChannel(); const timer = setTimeout(() => reject(new Error("Cache message timed out")), 10_000);
      channel.port1.onmessage = (event) => { clearTimeout(timer); channel.port1.close(); resolve(event.data.cached); };
      navigator.serviceWorker.controller.postMessage({ type: "CACHE_VISITED", urls }, [channel.port2]);
    }), [allowed, `${origin}/other/atlas/img/no.webp`, `${origin}/words/../private.json`, "https://elsewhere.invalid/atlas/img/no.webp", "http://["]);
    assert.deepEqual(cached, [allowed]);
    assert.equal(state.requests.slice(before).some((request) => request.path.includes("private.json") || request.path.includes("/other/")), false);
    assert.deepEqual(pageErrors, []);
    return { permittedURLs: 1, rejectedURLs: 4, workerRemainedResponsive: true, pageErrors };
  } finally { await context.close(); }
}

async function updateOutcome(page) {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker update timed out")), 30_000);
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker.addEventListener("statechange", () => {
          if (["installed", "redundant"].includes(worker.state)) { clearTimeout(timer); resolve(worker.state); }
        });
      }, { once: true });
      registration.update().catch(reject);
    });
  });
}

async function upgradeCase(browser, origin) {
  const { context, page, pageErrors } = await newCase(browser, origin);
  const oldShell = cacheName(origin, "/words/", wordsBuild, "shell");
  const newShell = cacheName(origin, "/words/", nextBuild, "shell");
  const oldChunk = wordsBuild.atlas.release.chunks[Math.floor(targetIndex / index.chunk)].file;
  const nextChunk = nextBuild.atlas.release.chunks[Math.floor(targetIndex / index.chunk)].file;
  const brokenFile = nextBuild.manifest.files.find((file) => file.path.endsWith(".woff2")).path;
  try {
    await page.goto(`${origin}/words/#/learn`, { waitUntil: "load" }); await controlled(page);
    await cacheContains(page, cacheName(origin, "/words/", wordsBuild, "data"), [`${origin}/words/atlas/${oldChunk}`]);
    state.mounts.set("/words/", nextBuild);
    state.failures.add(`/words/${brokenFile}`);
    assert.equal(await updateOutcome(page), "redundant");
    const failedKeys = await page.evaluate(() => caches.keys());
    assert.ok(failedKeys.includes(oldShell)); assert.equal(failedKeys.includes(newShell), false);
    await context.setOffline(true); await page.reload({ waitUntil: "load" }); await page.locator(".intro").waitFor();
    await context.setOffline(false); state.failures.clear();
    assert.equal(await updateOutcome(page), "installed");
    assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).waiting?.state), "installed");
    await page.evaluate(() => { window.__controllerChanges = 0; navigator.serviceWorker.addEventListener("controllerchange", () => { window.__controllerChanges++; }); });
    await context.setOffline(true);
    const oldRevision = await page.evaluate(async (url) => (await (await fetch(url)).json()).release.revision, `${origin}/words/atlas/index.json`);
    assert.equal(oldRevision, wordsBuild.atlas.release.revision);
    assert.equal((await responseBytes(page, `${origin}/words/atlas/${oldChunk}`)).status, 200);
    assert.equal(await page.evaluate(() => window.__controllerChanges), 0);
    const waitingKeys = await page.evaluate(() => caches.keys());
    assert.ok(waitingKeys.includes(oldShell) && waitingKeys.includes(newShell));
    // Closing the old client, not a forced reload/claim, allows the new version to activate.
    await page.close();
    await context.setOffline(false);
    const observer = await context.newPage(); observer.setDefaultTimeout(30_000);
    observer.on("pageerror", (error) => pageErrors.push(error.message));
    await observer.goto(`${origin}/observer.html`);
    await observer.waitForFunction(async ({ oldShell, newShell }) => {
      const keys = await caches.keys(); return keys.includes(newShell) && !keys.includes(oldShell);
    }, { oldShell, newShell });
    await observer.goto(`${origin}/words/#/learn`, { waitUntil: "load" });
    await observer.locator(".intro").waitFor();
    await cacheContains(observer, cacheName(origin, "/words/", nextBuild, "data"), [`${origin}/words/atlas/${nextChunk}`]);
    const newRevision = await observer.evaluate(async (url) => (await (await fetch(url)).json()).release.revision, `${origin}/words/atlas/index.json`);
    assert.equal(newRevision, nextBuild.atlas.release.revision);
    assert.notEqual(newRevision, oldRevision);
    await context.setOffline(true); await observer.reload({ waitUntil: "load" }); await observer.locator(".intro").waitFor();
    assert.ok((await observer.locator(".intro").innerText()).includes("离线更新测试释义"));
    assert.deepEqual(pageErrors, []);
    return { failedUpdateKeptOldShell: true, oldLessonContinuedOffline: true, waitedForOldClientExit: true,
      oldRevision, newRevision, newReleaseOfflineRefresh: true, pageErrors };
  } finally { state.failures.clear(); state.mounts.set("/words/", wordsBuild); await context.close(); }
}

let temporary, server, browser;
const results = [];
try {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "word-atlas-offline-e2e-"));
  const publicDir = path.join(temporary, "public");
  await fs.mkdir(path.join(publicDir, "atlas"), { recursive: true });
  const copy = ["sw.js", "favicon.svg", "icon-512.png", "manifest.webmanifest", "brand", "atlas/index.json", "atlas/entries"];
  for (const file of copy) await fs.cp(path.join(root, "public", file), path.join(publicDir, file), { recursive: true });
  for (const [file, contents] of [["atlas/img/precontrol.webp", pixel], ["atlas/audio/uk/precontrol.mp3", wave], ["atlas/audio/uk/offline-test.mp3", wave]]) {
    await fs.mkdir(path.dirname(path.join(publicDir, file)), { recursive: true }); await fs.writeFile(path.join(publicDir, file), contents);
  }
  const sourceIndexBefore = digest(await fs.readFile(path.join(root, "public/atlas/index.json")));
  rootBuild = await buildFixture(temporary, "/", "root-release", publicDir);
  wordsBuild = await buildFixture(temporary, "/words/", "words-release", publicDir);
  const chunkNumber = Math.floor(targetIndex / index.chunk);
  const chunkFile = path.join(publicDir, "atlas/entries", `${chunkNumber}.json`);
  const entries = JSON.parse(await fs.readFile(chunkFile, "utf8"));
  entries[targetIndex % index.chunk].senses[0].zh = "离线更新测试释义";
  await fs.writeFile(chunkFile, JSON.stringify(entries));
  const nextIndex = JSON.parse(await fs.readFile(path.join(publicDir, "atlas/index.json"), "utf8"));
  nextIndex.words[targetIndex][2] = "离线更新测试释义";
  await fs.writeFile(path.join(publicDir, "atlas/index.json"), JSON.stringify(nextIndex));
  nextBuild = await buildFixture(temporary, "/words/", "next-release", publicDir);
  assert.notEqual(wordsBuild.manifest.version, nextBuild.manifest.version);
  assert.equal(digest(await fs.readFile(path.join(root, "public/atlas/index.json"))), sourceIndexBefore);
  state.mounts.set("/", rootBuild); state.mounts.set("/words/", wordsBuild);
  server = http.createServer((request, response) => void serve(request, response).catch((error) => {
    console.error(error); if (!response.headersSent) response.writeHead(500); response.end();
  }));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const name of names) {
    const started = Date.now();
    state.requests = [];
    try {
      browser = await chromium.launch({ headless: true, executablePath: process.env.ATLAS_CHROMIUM_EXECUTABLE || undefined,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", ...extraArgs] });
      const evidence = await cases[name](browser, origin);
      results.push({ case: name, status: "passed", durationMs: Date.now() - started, evidence });
    } catch (error) {
      results.push({ case: name, status: "failed", durationMs: Date.now() - started, error: error.stack ?? String(error) });
    } finally { await browser?.close().catch(() => {}); browser = undefined; }
    console.log(JSON.stringify(results.at(-1)));
  }
  if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
} catch (error) {
  results.push({ case: "setup", status: "failed", error: error.stack ?? String(error) });
  console.error(error); process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify({ browser: process.env.ATLAS_CHROMIUM_EXECUTABLE ?? "playwright-managed", cases: results }, null, 2));
  }
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
}
