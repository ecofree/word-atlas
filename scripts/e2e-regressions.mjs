#!/usr/bin/env node
/**
 * Isolated browser regressions against the real app and the checked-in atlas.
 *
 *   node scripts/e2e-regressions.mjs
 *   node scripts/e2e-regressions.mjs --case load-retry,modal-shortcuts
 *   node scripts/e2e-regressions.mjs --case modal-shortcuts --output /tmp/atlas-e2e.json
 *
 * ATLAS_CHROMIUM_EXECUTABLE may point to an existing Chromium executable.
 * ATLAS_CHROMIUM_ARGS may supply an additional JSON array of Chromium flags.
 * ATLAS_CHROMIUM_ARGS_MODULE may point to a module whose default export has args
 * (for example an already-installed @sparticuz/chromium build/index.js).
 * The script owns its Vite server, browser and fresh storage contexts, and closes
 * all of them. It never attaches to a user's browser or a deployed application.
 * Images/audio use harmless fixtures; index and entry JSON remain real.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transparentPixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=", "base64");
// Valid silent PCM WAVs exercise native decoding without downloaded media.
function silentPcm(milliseconds) {
  const size = Math.round(milliseconds * 16); // 8kHz mono, 16 bits per sample.
  const wave = Buffer.alloc(44 + size);
  wave.write("RIFF", 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24); wave.writeUInt32LE(16000, 28); wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34); wave.write("data", 36); wave.writeUInt32LE(size, 40);
  return wave;
}
const silentWave = silentPcm(50);
const loopWave = silentPcm(1000);

const cases = {
  "load-retry": testLoadRetry,
  "modal-shortcuts": testModalShortcuts,
  "writer-handoff": testWriterHandoff,
  "no-web-locks": testNoWebLocks,
  "backup-version-rejection": testBackupVersionRejection,
  "backup-recovery": testBackupRecovery,
  "today-clock": testTodayClock,
  "practice-pool": testPracticePool,
  "practice-completion": testPracticeCompletion,
  "practice-pause": testPracticePause,
  "practice-save-retry": testPracticeSaveRetry,
  "practice-variants": testPracticeVariants,
  "practice-fast-input": testPracticeFastInput,
  "spell-cheque": (browser, origin) => testSpellVariant(browser, origin, "cheque"),
  "spell-check": (browser, origin) => testSpellVariant(browser, origin, "check"),
  "picture-so": testPictureSo,
  "galaxy-selection": testGalaxySelection,
  "media-ambience-race": testMediaAmbienceRace,
  "media-cue-retry": testMediaCueRetry,
  "media-pronunciation-cancel": testMediaPronunciationCancel,
};
const selected = [];
let output;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--list") {
    console.log(Object.keys(cases).join("\n"));
    process.exit(0);
  }
  if (arg === "--case" && process.argv[i + 1]) selected.push(...process.argv[++i].split(",").filter(Boolean));
  else if (arg.startsWith("--case=")) selected.push(...arg.slice(7).split(",").filter(Boolean));
  else if (arg === "--output" && process.argv[i + 1]) output = path.resolve(process.argv[++i]);
  else if (arg === "--all") selected.push(...Object.keys(cases));
  else if (arg === "--help") {
    console.log(`Usage: node scripts/e2e-regressions.mjs [--case name[,name]] [--output file] [--list]\nDefault: ${Object.keys(cases).join(",")}`);
    process.exit(0);
  } else throw new Error(`Unknown or incomplete argument: ${arg}`);
}
const names = [...new Set(selected.length ? selected : Object.keys(cases))];
for (const name of names) if (!cases[name]) throw new Error(`Unknown case ${name}; choose ${Object.keys(cases).join(", ")}`);
let extraArgs = process.env.ATLAS_CHROMIUM_ARGS ? JSON.parse(process.env.ATLAS_CHROMIUM_ARGS) : [];
if (!Array.isArray(extraArgs) || extraArgs.some((v) => typeof v !== "string")) throw new Error("ATLAS_CHROMIUM_ARGS must be a JSON array of strings.");
if (process.env.ATLAS_CHROMIUM_ARGS_MODULE) {
  const module = await import(pathToFileURL(path.resolve(process.env.ATLAS_CHROMIUM_ARGS_MODULE)).href);
  const args = module.default?.args ?? module.args;
  if (!Array.isArray(args) || args.some((v) => typeof v !== "string")) throw new Error("ATLAS_CHROMIUM_ARGS_MODULE must export an args string array.");
  extraArgs = [...args, ...extraArgs];
}

const index = JSON.parse(await fs.readFile(path.join(root, "public/atlas/index.json"), "utf8"));
assert.ok(index.words.length >= 4, "The real atlas must contain at least four words.");
const target = index.words[0];
const searched = index.words[1];
const settings = {
  accent: "uk", autoplay: false, dailyNew: 10, retention: 0.9, theme: "light", sfx: false,
  spell: true, startLevel: 0, onboarded: true, dataset: "open", ambience: "off", ambienceVolume: 0,
  splash: false,
};

function resumedQuiz() {
  return {
    version: 2, datasetId: index.id, cards: {}, bookmarks: [], days: {}, typing: [], mistakes: [],
    session: {
      id: "browser-regression-session", started: Date.now(), index: 1, graded: {},
      // Resume immediately after the introductory card, before its first answer.
      steps: [{ id: target[0], kind: "intro" }, { id: target[0], kind: "meaning", options: index.words.slice(0, 4).map((row) => row[0]) }],
      newIds: [target[0]], reviewIds: [],
    },
  };
}

function savedProgress(word = target) {
  const now = Date.now() - 60_000;
  return {
    ...resumedQuiz(), session: null,
    cards: { [word[0]]: { due: now + 86_400_000, s: 1, d: 5, el: 0, sd: 1, ls: 0, reps: 1, lapses: 0, st: 2, last: now, seen: now } },
    bookmarks: [word[0]], days: { "2026-01-01": { n: 1, r: 1, c: 1, t: 30 } },
    typing: [{ at: now, mode: "word", items: 1, wpm: 20, accuracy: 90 }], mistakes: [word[0]],
  };
}

function practiceProgress(ids) {
  return { ...resumedQuiz(), cards: {}, days: {}, typing: [], bookmarks: ids, session: null };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function learningState(page) {
  return page.evaluate(async () => {
    const { store } = await import("/src/store/store.ts");
    const p = store.get().progress;
    return {
      sessionId: p.session?.id, index: p.session?.index,
      pending: p.session?.pending ?? null, graded: p.session?.graded ?? {}, cards: p.cards, days: p.days,
    };
  });
}

async function storedState(page) {
  return page.evaluate(async () => {
    const { store } = await import("/src/store/store.ts");
    const { progress, settings } = store.get();
    const key = `word-atlas:v2:${progress.datasetId}`;
    return {
      // JSON storage intentionally omits optional properties set to undefined.
      progress: JSON.parse(JSON.stringify(progress)), settings,
      savedProgress: localStorage.getItem(key), savedSettings: localStorage.getItem("word-atlas:settings"),
      recovery: localStorage.getItem(`${key}:before-import`),
    };
  });
}

async function waitForWriteAccess(page, access) {
  await pollPage(page, async (expected) => {
    const { store } = await import("/src/store/store.ts");
    return store.get().writeAccess === expected;
  }, access);
}

// Poll from Node so assertions still work while Playwright pauses the app clock.
async function pollPage(page, predicate, value) {
  const deadline = Date.now() + 20_000;
  while (!await page.evaluate(predicate, value)) {
    assert.ok(Date.now() < deadline, `Timed out waiting for page condition: ${predicate}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function visibility(page, value) {
  await page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
}

async function newPage(context, pageErrors) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return page;
}

async function downloadJSON(page, buttonName) {
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: buttonName, exact: true }).click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  assert.ok(stream, "Export must produce a downloadable backup.");
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function createCase(browser, origin, intercept, progress = resumedQuiz(), settingsPatch = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce", timezoneId: "UTC" });
  await context.addInitScript(({ settings, progress, origin }) => {
    if (location.origin !== origin) return;
    // A second page and a reload must observe the first page's real saved data.
    if (localStorage.getItem("word-atlas:settings") === null) localStorage.setItem("word-atlas:settings", JSON.stringify(settings));
    const key = `word-atlas:v2:${progress.datasetId}`;
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(progress));
  }, { settings: { ...settings, ...settingsPatch }, progress, origin });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (intercept && await intercept(route, url)) return;
    if (request.resourceType() === "font") return route.abort();
    if (request.resourceType() === "image" || /\.(?:png|jpe?g|webp|gif|svg)$/i.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: "image/png", body: transparentPixel });
    }
    if (/\.(?:mp3|wav|m4a|ogg)$/i.test(url.pathname)) {
      return route.fulfill({ status: 200, contentType: "audio/wav", body: silentWave });
    }
    // The optional private local catalog is intentionally absent in these tests.
    if (url.pathname === "/local/catalog.json") return route.fulfill({ status: 200, contentType: "text/plain", body: "not configured" });
    return route.continue();
  });
  const pageErrors = [];
  const page = await newPage(context, pageErrors);
  return { context, page, pageErrors };
}

async function openSavedPractice(page, origin, mode = "word") {
  await page.goto(`${origin}/#/practice`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "让手，也记住它们。", exact: true }).waitFor();
  await waitForWriteAccess(page, "writable");
  if (mode === "sentence") await page.locator(".mode-card").filter({ hasText: "例句" }).click();
  await page.getByRole("button", { name: "收藏", exact: true }).click();
  await page.getByRole("button", { name: "开始一轮", exact: true }).click();
  await page.locator(".typing-input:not([readonly])").waitFor();
}

/** Observe native Web Audio and HTMLAudioElement behavior without replacing it. */
async function observeNativeAudio(context) {
  await context.addInitScript(() => {
    window.__audioStarts = [];
    window.__audioStops = [];
    window.__gainRamps = [];
    window.__decodeFailures = 0;
    window.__decodedBuffers = [];
    window.__recordings = [];
    window.__recordingEvents = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.__audioStarts.push({ loop: this.loop, duration: this.buffer?.duration ?? 0 });
      return start.apply(this, args);
    };
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (...args) {
      window.__audioStops.push({ loop: this.loop });
      return stop.apply(this, args);
    };
    const ramp = AudioParam.prototype.linearRampToValueAtTime;
    AudioParam.prototype.linearRampToValueAtTime = function (value, at) {
      window.__gainRamps.push(value);
      return ramp.call(this, value, at);
    };
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function (...args) {
      return decode.apply(this, args).then((buffer) => {
        window.__decodedBuffers.push(buffer.duration);
        return buffer;
      }, (error) => { window.__decodeFailures++; throw error; });
    };
    const NativeAudio = window.Audio;
    function ObservedAudio(...args) {
      const audio = new NativeAudio(...args);
      const id = window.__recordings.length;
      window.__recordings.push(audio);
      for (const type of ["play", "playing", "pause", "ended", "error"]) audio.addEventListener(type, () => {
        window.__recordingEvents.push({ id, type, ended: audio.ended, paused: audio.paused });
      });
      return audio;
    }
    ObservedAudio.prototype = NativeAudio.prototype;
    Object.setPrototypeOf(ObservedAudio, NativeAudio);
    window.Audio = ObservedAudio;
  });
}

