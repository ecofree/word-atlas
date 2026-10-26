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
// A short valid PCM WAV prevents media requests from hitting missing sparse assets.
const silentWave = Buffer.alloc(44 + 800);
silentWave.write("RIFF", 0); silentWave.writeUInt32LE(silentWave.length - 8, 4); silentWave.write("WAVEfmt ", 8);
silentWave.writeUInt32LE(16, 16); silentWave.writeUInt16LE(1, 20); silentWave.writeUInt16LE(1, 22);
silentWave.writeUInt32LE(8000, 24); silentWave.writeUInt32LE(16000, 28); silentWave.writeUInt16LE(2, 32);
silentWave.writeUInt16LE(16, 34); silentWave.write("data", 36); silentWave.writeUInt32LE(800, 40);

const cases = {
  "load-retry": testLoadRetry,
  "modal-shortcuts": testModalShortcuts,
  "writer-handoff": testWriterHandoff,
  "no-web-locks": testNoWebLocks,
  "backup-version-rejection": testBackupVersionRejection,
  "backup-recovery": testBackupRecovery,
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
  await page.waitForFunction(async (expected) => {
    const { store } = await import("/src/store/store.ts");
    return store.get().writeAccess === expected;
  }, access);
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

async function createCase(browser, origin, intercept, progress = resumedQuiz()) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
  await context.addInitScript(({ settings, progress, origin }) => {
    if (location.origin !== origin) return;
    // A second page and a reload must observe the first page's real saved data.
    if (localStorage.getItem("word-atlas:settings") === null) localStorage.setItem("word-atlas:settings", JSON.stringify(settings));
    const key = `word-atlas:v2:${progress.datasetId}`;
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(progress));
  }, { settings, progress, origin });
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
