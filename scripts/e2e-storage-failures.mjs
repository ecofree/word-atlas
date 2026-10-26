#!/usr/bin/env node
/**
 * Real-browser storage failure and lifecycle regressions in fresh contexts.
 *
 *   node scripts/e2e-storage-failures.mjs
 *   node scripts/e2e-storage-failures.mjs --case quota-retry --output /tmp/storage.json
 *
 * Uses the same ATLAS_CHROMIUM_EXECUTABLE, ATLAS_CHROMIUM_ARGS and
 * ATLAS_CHROMIUM_ARGS_MODULE overrides as e2e-regressions.mjs. Owns a temporary
 * loopback Vite server and a separate browser per case; never uses user storage.
 * Storage failures and visibility events are controlled, while the app, Web
 * Locks, localStorage, cross-page storage events and backup downloads are real.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const index = JSON.parse(await fs.readFile(path.join(root, "public/atlas/index.json"), "utf8"));
assert.ok(index.words.length >= 3, "Storage regressions require three real atlas words.");
const [firstId, secondId, thirdId] = index.words.slice(0, 3).map((row) => row[0]);
const progressKey = `word-atlas:v2:${index.id}`;
const recoveryKey = `${progressKey}:before-import`;
const settingsKey = "word-atlas:settings";
const settings = {
  accent: "uk", autoplay: false, dailyNew: 10, retention: 0.9, theme: "light", sfx: false,
  spell: true, startLevel: 0, onboarded: true, dataset: "open", ambience: "off", ambienceVolume: 0, splash: false,
};
const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=", "base64");

function savedProgress(id = firstId) {
  const now = 1_760_000_000_000;
  return {
    version: 2, datasetId: index.id,
    cards: { [id]: { due: now + 86_400_000, s: 1, d: 5, el: 0, sd: 1, ls: 0, reps: 1, lapses: 0, st: 2, last: now, seen: now } },
    bookmarks: [id], days: { "2025-10-09": { n: 1, r: 1, c: 1, t: 30 } },
    typing: [{ at: now, mode: "word", items: 1, wpm: 20, accuracy: 90 }], mistakes: [id], session: null,
  };
}

function incomingBackup() {
  return {
    app: "word-atlas", version: 2, exported: new Date().toISOString(),
    progress: savedProgress(secondId), settings: { ...settings, accent: "us", theme: "dark", dailyNew: 15 },
  };
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const { store } = await import("/src/store/store.ts");
    const state = store.get();
    const key = `word-atlas:v2:${state.progress.datasetId}`;
    return JSON.parse(JSON.stringify({
      ...state, savedProgress: localStorage.getItem(key), savedSettings: localStorage.getItem("word-atlas:settings"),
      recovery: localStorage.getItem(`${key}:before-import`),
    }));
  });
}

async function waitForAccess(page, access) {
  await page.waitForFunction(async (expected) => (await import("/src/store/store.ts")).store.get().writeAccess === expected, access);
}

async function failWrites(page, rules) {
  await page.evaluate((rules) => {
    if (!window.__atlasStorageFaults) {
      const original = Storage.prototype.setItem;
      window.__atlasStorageFaults = { rules: [], attempts: [] };
      Storage.prototype.setItem = function (key, value) {
        const state = window.__atlasStorageFaults;
        if (this === localStorage) {
          const rule = state.rules.find((rule) => rule.key === key && (rule.remaining === null || rule.remaining > 0));
          if (rule && rule.skip > 0) rule.skip--;
          else if (rule) {
            if (rule.remaining !== null) rule.remaining--;
            state.attempts.push({ key, failed: true });
            throw new DOMException("Injected storage quota failure", "QuotaExceededError");
          }
          state.attempts.push({ key, failed: false });
        }
        return original.call(this, key, value);
      };
    }
    window.__atlasStorageFaults.rules = rules.map((rule) => ({ skip: 0, remaining: null, ...rule }));
  }, rules);
}

async function changeBookmarks(page, ids) {
  return page.evaluate(async (bookmarks) => {
    const { store } = await import("/src/store/store.ts");
    return store.progress((progress) => ({ ...progress, bookmarks }));
  }, ids);
}

async function retry(page) {
  await page.evaluate(async () => (await import("/src/store/store.ts")).store.retryWriter());
}

async function downloadJSON(page, name = "导出备份") {
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  const stream = await (await downloading).createReadStream();
  assert.ok(stream, "The backup download must contain data.");
  const bytes = [];
  for await (const chunk of stream) bytes.push(chunk);
  return JSON.parse(Buffer.concat(bytes).toString("utf8"));
}

async function importJSON(page, backup, expectedError) {
  await page.locator('input[type="file"]').setInputFiles({ name: "replacement.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await page.locator(".toast-warn").filter({ hasText: expectedError }).waitFor();
}

async function setVisibility(page, visibility) {
  // Headless pages can all remain visible. Dispatch the production lifecycle
  // signal deterministically without replacing Web Locks or storage behavior.
  await page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visibility);
}

async function openPage(context, origin, pageErrors) {
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/#/me`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "你的星空", exact: true }).waitFor();
  return page;
}

async function runCase(browser, origin, check) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block", reducedMotion: "reduce" });
  const pageErrors = [];
  await context.addInitScript(({ origin, settings, progress }) => {
    if (location.origin !== origin) return;
    const key = `word-atlas:v2:${progress.datasetId}`;
    if (localStorage.getItem("word-atlas:settings") === null) localStorage.setItem("word-atlas:settings", JSON.stringify(settings));
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(progress));
    window.addEventListener("storage", (event) => {
      if (window.__atlasDropStorageEvents) event.stopImmediatePropagation();
    }, true);
  }, { origin, settings, progress: savedProgress() });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.resourceType() === "font") return route.abort();
    if (request.resourceType() === "image" || /\.(?:png|jpe?g|webp|gif|svg)$/i.test(url.pathname)) return route.fulfill({ status: 200, contentType: "image/png", body: pixel });
    if (url.pathname === "/local/catalog.json") return route.fulfill({ status: 200, contentType: "text/plain", body: "not configured" });
    return route.continue();
  });
  try {
    const page = await openPage(context, origin, pageErrors);
    await waitForAccess(page, "writable");
    const evidence = await check({ context, page, pageErrors, origin });
    assert.deepEqual(pageErrors, [], "Storage failures must not cause uncaught app errors.");
    return { ...evidence, pageErrors };
  } finally {
    await context.close();
  }
}

const cases = {
  "quota-retry": async ({ page }) => {
    const before = await snapshot(page);
    await failWrites(page, [{ key: progressKey }]);
    assert.equal(await changeBookmarks(page, [firstId, secondId]), true);
    const failed = await snapshot(page);
    assert.equal(failed.saveError, true);
    assert.deepEqual(failed.progress.bookmarks, [firstId, secondId]);
    assert.equal(failed.savedProgress, before.savedProgress, "A quota failure must preserve the saved snapshot.");
    const exported = await downloadJSON(page);
    assert.deepEqual(exported.progress, failed.progress, "Export must include unsaved memory progress.");
    await failWrites(page, []);
    await page.locator('.write-notice[role="alert"]').getByRole("button", { name: "重试保存", exact: true }).click();
    const retried = await snapshot(page);
    assert.equal(retried.saveError, false);
    assert.deepEqual(JSON.parse(retried.savedProgress), failed.progress);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForAccess(page, "writable");
    assert.deepEqual((await snapshot(page)).progress, failed.progress);
    return { memoryBackupVerified: true, retrySaved: true, reloadPreserved: true };
  },

  "settings-quota-retry": async ({ context, page, pageErrors, origin }) => {
    const before = await snapshot(page);
    await failWrites(page, [{ key: settingsKey }]);
    await page.evaluate(async () => {
      const { store } = await import("/src/store/store.ts");
      store.settings({ theme: "dark" });
      store.settings({ accent: "us" });
    });
    const failed = await snapshot(page);
    assert.equal(failed.saveError, true);
    assert.equal(failed.settings.theme, "dark", "A second failed settings patch must retain the first patch.");
    assert.equal(failed.settings.accent, "us");
    assert.equal(failed.savedSettings, before.savedSettings);
    const second = await openPage(context, origin, pageErrors);
    await waitForAccess(second, "readonly");
    await second.evaluate(async () => (await import("/src/store/store.ts")).store.settings({ dailyNew: 23 }));
    await page.waitForFunction(async () => (await import("/src/store/store.ts")).store.get().settings.dailyNew === 23);
    const merged = await snapshot(page);
    assert.equal(merged.settings.theme, "dark", "A storage event must not erase this window's pending theme.");
    assert.equal(merged.settings.accent, "us");
    assert.equal(merged.settings.dailyNew, 23);
    assert.deepEqual((await downloadJSON(page)).settings, merged.settings, "Export must preserve unsaved settings and the other window's updates.");
    await failWrites(page, []);
    await retry(page);
    const retried = await snapshot(page);
    assert.equal(retried.saveError, false);
    assert.deepEqual(JSON.parse(retried.savedSettings), merged.settings, "Retry must merge pending fields with the other window's latest settings.");
    assert.equal(retried.savedProgress, before.savedProgress);
    return { failedPatchesMerged: true, concurrentWindowFieldPreserved: true, memorySettingsExported: true, retrySavedSettings: true };
  },

  "import-recovery-failure": async ({ page }) => {
    const before = await snapshot(page);
    await failWrites(page, [{ key: recoveryKey }]);
    await importJSON(page, incomingBackup(), "无法保存导入前的恢复副本");
    const after = await snapshot(page);
    assert.deepEqual(after, before, "Recovery failure must abort before touching memory, progress or settings.");
    return { replacementAborted: true, previousProgressAndSettingsPreserved: true };
  },

  "import-progress-failure": async ({ page }) => {
    const before = await snapshot(page);
    await failWrites(page, [{ key: progressKey }]);
    await importJSON(page, incomingBackup(), "浏览器拒绝保存备份");
    const after = await snapshot(page);
    assert.deepEqual(after.progress, before.progress);
    assert.deepEqual(after.settings, before.settings);
    assert.equal(after.savedProgress, before.savedProgress);
    assert.equal(after.savedSettings, before.savedSettings);
    assert.deepEqual(JSON.parse(after.recovery).progress, before.progress);
    return { originalProgressPreserved: true, originalSettingsPreserved: true, recoveryRetained: true };
  },

  "import-settings-failure": async ({ page }) => {
    const before = await snapshot(page);
    await failWrites(page, [{ key: settingsKey }]);
    await importJSON(page, incomingBackup(), "设置保存失败");
    const after = await snapshot(page);
    assert.deepEqual(after.progress, before.progress);
    assert.deepEqual(after.settings, before.settings);
    assert.deepEqual(JSON.parse(after.savedProgress), before.progress, "Settings failure must roll back the progress replacement.");
    assert.equal(after.savedSettings, before.savedSettings);
    assert.deepEqual(JSON.parse(after.recovery).progress, before.progress);
    await failWrites(page, []);
    await retry(page);
    const retried = await snapshot(page);
    assert.equal(retried.saveError, false, "Successful rollback must not leave a permanent save-error alert.");
    assert.deepEqual(JSON.parse(retried.savedProgress), before.progress);
    assert.equal(retried.savedSettings, before.savedSettings);
    return { progressRolledBack: true, settingsPreserved: true, retryClearedError: true };
  },

  "import-rollback-failure": async ({ page }) => {
    const before = await snapshot(page);
    const incoming = incomingBackup();
    await failWrites(page, [{ key: settingsKey }, { key: progressKey, skip: 1, remaining: 1 }]);
    await importJSON(page, incoming, "设置保存失败");
    const after = await snapshot(page);
    assert.equal(after.saveError, true);
    assert.deepEqual(after.progress, before.progress, "Even a failed rollback must retain old progress in memory.");
    assert.equal(after.savedSettings, before.savedSettings);
    assert.deepEqual(JSON.parse(after.savedProgress), incoming.progress, "The injected rollback failure must actually occur.");
    assert.deepEqual(JSON.parse(after.recovery).progress, before.progress);
    // Keep subsequent export flushes failing so the backup proves RAM recovery.
    await failWrites(page, [{ key: progressKey }]);
    assert.deepEqual((await downloadJSON(page)).progress, before.progress);
    assert.deepEqual((await downloadJSON(page, "导出上次导入前的备份")).progress, before.progress);
    await failWrites(page, []);
    await retry(page);
    const retried = await snapshot(page);
    assert.equal(retried.saveError, false);
    assert.deepEqual(JSON.parse(retried.savedProgress), before.progress);
    return { failedRollbackRetainedMemory: true, recoveryDownloadVerified: true, retryRestoredOriginal: true };
  },

  "resume-latest-progress": async ({ context, page: first, pageErrors, origin }) => {
    const before = await snapshot(first);
    const second = await openPage(context, origin, pageErrors);
    await waitForAccess(second, "readonly");
    await first.evaluate(() => { window.__atlasDropStorageEvents = true; });
    await setVisibility(first, "hidden");
    await waitForAccess(second, "writable");
    assert.equal(await changeBookmarks(second, [secondId]), true);
    const latest = await snapshot(second);
    assert.deepEqual((await snapshot(first)).progress, before.progress, "The returning page must start with a deliberately stale snapshot.");
    await setVisibility(second, "hidden");
    await setVisibility(first, "visible");
    await waitForAccess(first, "writable");
    assert.deepEqual((await snapshot(first)).progress, latest.progress, "Ownership reacquisition must reread the latest saved progress.");
    assert.equal(await changeBookmarks(first, [secondId, thirdId]), true);
    assert.deepEqual(JSON.parse((await snapshot(first)).savedProgress).bookmarks, [secondId, thirdId]);
    return { realLockHandoff: true, missedStorageEventRecovered: true, latestProgressPreserved: true };
  },

  "resume-dirty-conflict": async ({ context, page: first, pageErrors, origin }) => {
    await failWrites(first, [{ key: progressKey }]);
    assert.equal(await changeBookmarks(first, [firstId, thirdId]), true);
    const unsaved = await snapshot(first);
    const second = await openPage(context, origin, pageErrors);
    await waitForAccess(second, "readonly");
    await setVisibility(first, "hidden");
    await waitForAccess(second, "writable");
    assert.equal(await changeBookmarks(second, [secondId]), true);
    const latest = await snapshot(second);
    await setVisibility(second, "hidden");
    await failWrites(first, []);
    await setVisibility(first, "visible");
    await waitForAccess(first, "conflict");
    const resumed = await snapshot(first);
    assert.equal(resumed.saveError, true);
    assert.deepEqual(resumed.progress, unsaved.progress, "Conflicting unsaved memory must remain recoverable.");
    assert.equal(resumed.savedProgress, latest.savedProgress, "A stale returning writer must never overwrite another page's progress.");
    assert.equal(await changeBookmarks(first, [firstId]), false);
    assert.deepEqual((await downloadJSON(first)).progress, unsaved.progress);
    assert.equal((await snapshot(first)).savedProgress, latest.savedProgress);
    return { conflictFailedClosed: true, latestSavedProgressUntouched: true, unsavedBackupVerified: true };
  },
};

const selected = [];
let output;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--list") { console.log(Object.keys(cases).join("\n")); process.exit(0); }
  if (arg === "--case" && process.argv[i + 1]) selected.push(...process.argv[++i].split(",").filter(Boolean));
  else if (arg.startsWith("--case=")) selected.push(...arg.slice(7).split(",").filter(Boolean));
  else if (arg === "--output" && process.argv[i + 1]) output = path.resolve(process.argv[++i]);
  else if (arg === "--all") selected.push(...Object.keys(cases));
  else if (arg === "--help") {
    console.log("Usage: node scripts/e2e-storage-failures.mjs [--case name[,name]] [--output file] [--list]");
    process.exit(0);
  } else throw new Error(`Unknown or incomplete argument: ${arg}`);
}
const names = [...new Set(selected.length ? selected : Object.keys(cases))];
for (const name of names) if (!cases[name]) throw new Error(`Unknown case: ${name}`);
let extraArgs = process.env.ATLAS_CHROMIUM_ARGS ? JSON.parse(process.env.ATLAS_CHROMIUM_ARGS) : [];
if (!Array.isArray(extraArgs) || extraArgs.some((arg) => typeof arg !== "string")) throw new Error("ATLAS_CHROMIUM_ARGS must be a JSON string array.");
if (process.env.ATLAS_CHROMIUM_ARGS_MODULE) {
  const module = await import(pathToFileURL(path.resolve(process.env.ATLAS_CHROMIUM_ARGS_MODULE)).href);
  const args = module.default?.args ?? module.args;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("ATLAS_CHROMIUM_ARGS_MODULE must export an args string array.");
  extraArgs = [...args, ...extraArgs];
}

let server;
let browser;
const results = [];
try {
  server = await createServer({ root, configFile: path.join(root, "vite.config.ts"), base: "/", logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false, watch: null } });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object", "Vite did not open a loopback HTTP socket.");
  const origin = `http://127.0.0.1:${address.port}`;
  for (const name of names) {
    const started = Date.now();
    try {
      browser = await chromium.launch({ headless: true, executablePath: process.env.ATLAS_CHROMIUM_EXECUTABLE || undefined, args: ["--no-sandbox", "--disable-dev-shm-usage", ...extraArgs] });
      const evidence = await runCase(browser, origin, cases[name]);
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