async function testLoadRetry(browser, origin) {
  let failEntries = true;
  let entryRequests = 0;
  let releaseEntry;
  const loading = new Promise((resolve) => { releaseEntry = resolve; });
  const { context, page, pageErrors } = await createCase(browser, origin, async (route, url) => {
    if (!url.pathname.startsWith("/atlas/") || !url.pathname.includes("/entries/") || !url.pathname.endsWith(".json")) return false;
    entryRequests++;
    await loading;
    if (!failEntries) return false;
    await route.fulfill({ status: 500, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: '{"error":"temporary test failure"}' });
    return true;
  });
  try {
    await page.goto(`${origin}/#/learn`, { waitUntil: "domcontentloaded" });
    await page.getByRole("status", { name: "正在加载词条", exact: true }).waitFor();
    await waitForWriteAccess(page, "writable");
    const before = await learningState(page);
    assert.equal(before.index, 1, "The saved quiz must remain the active step.");
    assert.equal(before.pending, null);
    assert.deepEqual(before.graded, {});
    await page.keyboard.press("1");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    assert.deepEqual(await learningState(page), before, "Loading shortcuts must not advance or grade.");
    releaseEntry();
    await page.getByRole("heading", { name: "这个词暂时加载不了" }).waitFor();
    await page.keyboard.press("1");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    assert.deepEqual(await learningState(page), before, "Error shortcuts must not advance or grade.");
    const failedRequests = entryRequests;
    failEntries = false;
    await page.getByRole("button", { name: "重新加载", exact: true }).click();
    await page.locator(".quiz .option").first().waitFor();
    assert.equal(await page.locator(".quiz .option").count(), 4);
    assert.deepEqual(await learningState(page), before, "Retry must preserve the same question and memory state.");
    assert.ok(entryRequests > failedRequests, "Retry must make a new entry request.");
    assert.deepEqual(pageErrors, [], "The real app must not throw an uncaught JavaScript error.");
    return { index: before.index, failedRequests, totalEntryRequests: entryRequests, preservedProgress: true, pageErrors };
  } finally {
    releaseEntry();
    await context.close();
  }
}

async function testModalShortcuts(browser, origin) {
  const { context, page, pageErrors } = await createCase(browser, origin);
  try {
    await page.goto(`${origin}/#/learn`, { waitUntil: "domcontentloaded" });
    await page.locator(".quiz .option").first().waitFor();
    await waitForWriteAccess(page, "writable");
    const before = await learningState(page);
    await page.keyboard.press("Control+k");
    const search = page.getByRole("dialog", { name: "搜索单词", exact: true });
    await search.getByRole("textbox").fill(searched[1]);
    await search.getByRole("option").first().waitFor();
    await search.getByRole("textbox").press("Enter");
    const dialog = page.getByRole("dialog", { name: `${searched[1]} 词条`, exact: true });
    await dialog.waitFor();
    await dialog.focus();
    await page.keyboard.press("1");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    assert.deepEqual(await learningState(page), before, "The modal must own input; background answers must stay unchanged.");

    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    await page.keyboard.press("1");
    await page.waitForFunction(async () => {
      const { store } = await import("/src/store/store.ts");
      return !!store.get().progress.session?.pending;
    });
    const after = await learningState(page);
    assert.equal(after.index, before.index, "Answering should reveal feedback, not skip the question.");
    assert.equal(after.pending?.value, target[0]);
    assert.ok(target[0] in after.graded, "Learning shortcuts should resume after the dialog closes.");
    assert.deepEqual(pageErrors, [], "The real app must not throw an uncaught JavaScript error.");
    return { searchedWord: searched[1], preservedBehindModal: true, shortcutResumedAfterClose: true, pageErrors };
  } finally {
    await context.close();
  }
}

async function testWriterHandoff(browser, origin) {
  const { context, page: first, pageErrors } = await createCase(browser, origin);
  try {
    await first.goto(`${origin}/#/learn`, { waitUntil: "domcontentloaded" });
    await first.locator(".quiz .option").first().waitFor();
    await waitForWriteAccess(first, "writable");
    const second = await newPage(context, pageErrors);
    await second.goto(`${origin}/#/learn`, { waitUntil: "domcontentloaded" });
    await waitForWriteAccess(second, "readonly");
    const before = await learningState(first);
    assert.deepEqual(await learningState(second), before, "The second page must start from the existing session.");

    const accepted = await second.evaluate(async (id) => {
      const { store } = await import("/src/store/store.ts");
      return store.progress((progress) => ({ ...progress, bookmarks: [id] }));
    }, searched[0]);
    assert.equal(accepted, false, "Readonly storage must reject mutations even outside the UI.");
    await second.keyboard.press("1");
    await second.keyboard.press("Enter");
    await second.keyboard.press("Space");
    assert.deepEqual(await learningState(second), before, "Readonly keyboard input must not change the session.");
    assert.deepEqual(await learningState(first), before, "Readonly input must not overwrite the writer's session.");

    await first.keyboard.press("1");
    await first.waitForFunction(async () => {
      const { store } = await import("/src/store/store.ts");
      return !!store.get().progress.session?.pending;
    });
    const answered = await learningState(first);
    await second.waitForFunction(async (id) => {
      const { store } = await import("/src/store/store.ts");
      return store.get().progress.session?.pending?.value === id;
    }, target[0]);
    assert.deepEqual(await learningState(second), answered, "The reader must receive the first page's saved answer.");
    await first.close();
    await waitForWriteAccess(second, "writable");
    assert.deepEqual(await learningState(second), answered, "Lock handoff must preserve the latest saved answer.");
    await second.keyboard.press("Enter");
    await second.waitForFunction(async () => {
      const { store } = await import("/src/store/store.ts");
      return store.get().progress.session?.index === 2;
    });
    const after = await storedState(second);
    assert.deepEqual(after.progress.cards, answered.cards, "Advancing after handoff must not grade the word twice.");
    assert.deepEqual(after.progress.session?.graded, answered.graded);
    assert.deepEqual(after.progress.bookmarks, [], "The rejected readonly write must never reach saved progress.");
    await second.reload({ waitUntil: "domcontentloaded" });
    await waitForWriteAccess(second, "writable");
    assert.deepEqual(await storedState(second), after, "Reload must retain the transferred session without stale overwrites.");
    assert.deepEqual(pageErrors, []);
    return { writerTransitions: ["first:writable", "second:readonly", "second:writable"], finalIndex: 2, preservedCards: Object.keys(answered.cards).length, rejectedReadonlyWrite: true, pageErrors };
  } finally {
    await context.close();
  }
}

async function testBackupVersionRejection(browser, origin) {
  const { context, page, pageErrors } = await createCase(browser, origin, undefined, savedProgress());
  try {
    await page.goto(`${origin}/#/me`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "你的星空", exact: true }).waitFor();
    await waitForWriteAccess(page, "writable");
    const before = await storedState(page);
    const backup = await page.evaluate(async () => JSON.parse((await import("/src/store/store.ts")).exportBackup()));
    for (const nested of [true, false]) {
      const malformed = structuredClone(backup);
      if (nested) malformed.progress.version = 1;
      else malformed.version = 1;
      await page.locator('input[type="file"]').setInputFiles({ name: nested ? "unsupported-progress.json" : "unsupported-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(malformed)) });
      await page.locator(".toast-warn").filter({ hasText: nested ? "备份格式不完整或版本不受支持" : "这不是词光的学习备份" }).waitFor();
      assert.deepEqual(await storedState(page), before, "Rejecting an unsupported backup must preserve memory and all saved data.");
    }
    assert.deepEqual(pageErrors, []);
    return { rejectedVersions: ["progress.version", "backup.version"], preservedCards: Object.keys(before.progress.cards).length, unchangedRecovery: true, pageErrors };
  } finally {
    await context.close();
  }
}

async function testNoWebLocks(browser, origin) {
  const { context, page, pageErrors } = await createCase(browser, origin, undefined, savedProgress());
  await context.addInitScript(() => Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }));
  try {
    await page.goto(`${origin}/#/me`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "你的星空", exact: true }).waitFor();
    await waitForWriteAccess(page, "unavailable");
    await page.locator(".write-notice").filter({ hasText: "Web Locks" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "导入备份", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "清空记录", exact: true }).isDisabled(), true);
    const before = await storedState(page);
    const accepted = await page.evaluate(async () => {
      const { store } = await import("/src/store/store.ts");
      return store.progress((progress) => ({ ...progress, cards: {} }));
    });
    assert.equal(accepted, false, "Missing Web Locks must never allow an uncoordinated write.");
    const exported = await downloadJSON(page, "导出备份");
    assert.deepEqual(exported.progress, before.progress, "Saved progress must remain exportable without Web Locks.");
    assert.deepEqual(exported.settings, before.settings);
    await page.evaluate(() => { location.hash = "#/learn"; });
    await page.locator(".learning-surface[inert]").waitFor();
    await page.keyboard.press("1");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await page.locator(".write-notice").getByRole("button", { name: "重试", exact: true }).click();
    await waitForWriteAccess(page, "unavailable");
    assert.deepEqual(await storedState(page), before, "Readonly navigation and retry must not create or alter a session.");
    assert.deepEqual(pageErrors, []);
    return { writeAccess: "unavailable", importAndResetDisabled: true, exportVerified: true, progressPreserved: true, pageErrors };
  } finally {
    await context.close();
  }
}

async function testBackupRecovery(browser, origin) {
  const { context, page, pageErrors } = await createCase(browser, origin, undefined, savedProgress());
  try {
    await page.goto(`${origin}/#/me`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "你的星空", exact: true }).waitFor();
    await waitForWriteAccess(page, "writable");
    const before = await storedState(page);
    const incoming = {
      app: "word-atlas", version: 2, exported: new Date().toISOString(), progress: savedProgress(searched),
      settings: { ...settings, accent: "us", theme: "dark", dailyNew: 15 },
    };
    await page.evaluate((datasetId) => {
      const progressKey = `word-atlas:v2:${datasetId}`;
      const keys = [progressKey, `${progressKey}:before-import`, "word-atlas:settings"];
      const setItem = Storage.prototype.setItem;
      window.__atlasWrites = [];
      Storage.prototype.setItem = function (key, value) {
        const result = setItem.call(this, key, value);
        if (this === localStorage && keys.includes(key)) window.__atlasWrites.push({ key, value });
        return result;
      };
    }, index.id);
    await page.locator('input[type="file"]').setInputFiles({ name: "valid-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(incoming)) });
    await page.locator(".toast-ok").filter({ hasText: "已恢复 1 个词的记忆" }).waitFor();
    const after = await storedState(page);
    assert.deepEqual(after.progress, incoming.progress, "A valid import must restore the supplied progress.");
    assert.deepEqual(after.settings, incoming.settings, "A valid import must restore its settings.");
    assert.deepEqual(JSON.parse(after.savedProgress), incoming.progress);
    assert.deepEqual(JSON.parse(after.savedSettings), incoming.settings);
    const recovery = JSON.parse(after.recovery);
    assert.deepEqual(recovery.progress, { ...before.progress, session: null }, "Recovery must contain the previous progress.");
    assert.deepEqual(recovery.settings, before.settings, "Recovery must contain the previous settings.");
    const writes = await page.evaluate(() => window.__atlasWrites);
    const progressKey = `word-atlas:v2:${index.id}`;
    const recoveryWrite = writes.findIndex((write) => write.key === `${progressKey}:before-import`);
    const progressWrite = writes.findIndex((write) => write.key === progressKey);
    const settingsWrite = writes.findIndex((write) => write.key === "word-atlas:settings");
    assert.ok(recoveryWrite >= 0 && recoveryWrite < progressWrite && recoveryWrite < settingsWrite, "Recovery must be saved before progress or settings are replaced.");

    assert.deepEqual(await downloadJSON(page, "导出上次导入前的备份"), recovery, "The recovery download must contain the original data.");
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForWriteAccess(page, "writable");
    assert.deepEqual(await storedState(page), after, "Imported data and its recovery copy must survive reload.");
    assert.deepEqual(pageErrors, []);
    return { recoverySavedBeforeReplacement: true, writeOrder: writes.map((write) => write.key), recoveryDownloadVerified: true, importedCards: Object.keys(after.progress.cards).length, pageErrors };
  } finally {
    await context.close();
  }
}

async function testTodayClock(browser, origin) {
  const start = Date.parse("2026-10-26T23:59:57Z");
  const progress = savedProgress();
  progress.cards[target[0]].due = start + 2000;
  progress.days = { "2026-10-26": { n: 2, r: 2, c: 2, t: 30 } };
  const { context, page, pageErrors } = await createCase(browser, origin, undefined, progress, { dailyNew: 2 });
  try {
    await page.clock.install({ time: start - 60_000 });
    await page.goto(`${origin}/#/`, { waitUntil: "domcontentloaded" });
    await page.locator(".journey h2").waitFor();
    await waitForWriteAccess(page, "writable");
    await page.clock.pauseAt(start);
    assert.match(await page.locator(".journey h2").textContent(), /今天的星，都亮了/);
    const firstWord = await page.locator(".wotd-word").textContent();
    await page.clock.runFor(2000);
    await pollPage(page, () => /复习\s*1/.test(document.querySelector(".journey h2")?.textContent ?? ""));
    assert.doesNotMatch(await page.locator(".journey h2").textContent(), /新词/);
    await page.clock.runFor(1000);
    await pollPage(page, () => /10月27日/.test(document.querySelector(".greet .eyebrow")?.textContent ?? ""));
    assert.match(await page.locator(".journey h2").textContent(), /新词\s*2/);
    assert.match(await page.locator(".week .is-today").getAttribute("title"), /^2026-10-27/);
    assert.equal(await page.locator(".streak-body .ring b").textContent(), "0");
    const secondWord = await page.locator(".wotd-word").textContent();
    assert.notEqual(secondWord, firstWord, "The daily word must update with the calendar day.");

    await visibility(page, "hidden");
    await page.clock.setSystemTime("2026-10-28T12:00:00Z");
    await visibility(page, "visible");
    await waitForWriteAccess(page, "writable");
    await pollPage(page, () => /10月28日/.test(document.querySelector(".greet .eyebrow")?.textContent ?? ""));
    assert.match(await page.locator(".greet h1").textContent(), /中午好/);
    await page.getByRole("button", { name: "开始今天的旅程", exact: false }).click();
    const session = (await storedState(page)).progress.session;
    assert.deepEqual(session.reviewIds, [target[0]]);
    assert.equal(session.newIds.length, 2, "Starting a session must use the same day's allowance as the refreshed plan.");
    assert.equal(session.started, Date.parse("2026-10-28T12:00:00Z"));
    assert.deepEqual(pageErrors, []);
    return { dueRefreshedWithoutInput: true, midnightRefreshed: true, visibleResumeRefreshed: true, planAndSessionAgree: true, firstWord, secondWord, pageErrors };
  } finally {
    await context.close();
  }
}

async function testPracticePool(browser, origin) {
  let hold = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { context, page, pageErrors } = await createCase(browser, origin, async (route, url) => {
    if (!hold || !url.pathname.includes("/entries/") || !url.pathname.endsWith(".json")) return false;
    await gate;
    await route.continue();
    return true;
  }, practiceProgress(index.words.map((row) => row[0])));
  try {
    await page.clock.setFixedTime("2026-10-26T10:00:00Z");
    await openSavedPractice(page, origin);
    const selected = [];
    for (let i = 0; i < 10; i++) {
      await page.locator(".typing-input:not([readonly])").waitFor();
      const word = await page.locator(".typing-text").textContent();
      const position = index.words.findIndex((row) => row[1] === word || row[1].split("/")[0] === word);
      assert.ok(position >= 0, `Practice must use a real indexed word: ${word}`);
      selected.push(position);
      await page.locator(".typing-input").fill(word);
      if (i < 9) await pollPage(page, (step) => document.querySelector(".typing-help")?.textContent?.includes(`第 ${step}/10 项`), i + 2);
    }
    await page.locator(".typing-done").getByText("本轮完成", { exact: true }).waitFor();
    assert.equal(new Set(selected).size, 10);
    assert.ok(selected.some((position) => position >= 60), "Sampling must reach beyond the old first-sixty limit.");
    assert.equal((await storedState(page)).progress.typing.length, 1);

    // A later seed chooses uncached real chunks. Returning while they load must
    // cancel the pending round even though the parent Practice remains mounted.
    await page.clock.setFixedTime("2026-10-27T10:00:00Z");
    hold = true;
    const waiting = page.waitForRequest((request) => new URL(request.url()).pathname.includes("/entries/"));
    await page.getByRole("button", { name: "再来一轮", exact: false }).click();
    await waiting;
    await page.locator(".typing-done").getByRole("button", { name: "返回", exact: true }).click();
    release();
    await page.waitForLoadState("networkidle");
    await page.getByRole("heading", { name: "让手，也记住它们。", exact: true }).waitFor();
    assert.equal(await page.locator(".typing-input").count(), 0);
    assert.equal(await page.getByRole("button", { name: "开始一轮", exact: true }).isEnabled(), true);
    assert.equal((await storedState(page)).progress.typing.length, 1);
    assert.deepEqual(pageErrors, []);
    return { selectedPositions: selected, wholeSourceEligible: true, cancelledRestartStayedClosed: true, pageErrors };
  } finally {
    release();
    await context.close();
  }
}

async function testPracticeCompletion(browser, origin) {
  const { context, page, pageErrors } = await createCase(browser, origin, undefined, practiceProgress([target[0], searched[0]]));
  try {
    const start = Date.parse("2026-10-26T10:00:00Z");
    await page.clock.install({ time: start - 60_000 });
    await openSavedPractice(page, origin);
    await page.clock.pauseAt(start);
    let characters = 0;
    for (let i = 0; i < 2; i++) {
      const input = page.locator(".typing-input");
      const word = await page.locator(".typing-text").textContent();
      characters += Array.from(word).length;
      await input.fill(word.slice(0, 1));
      await page.clock.runFor(1000);
      await input.fill(word);
      if (i === 0) {
        assert.equal(await input.evaluate((element) => element.readOnly), true, "Completion must synchronously lock the current item.");
        await page.keyboard.press("Space");
        await page.keyboard.press("Space");
        assert.equal(await input.inputValue(), word, "Extra input during the 260ms transition must be ignored.");
        await page.clock.runFor(300);
        await page.locator(".typing-input:not([readonly])").waitFor();
        assert.equal(await page.locator(".typing-input").inputValue(), "");
      }
    }
    await page.locator(".typing-done").getByText("本轮完成", { exact: true }).waitFor();
    const rounds = (await storedState(page)).progress.typing;
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].items, 2);
    assert.equal(rounds[0].accuracy, 100);
    assert.equal(rounds[0].wpm, Math.round(characters / 5 / (2 / 60)));
    await page.getByRole("button", { name: "再来一轮", exact: false }).click();
    await page.locator(".typing-input:not([readonly])").waitFor();
    assert.equal(await page.locator(".typing-input").inputValue(), "");
    assert.equal((await storedState(page)).progress.typing.length, 1);
    assert.deepEqual(pageErrors, []);
    return { transitionLocked: true, exactlyOneSavedRound: true, accuracy: rounds[0].accuracy, wpm: rounds[0].wpm, pageErrors };
  } finally {
    await context.close();
  }
}

async function testPracticePause(browser, origin) {
  const { context, page, pageErrors } = await createCase(browser, origin, undefined, practiceProgress([target[0]]));
  try {
    const start = Date.parse("2026-10-26T10:00:00Z");
    await page.clock.install({ time: start - 60_000 });
    await openSavedPractice(page, origin);
    await page.clock.pauseAt(start);
    const word = await page.locator(".typing-text").textContent();
    await page.locator(".typing-input").fill(word.slice(0, 2));
    await page.clock.runFor(500);
    await visibility(page, "hidden");
    await waitForWriteAccess(page, "readonly");
    await page.clock.fastForward(30_000);
    assert.equal(await page.locator(".typing-input").inputValue(), word.slice(0, 2));
    await visibility(page, "visible");
    await waitForWriteAccess(page, "writable");
    await page.locator(".typing-input:not([readonly])").waitFor();
    assert.equal(await page.locator(".typing-input").inputValue(), word.slice(0, 2), "Visibility changes must preserve the mounted round's input.");
    await page.clock.runFor(500);
    await page.locator(".typing-input").fill(word);
    await page.locator(".typing-done").getByText("本轮完成", { exact: true }).waitFor();
    const round = (await storedState(page)).progress.typing[0];
    assert.equal(round.wpm, Array.from(word).length * 12, "Thirty seconds in the background must not count as typing time.");
    assert.equal(round.accuracy, 100);
    assert.deepEqual(pageErrors, []);
    return { inputPreserved: true, hiddenMsExcluded: 30_000, activeMs: 1000, wpm: round.wpm, pageErrors };
  } finally {
    await context.close();
  }
}

async function testPracticeSaveRetry(browser, origin) {
  const { context, page, pageErrors } = await createCase(browser, origin, undefined, practiceProgress([target[0]]));
  try {
    await openSavedPractice(page, origin);
    await page.evaluate((datasetId) => {
      const original = Storage.prototype.setItem;
      window.__rejectProgress = true;
      Storage.prototype.setItem = function (key, value) {
        if (window.__rejectProgress && this === localStorage && key === `word-atlas:v2:${datasetId}`) throw new DOMException("Test storage full", "QuotaExceededError");
        return original.call(this, key, value);
      };
    }, index.id);
    await page.locator(".typing-input").fill(await page.locator(".typing-text").textContent());
    await page.locator(".typing-done").getByText("本轮记录尚未保存", { exact: true }).waitFor();
    await page.locator(".typing-done [role=alert]").waitFor();
    const failed = await storedState(page);
    assert.equal(failed.progress.typing.length, 1, "The unsaved round must remain available for recovery.");
    assert.equal(JSON.parse(failed.savedProgress).typing.length, 0);
    assert.equal(await page.locator(".typing-done").getByText("本轮完成", { exact: true }).count(), 0);
    await page.evaluate(() => { window.__rejectProgress = false; });
    await page.locator(".typing-done").getByRole("button", { name: "重试保存", exact: true }).click();
    await page.locator(".typing-done").getByText("本轮完成", { exact: true }).waitFor();
    const saved = await storedState(page);
    assert.equal(saved.progress.typing.length, 1, "Retry must flush the existing round, not append another one.");
    assert.deepEqual(JSON.parse(saved.savedProgress).typing, saved.progress.typing);
    assert.deepEqual(pageErrors, []);
    return { failedSaveDidNotComplete: true, retrySavedExactlyOnce: true, pageErrors };
  } finally {
    await context.close();
  }
}

async function testPracticeVariants(browser, origin) {
  const cheque = index.words.find((row) => row[1] === "cheque/check");
  assert.ok(cheque, "The real variant entry must exist.");
  const { context, page, pageErrors } = await createCase(browser, origin, undefined, practiceProgress([cheque[0]]));
  try {
    await openSavedPractice(page, origin);
    assert.equal(await page.locator(".typing-text").textContent(), "cheque");
    await page.locator(".typing-input").fill("check");
    await page.locator(".typing-done").getByText("本轮完成", { exact: true }).waitFor();
    const rounds = (await storedState(page)).progress.typing;
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].accuracy, 100);
    assert.deepEqual(pageErrors, []);
    return { initialTarget: "cheque", accepted: "check", accuracy: 100, pageErrors };
  } finally {
    await context.close();
  }
}

async function testPracticeFastInput(browser, origin) {
  const { context, page, pageErrors } = await createCase(browser, origin, undefined, practiceProgress([target[0]]));
  try {
    const start = Date.parse("2026-10-26T10:00:00Z");
    await page.clock.install({ time: start - 60_000 });
    await openSavedPractice(page, origin, "sentence");
    await page.clock.pauseAt(start);
    const text = await page.locator(".typing-text").textContent();
    assert.ok(text.length > 34, "The real example must be long enough to exercise the stored speed limit.");
    await page.locator(".typing-input").fill(text.slice(0, 1));
    await page.clock.runFor(1000);
    await page.locator(".typing-input").fill(text);
    await page.locator(".typing-done").getByText("本轮完成", { exact: true }).waitFor();
    const result = await page.evaluate(async () => {
      const { store, exportBackup, validateBackup, sanitizeProgress } = await import("/src/store/store.ts");
      const progress = store.get().progress;
      const exported = JSON.parse(exportBackup());
      return { round: progress.typing[0], sanitized: sanitizeProgress(exported.progress, progress.datasetId).typing, backup: validateBackup(exported, progress.datasetId).ok };
    });
    assert.equal(result.round.wpm, 400);
    assert.deepEqual(result.sanitized, [result.round]);
    assert.equal(result.backup, true);
    assert.deepEqual(pageErrors, []);
    return { cappedWpm: 400, persistedRoundAccepted: true, backupRoundTripValid: true, pageErrors };
  } finally {
    await context.close();
  }
}

async function testSpellVariant(browser, origin, spelling) {
  const cheque = index.words.find((row) => row[1] === "cheque/check");
  assert.ok(cheque);
  const progress = resumedQuiz();
  progress.session.steps = [{ id: cheque[0], kind: "intro" }, { id: cheque[0], kind: "spell" }];
  progress.session.newIds = [cheque[0]];
  const { context, page, pageErrors } = await createCase(browser, origin, undefined, progress);
  try {
    await page.goto(`${origin}/#/learn`, { waitUntil: "domcontentloaded" });
    await page.locator(".spell-input").waitFor();
    await waitForWriteAccess(page, "writable");
    assert.equal(await page.locator(".slots .slot").count(), 6);
    assert.match(await page.locator(".spell-input").getAttribute("aria-label"), /提示词形 6 个字符/);
    const hintPrefixes = [];
    if (spelling === "cheque") {
      const hint = page.getByRole("button", { name: "提示字母", exact: true });
      for (let i = 0; i < 5; i++) {
        await hint.click();
        const prefix = spelling.slice(0, i + 1);
        // A click finishing does not guarantee that React has committed its
        // resulting input/focus state. Assert the outcome, not a fixed delay.
        await pollPage(page, (expected) => {
          const input = document.querySelector(".spell-input");
          return input?.value === expected && document.activeElement === input;
        }, prefix);
        hintPrefixes.push(await page.locator(".spell-input").inputValue());
      }
      assert.equal(await hint.isDisabled(), true);
      assert.equal(await page.locator(".spell-input").inputValue(), "chequ");
      await page.locator(".spell-input").fill("");
      assert.equal(await page.locator(".spell-input").inputValue(), "", "Hints must not force a prefix back after the learner clears the input.");
      await page.locator(".spell-input").fill("edited");
      assert.equal(await page.locator(".spell-input").inputValue(), "edited", "The learner can still edit hinted input.");
    }
    await page.locator(".spell-input").fill(spelling);
    await page.locator(".spell-input").press("Enter");
    await pollPage(page, async () => !!(await import("/src/store/store.ts")).store.get().progress.session?.pending);
    const state = await learningState(page);
    assert.equal(state.pending.correct, true);
    assert.equal(state.pending.value, spelling);
    await pollPage(page, (length) => document.querySelectorAll(".slots .slot").length === length &&
      document.querySelectorAll(".slots .slot.is-bad").length === 0 && document.querySelector(".spell-input")?.readOnly, spelling.length);
    assert.equal(await page.locator(".slots .slot").count(), spelling.length);
    assert.equal(await page.locator(".slots .slot.is-bad").count(), 0);
    assert.equal(await page.locator(".spell-input").inputValue(), spelling);
    let immediateHintGrade;
    let immediateHintValue;
    if (spelling === "cheque") {
      assert.equal(state.graded[cheque[0]], 2, "A correct answer after hints must use the hinted grade.");
      // Reset only this isolated fixture, then dispatch hint and submit in one
      // browser task to detect a stale value or hint count in the submit handler.
      const fresh = { ...progress, session: { ...progress.session, id: "same-task-hint-submit" } };
      await page.evaluate(async (fixture) => {
        const { store } = await import("/src/store/store.ts");
        if (!store.progress(() => fixture)) throw new Error("Could not reset the isolated spelling fixture.");
      }, fresh);
      await page.locator(".spell-input:not([readonly])").waitFor();
      await page.locator(".spell-input").fill("cheque");
      await page.evaluate(() => {
        document.querySelector(".spell-actions button[type=button]").click();
        document.querySelector("form.spell").requestSubmit();
      });
      await pollPage(page, async () => !!(await import("/src/store/store.ts")).store.get().progress.session?.pending);
      const immediate = await learningState(page);
      assert.equal(immediate.pending.value, "cheque");
      assert.equal(immediate.pending.correct, true);
      immediateHintGrade = immediate.graded[cheque[0]];
      assert.equal(immediateHintGrade, 2, "A same-task hint then submit must not use the unhinted grade.");

      await page.evaluate(async (fixture) => {
        const { store } = await import("/src/store/store.ts");
        if (!store.progress(() => fixture)) throw new Error("Could not reset the isolated spelling fixture.");
      }, { ...progress, session: { ...progress.session, id: "same-task-hint-value" } });
      await page.locator(".spell-input:not([readonly])").waitFor();
      await page.locator(".spell-input").fill("edited");
      await page.evaluate(() => {
        document.querySelector(".spell-actions button[type=button]").click();
        document.querySelector("form.spell").requestSubmit();
      });
      await pollPage(page, async () => !!(await import("/src/store/store.ts")).store.get().progress.session?.pending);
      const replaced = await learningState(page);
      immediateHintValue = replaced.pending.value;
      assert.equal(immediateHintValue, "c", "A same-task submit must use the hint's replacement value.");
      assert.equal(replaced.pending.correct, false);
      assert.equal(replaced.graded[cheque[0]], 1);
    }
    assert.deepEqual(pageErrors, []);
    return { spelling, initialSlots: 6, correctSlots: spelling.length, accepted: true, hintsLimitedToPreferredForm: spelling === "cheque", hintPrefixes, immediateHintGrade, immediateHintValue, pageErrors };
  } finally {
    await context.close();
  }
}

async function testPictureSo(browser, origin) {
  const so = index.words.find((row) => row[1] === "so");
  assert.ok(so);
  const progress = resumedQuiz();
  progress.session.steps = [{ id: so[0], kind: "intro" }, { id: so[0], kind: "picture", options: [so[0], ...index.words.slice(0, 3).map((row) => row[0])] }];
  progress.session.newIds = [so[0]];
  const { context, page, pageErrors } = await createCase(browser, origin, undefined, progress);
  try {
    await page.goto(`${origin}/#/learn`, { waitUntil: "domcontentloaded" });
    await page.locator(".quiz-picture .cloze .blank").waitFor();
    const cloze = await page.locator(".quiz-picture .cloze").textContent();
    assert.match(cloze, /^The soup was\s+hot that I had to wait\.$/);
    assert.deepEqual(pageErrors, []);
    return { headword: "so", unrelatedSoupPreserved: true, cloze, pageErrors };
  } finally {
    await context.close();
  }
}

async function testGalaxySelection(browser, origin) {
  const { context, page, pageErrors } = await createCase(browser, origin);
  try {
    const start = Date.parse("2026-10-26T10:00:00Z");
    await page.clock.install({ time: start - 60_000 });
    await page.goto(`${origin}/#/atlas?view=galaxy`, { waitUntil: "domcontentloaded" });
    await page.locator(".galaxy-full canvas").waitFor();
    await page.clock.pauseAt(start);
    // Hit-testing is deterministic; all pointer events, flyTo, routing and React
    // lifecycle remain the real application code and real canvas element.
    await page.evaluate(async () => {
      const { GalaxyEngine } = await import("/src/galaxy/engine.ts");
      window.__galaxyHit = 0;
      GalaxyEngine.prototype.pick = function () { return window.__galaxyHit; };
    });
    const clickStar = async (hit) => {
      await page.evaluate((value) => { window.__galaxyHit = value; }, hit);
      const box = await page.locator(".galaxy-full canvas").boundingBox();
      assert.ok(box);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };
    await clickStar(0);
    await page.locator('.topnav a[href="#/me"]').click();
    await page.getByRole("heading", { name: "你的星空", exact: true }).waitFor();
    await page.clock.runFor(1000);
    assert.equal(await page.getByRole("dialog").count(), 0, "An unmounted galaxy must not open its delayed word card.");
    assert.equal(new URL(page.url()).hash, "#/me");

    await page.locator('.topnav a[href="#/atlas"]').click();
    await page.locator(".galaxy-full canvas").waitFor();
    await clickStar(0);
    await page.clock.runFor(100);
    await clickStar(1);
    await page.clock.runFor(250);
    assert.equal(await page.getByRole("dialog").count(), 0, "A superseded selection must not open at its old deadline.");
    await page.clock.runFor(100);
    await page.getByRole("dialog", { name: `${searched[1]} 词条`, exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: `${target[1]} 词条`, exact: true }).count(), 0);
    assert.deepEqual(pageErrors, []);
    return { navigationCancelledDelayedOpen: true, latestSelectionOnly: true, pointerPath: "native canvas mouse events with deterministic pick", pageErrors };
  } finally {
    await context.close();
  }
}

async function testMediaAmbienceRace(browser, origin) {
  const gates = { stars: deferred(), rain: deferred(), sea: deferred() };
  const { context, page, pageErrors } = await createCase(browser, origin, async (route, url) => {
    const match = /\/sfx\/amb-(stars|rain|sea)\.mp3$/.exec(url.pathname);
    if (!match) return false;
    await gates[match[1]].promise;
    await route.fulfill({ status: 200, contentType: "audio/wav", body: loopWave }).catch(() => {});
    return true;
  }, undefined, { ambienceVolume: 0.8 });
  await observeNativeAudio(context);
  try {
    await page.goto(`${origin}/#/me`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "你的星空", exact: true }).waitFor();
    await page.getByRole("button", { name: "环境声", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "环境声", exact: true });
    const starsRequested = page.waitForRequest((request) => request.url().endsWith("/sfx/amb-stars.mp3"));
    await picker.getByRole("button", { name: "星空音乐", exact: true }).click();
    await starsRequested;
    const rainRequested = page.waitForRequest((request) => request.url().endsWith("/sfx/amb-rain.mp3"));
    await picker.getByRole("button", { name: "雨天图书馆", exact: true }).click();
    await rainRequested;
    gates.stars.resolve();
    await pollPage(page, () => window.__decodedBuffers.some((duration) => duration > 0.9));
    assert.equal(await page.evaluate(async () => (await import("/src/lib/sound.ts")).ambienceId()), null, "An older decoded request must not win while the latest choice is still loading.");
    assert.equal(await page.evaluate(() => window.__audioStarts.filter((source) => source.loop).length), 0);
    gates.rain.resolve();
    await pollPage(page, async () => (await import("/src/lib/sound.ts")).ambienceId() === "rain");
    const seaRequested = page.waitForRequest((request) => request.url().endsWith("/sfx/amb-sea.mp3"));
    await picker.getByRole("button", { name: "清晨海岸", exact: true }).click();
    await seaRequested;
    await picker.getByRole("button", { name: "安静", exact: true }).click();
    gates.sea.resolve();
    await pollPage(page, () => window.__decodedBuffers.filter((duration) => duration > 0.9).length === 3);
    assert.equal(await page.evaluate(async () => (await import("/src/lib/sound.ts")).ambienceId()), null, "Turning ambience off must also cancel a pending selection.");
    const evidence = await page.evaluate(() => ({ nativeLoopsStarted: window.__audioStarts.filter((source) => source.loop).length, nativeLoopsStopped: window.__audioStops.filter((source) => source.loop).length }));
    assert.deepEqual(evidence, { nativeLoopsStarted: 1, nativeLoopsStopped: 1 });
    assert.deepEqual(pageErrors, []);
    return { ...evidence, latestRequestWins: true, pendingOffStayedOff: true, nativeWebAudio: true, pageErrors };
  } finally {
    Object.values(gates).forEach((gate) => gate.resolve());
    await context.close();
  }
}

async function testMediaCueRetry(browser, origin) {
  const requests = { correct: 0, wrong: 0 };
  const { context, page, pageErrors } = await createCase(browser, origin, async (route, url) => {
    const match = /\/sfx\/(correct|wrong)\.mp3$/.exec(url.pathname);
    if (!match) return false;
    const name = match[1];
    requests[name]++;
    if (requests[name] === 1) {
      await route.fulfill({ status: name === "correct" ? 500 : 200, contentType: "audio/mpeg", body: "temporary invalid audio" });
    } else await route.fulfill({ status: 200, contentType: "audio/wav", body: silentWave });
    return true;
  });
  await observeNativeAudio(context);
  try {
    await page.goto(`${origin}/#/me`, { waitUntil: "domcontentloaded" });
    // A real gesture primes the application's actual shared cue cache.
    await page.getByRole("heading", { name: "你的星空", exact: true }).click();
    await pollPage(page, () => window.__decodeFailures === 1);
    assert.deepEqual(requests, { correct: 1, wrong: 1 });
    await page.evaluate(async () => {
      const { cue } = await import("/src/lib/sound.ts");
      await cue("correct");
      await cue("wrong");
    });
    assert.deepEqual(requests, { correct: 2, wrong: 2 }, "Both HTTP and native decode failures must be retried.");
    const starts = await page.evaluate(() => window.__audioStarts.filter((source) => !source.loop));
    assert.equal(starts.length, 2);
    assert.ok(starts.every((source) => source.duration > 0));
    assert.deepEqual(pageErrors, []);
    return { requests, nativeCueStarts: starts.length, httpFailureRetried: true, decodeFailureRetried: true, pageErrors };
  } finally {
    await context.close();
  }
}

async function testMediaPronunciationCancel(browser, origin) {
  const recordings = deferred();
  const pending = deferred();
  const { context, page, pageErrors } = await createCase(browser, origin, async (route, url) => {
    if (url.pathname === "/sfx/amb-rain.mp3") {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: loopWave });
      return true;
    }
    if (url.pathname.includes("/atlas/audio/")) {
      await recordings.promise;
      await route.fulfill({ status: 200, contentType: "audio/wav", body: silentPcm(300) }).catch(() => {});
      return true;
    }
    if (url.pathname === "/__media/pending.wav") {
      await pending.promise;
      await route.fulfill({ status: 200, contentType: "audio/wav", body: silentWave }).catch(() => {});
      return true;
    }
    if (url.pathname === "/__media/brief.wav") {
      await route.fulfill({ status: 200, contentType: "audio/wav", body: silentPcm(300) });
      return true;
    }
    return false;
  }, undefined, { ambienceVolume: 0.8 });
  await observeNativeAudio(context);
  try {
    await page.goto(`${origin}/#/learn`, { waitUntil: "domcontentloaded" });
    await page.locator(".prompt-word .speak").waitFor();
    await waitForWriteAccess(page, "writable");
    await page.getByRole("button", { name: "环境声", exact: true }).click();
    await page.getByRole("dialog", { name: "环境声", exact: true }).getByRole("button", { name: "雨天图书馆", exact: true }).click();
    await pollPage(page, async () => (await import("/src/lib/sound.ts")).ambienceId() === "rain");
    await page.keyboard.press("Escape");
    const speak = page.locator(".prompt-word .speak");
    await speak.click();
    await pollPage(page, () => window.__recordings.length === 1);
    await speak.click();
    await pollPage(page, () => window.__recordings.length === 2);
    // Let the cancelled request's finally blocks run while the replacement is
    // still waiting on its real HTMLAudioElement network response.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(await speak.evaluate((element) => element.classList.contains("is-on")), true, "Cancelling A must not clear the same button's active B state.");
    const active = await page.evaluate(() => ({ paused: window.__recordings.map((audio) => audio.paused), ramp: window.__gainRamps.at(-1) }));
    assert.deepEqual(active.paused, [true, false]);
    assert.ok(Math.abs(active.ramp - 0.8 * 0.35 * 0.9) < 1e-8, "An old completion must not remove ducking under the replacement pronunciation.");
    await page.evaluate(async () => (await import("/src/lib/audio.ts")).stopAudio());
    await pollPage(page, () => !document.querySelector(".prompt-word .speak.is-on"));
    const stopped = await page.evaluate(() => ({ paused: window.__recordings.map((audio) => audio.paused), ramp: window.__gainRamps.at(-1) }));
    assert.deepEqual(stopped.paused, [true, true]);
    assert.ok(Math.abs(stopped.ramp - 0.8 * 0.9) < 1e-8);
    recordings.resolve();

    const ended = await page.evaluate(async () => (await import("/src/lib/audio.ts")).play("/__media/brief.wav", "native recording"));
    const nativeEvents = await page.evaluate(() => window.__recordingEvents);
    assert.equal(ended, "recorded", `A real recording must still finish normally after rapid cancellation: ${JSON.stringify(nativeEvents)}`);
    await page.evaluate(async () => {
      const { play } = await import("/src/lib/audio.ts");
      window.__pendingPlayback = "waiting";
      void play("/__media/pending.wav", "pending recording").then((result) => { window.__pendingPlayback = result; });
    });
    await page.evaluate(async () => (await import("/src/lib/audio.ts")).stopAudio());
    await pollPage(page, () => window.__pendingPlayback === "stopped");
    pending.resolve();
    assert.deepEqual(pageErrors, []);
    return { sameButtonReplacementStayedActive: true, oldRequestKeptNewDucking: true, stopRestoredVolume: true, nativeRecordingResult: ended, nativeEvents, pendingPlaySettledImmediately: true, pageErrors };
  } finally {
    recordings.resolve();
    pending.resolve();
    await context.close();
  }
}

let server;
let browser;
const results = [];
try {
  server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), base: "/", logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null } });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object", "Vite did not open a local HTTP socket.");
  const origin = `http://127.0.0.1:${address.port}`;
  const launchOptions = {
    headless: true,
    executablePath: process.env.ATLAS_CHROMIUM_EXECUTABLE || undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage", ...extraArgs],
  };
  for (const name of names) {
    const started = Date.now();
    try {
      // Some serverless Chromium builds exit when their only context is closed.
      // A fresh owned browser per case keeps those failures from contaminating
      // other cases while Vite remains in this same Node process.
      browser = await chromium.launch(launchOptions);
      const evidence = await cases[name](browser, origin);
      results.push({ case: name, status: "passed", durationMs: Date.now() - started, evidence });
    } catch (error) {
      results.push({ case: name, status: "failed", durationMs: Date.now() - started, error: error.stack ?? String(error) });
    } finally {
      await browser?.close().catch(() => {});
      browser = undefined;
    }
    console.log(JSON.stringify(results.at(-1)));
  }
  if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
} catch (error) {
  results.push({ case: "setup", status: "failed", error: error.stack ?? String(error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify({ browser: process.env.ATLAS_CHROMIUM_EXECUTABLE ?? "playwright-managed", cases: results }, null, 2));
  }
}
