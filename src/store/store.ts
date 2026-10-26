import { useSyncExternalStore } from "react";
import type { Accent } from "../atlas/types";
import type { CardState, Grade } from "./srs";
import { DatasetWriter, type WriteAccess } from "./writer";

export type QuizKind = "meaning" | "picture" | "listen" | "spell";
export type Step = { id: string; kind: "intro" } | { id: string; kind: QuizKind; retry?: boolean; options?: string[] };

export interface ActiveSession {
  id: string;
  started: number;
  steps: Step[];
  index: number;
  /** First-attempt grade per word; retries never change it. */
  graded: Record<string, Grade>;
  newIds: string[];
  reviewIds: string[];
  /** Answer shown but not yet continued; survives reload without double counting. */
  pending?: { correct: boolean; value: string };
  finished?: number;
}

export interface DayStat {
  n: number; // new words met
  r: number; // graded reviews (first attempts)
  c: number; // correct first attempts
  t: number; // active seconds
}

export interface TypingRound {
  at: number;
  mode: "word" | "sentence" | "dictation";
  items: number;
  wpm: number;
  accuracy: number;
}

export interface Progress {
  version: 2;
  datasetId: string;
  cards: Record<string, CardState>;
  bookmarks: string[];
  days: Record<string, DayStat>;
  typing: TypingRound[];
  session: ActiveSession | null;
  /** Rolling list of recent mistakes, newest first. */
  mistakes: string[];
}

export interface Settings {
  accent: Accent;
  autoplay: boolean;
  dailyNew: number;
  retention: number;
  theme: "system" | "light" | "dark";
  sfx: boolean;
  spell: boolean;
  startLevel: number;
  onboarded: boolean;
  dataset: "open" | "private";
  ambience: "off" | "stars" | "rain" | "sea" | "forest" | "fire" | "voyage" | "cafe";
  ambienceVolume: number;
  splash: boolean;
}

export const defaultSettings: Settings = {
  accent: "uk",
  autoplay: true,
  dailyNew: 10,
  retention: 0.9,
  theme: "dark",
  sfx: true,
  spell: true,
  startLevel: 0,
  onboarded: false,
  dataset: "open",
  ambience: "stars",
  ambienceVolume: 0.45,
  splash: true,
};

export const emptyProgress = (datasetId: string): Progress => ({
  version: 2,
  datasetId,
  cards: {},
  bookmarks: [],
  days: {},
  typing: [],
  session: null,
  mistakes: [],
});

export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const SETTINGS_KEY = "word-atlas:settings";
const progressKey = (id: string) => `word-atlas:v2:${id}`;
const recoveryKey = (id: string) => `${progressKey(id)}:before-import`;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* ---------- validation (backups and stored data are untrusted) ---------- */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, lo = -Infinity, hi = Infinity) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const validId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][\w-]{0,127}$/.test(v) && !["__proto__", "constructor", "prototype"].includes(v);
const idList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 20000 && v.every(validId);
const validDay = (v: unknown): v is DayStat => isObj(v) && num(v.n, 0) && num(v.r, 0) && num(v.c, 0) && num(v.t, 0) && (v.c as number) <= (v.r as number);
const validTyping = (v: unknown): v is TypingRound => isObj(v) && num(v.at, 0) && ["word", "sentence", "dictation"].includes(v.mode as string) && num(v.items, 0) && num(v.wpm, 0, 400) && num(v.accuracy, 0, 100);

function validSession(v: unknown): v is ActiveSession {
  if (!isObj(v) || typeof v.id !== "string" || !num(v.started, 0) || !Array.isArray(v.steps) || !Number.isInteger(v.index) || !num(v.index, 0, v.steps.length)) return false;
  if (!idList(v.newIds) || !idList(v.reviewIds) || !isObj(v.graded) || Object.entries(v.graded).some(([id, g]) => !validId(id) || ![1, 2, 3, 4].includes(g as number))) return false;
  if (v.steps.some((s) => !isObj(s) || !validId(s.id) || !["intro", "meaning", "picture", "listen", "spell"].includes(s.kind as string) || (s.options !== undefined && !idList(s.options)) || (s.retry !== undefined && typeof s.retry !== "boolean"))) return false;
  return (v.finished === undefined || num(v.finished, 0)) && (v.pending === undefined || (isObj(v.pending) && typeof v.pending.correct === "boolean" && typeof v.pending.value === "string"));
}

function validCard(v: unknown): v is CardState {
  return (
    isObj(v) &&
    num(v.due, 0) &&
    num(v.s, 0) &&
    num(v.d, 0, 11) &&
    num(v.el, 0) &&
    num(v.sd, 0) &&
    num(v.ls, 0) &&
    num(v.reps, 0) &&
    num(v.lapses, 0) &&
    [0, 1, 2, 3].includes(v.st as number) &&
    (v.last === undefined || num(v.last, 0)) &&
    num(v.seen, 0)
  );
}

export function sanitizeProgress(v: unknown, datasetId: string): Progress {
  const out = emptyProgress(datasetId);
  if (!isObj(v) || v.version !== 2) return out;
  if (isObj(v.cards)) for (const [k, c] of Object.entries(v.cards)) if (validId(k) && validCard(c)) out.cards[k] = c;
  if (Array.isArray(v.bookmarks)) out.bookmarks = v.bookmarks.filter(validId).slice(0, 20000);
  if (Array.isArray(v.mistakes)) out.mistakes = v.mistakes.filter(validId).slice(0, 300);
  if (isObj(v.days))
    for (const [k, d] of Object.entries(v.days))
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && isObj(d) && num(d.n, 0) && num(d.r, 0) && num(d.c, 0) && num(d.t, 0))
        out.days[k] = { n: d.n as number, r: d.r as number, c: d.c as number, t: d.t as number };
  if (Array.isArray(v.typing))
    out.typing = v.typing
      .filter(
        (t): t is TypingRound =>
          isObj(t) && num(t.at, 0) && ["word", "sentence", "dictation"].includes(t.mode as string) && num(t.items, 0) && num(t.wpm, 0, 400) && num(t.accuracy, 0, 100),
      )
      .slice(-500);
  const s = v.session;
  if (validSession(s)) out.session = s;
  return out;
}

export function sanitizeSettings(v: unknown): Settings {
  const s = { ...defaultSettings };
  if (!isObj(v)) return s;
  if (v.accent === "uk" || v.accent === "us") s.accent = v.accent;
  if (typeof v.autoplay === "boolean") s.autoplay = v.autoplay;
  if (num(v.dailyNew, 0, 100)) s.dailyNew = Math.round(v.dailyNew as number);
  if (num(v.retention, 0.7, 0.97)) s.retention = v.retention as number;
  if (v.theme === "system" || v.theme === "light" || v.theme === "dark") s.theme = v.theme;
  if (typeof v.sfx === "boolean") s.sfx = v.sfx;
  if (typeof v.spell === "boolean") s.spell = v.spell;
  if (num(v.startLevel, 0, 5)) s.startLevel = Math.round(v.startLevel as number);
  if (typeof v.onboarded === "boolean") s.onboarded = v.onboarded;
  if (v.dataset === "open" || v.dataset === "private") s.dataset = v.dataset;
  if (["off", "stars", "rain", "sea", "forest", "fire", "voyage", "cafe"].includes(v.ambience as string)) s.ambience = v.ambience as Settings["ambience"];
  if (num(v.ambienceVolume, 0, 1)) s.ambienceVolume = v.ambienceVolume as number;
  if (typeof v.splash === "boolean") s.splash = v.splash;
  return s;
}

/* ---------- store ---------- */

interface State {
  progress: Progress;
  settings: Settings;
  saveError: boolean;
  writeAccess: WriteAccess;
}

let state: State = {
  progress: emptyProgress("word-atlas-open"),
  settings: sanitizeSettings(read(SETTINGS_KEY)),
  saveError: false,
  writeAccess: "loading",
};
const listeners = new Set<() => void>();
/** Failed writes remain dirty and exportable instead of being silently discarded. */
let dirty = false;
/** Retry only this window's unsaved setting changes, preserving other windows' fields. */
let pendingSettings: Partial<Settings> | null = null;
/** Progress is written only after it has been read from storage for this dataset. */
let loadedId: string | null = null;
let persistedProgress = "";

const writer = new DatasetWriter((writeAccess) => {
  if (writeAccess === "writable" && loadedId) {
    // A returning window must reread after gaining ownership, before accepting input.
    // If a previous save failed, preserve that memory snapshot for export/recovery.
    const latest = sanitizeProgress(read(progressKey(loadedId)), loadedId);
    if (dirty) {
      if (JSON.stringify(latest) !== persistedProgress) {
        state = { ...state, writeAccess: "conflict", saveError: true };
        writer.stop();
        emit();
        return;
      }
      state = { ...state, writeAccess };
      flush();
    } else {
      state = { ...state, progress: latest };
      persistedProgress = JSON.stringify(latest);
    }
  }
  state = { ...state, writeAccess };
  emit();
});

function emit() {
  listeners.forEach((l) => l());
}

function requestWriter() {
  if (!loadedId) return;
  if (document.visibilityState === "hidden") {
    state = { ...state, writeAccess: "readonly" };
    emit();
    return;
  }
  writer.start(loadedId);
}

export function flush() {
  if (dirty && writer.canWrite() && loadedId === state.progress.datasetId) {
    if (write(progressKey(state.progress.datasetId), state.progress)) {
      dirty = false;
      persistedProgress = JSON.stringify(state.progress);
    }
  }
  if (pendingSettings) {
    const settings = { ...sanitizeSettings(read(SETTINGS_KEY)), ...pendingSettings };
    state = { ...state, settings };
    if (write(SETTINGS_KEY, settings)) pendingSettings = null;
  }
  const saveError = dirty || pendingSettings !== null;
  if (state.saveError !== saveError) {
    state = { ...state, saveError };
    emit();
  }
  return !saveError;
}

if (typeof window !== "undefined") {
  const suspend = () => {
    flush();
    writer.stop();
    state = { ...state, writeAccess: "readonly" };
    emit();
  };
  const resume = () => {
    if (loadedId && !writer.canWrite()) requestWriter();
  };
  window.addEventListener("pagehide", suspend);
  window.addEventListener("pageshow", resume);
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" ? suspend() : resume());
  window.addEventListener("storage", (e) => {
    if (!e.newValue) return;
    try {
      if (e.key === SETTINGS_KEY) state = { ...state, settings: { ...sanitizeSettings(JSON.parse(e.newValue)), ...pendingSettings } };
      else if (e.key === progressKey(state.progress.datasetId)) {
        if (dirty || writer.canWrite()) return;
        state = { ...state, progress: sanitizeProgress(JSON.parse(e.newValue), state.progress.datasetId) };
      }
      else return;
      emit();
    } catch {
      /* ignore malformed writes */
    }
  });
}

export const store = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  useDataset(datasetId: string) {
    if (!flush()) return false;
    writer.stop();
    state = { ...state, progress: sanitizeProgress(read(progressKey(datasetId)), datasetId) };
    persistedProgress = JSON.stringify(state.progress);
    loadedId = datasetId;
    requestWriter();
    return true;
  },
  retryWriter() {
    flush();
    if (!writer.canWrite()) requestWriter();
  },
  progress(fn: (p: Progress) => Progress) {
    if (!writer.canWrite() || state.writeAccess !== "writable") return false;
    state = { ...state, progress: fn(state.progress) };
    dirty = true;
    flush();
    emit();
    return true;
  },
  settings(patch: Partial<Settings>) {
    pendingSettings = { ...pendingSettings, ...patch };
    const settings = { ...sanitizeSettings(read(SETTINGS_KEY)), ...pendingSettings };
    state = { ...state, settings };
    flush();
    emit();
  },
};

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(state), () => select(state));
}

export function bumpDay(p: Progress, patch: Partial<DayStat>): Progress {
  const k = dayKey();
  const d = p.days[k] ?? { n: 0, r: 0, c: 0, t: 0 };
  return {
    ...p,
    days: {
      ...p.days,
      [k]: { n: d.n + (patch.n ?? 0), r: d.r + (patch.r ?? 0), c: d.c + (patch.c ?? 0), t: d.t + (patch.t ?? 0) },
    },
  };
}

export function toggleBookmark(id: string) {
  store.progress((p) => ({
    ...p,
    bookmarks: p.bookmarks.includes(id) ? p.bookmarks.filter((x) => x !== id) : [id, ...p.bookmarks],
  }));
}

/* ---------- backup ---------- */

export function exportBackup() {
  flush();
  const { progress, settings } = state;
  return JSON.stringify({ app: "word-atlas", version: 2, exported: new Date().toISOString(), progress: { ...progress, session: null }, settings }, null, 1);
}

export type BackupValidation = { ok: true; progress: Progress; settings: Settings } | { ok: false; error: string };

/** Imports are replacements: invalid records must not silently become an empty backup. */
export function validateBackup(data: unknown, datasetId: string): BackupValidation {
  if (!isObj(data) || data.app !== "word-atlas" || data.version !== 2 || !isObj(data.progress))
    return { ok: false, error: "这不是词光的学习备份。" };
  const p = data.progress;
  if (p.datasetId !== datasetId) return { ok: false, error: "备份来自另一个词库，请先切换到对应词库。" };
  if (p.version !== 2 || !isObj(p.cards) || !isObj(p.days) || !idList(p.bookmarks) || !idList(p.mistakes) || !Array.isArray(p.typing) || !isObj(data.settings))
    return { ok: false, error: "备份格式不完整或版本不受支持，现有进度未更改。" };
  if (Object.entries(p.cards).some(([id, card]) => !validId(id) || !validCard(card)) ||
      Object.entries(p.days).some(([day, stat]) => !/^\d{4}-\d{2}-\d{2}$/.test(day) || !validDay(stat)) ||
      p.mistakes.length > 300 || p.typing.length > 500 || p.typing.some((round) => !validTyping(round)) ||
      (p.session !== null && !validSession(p.session)))
    return { ok: false, error: "备份包含损坏的学习记录，现有进度未更改。" };
  return { ok: true, progress: sanitizeProgress({ ...p, session: null }, datasetId), settings: sanitizeSettings(data.settings) };
}

export function exportRecoveryBackup(): string | null {
  const saved = read<unknown>(recoveryKey(state.progress.datasetId));
  return saved && validateBackup(saved, state.progress.datasetId).ok ? JSON.stringify(saved, null, 1) : null;
}

export function importBackup(text: string): { ok: true; cards: number } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "文件不是有效的 JSON。" };
  }
  const id = state.progress.datasetId;
  const validated = validateBackup(data, id);
  if (!validated.ok) return validated;
  if (!writer.canWrite() || state.writeAccess !== "writable") return { ok: false, error: "请在拥有学习进度编辑权限的窗口导入。" };
  if (!flush()) return { ok: false, error: "现有进度尚未保存，请先导出备份并重试。" };
  const previous = state;
  const recovery = { app: "word-atlas", version: 2, exported: new Date().toISOString(), progress: { ...previous.progress, session: null }, settings: previous.settings };
  if (!write(recoveryKey(id), recovery)) return { ok: false, error: "无法保存导入前的恢复副本，现有进度未更改。" };
  const { progress } = validated;
  const settings = { ...validated.settings, dataset: previous.settings.dataset, onboarded: true };
  if (!write(progressKey(id), progress)) return { ok: false, error: "浏览器拒绝保存备份，现有进度未更改。" };
  if (!write(SETTINGS_KEY, settings)) {
    const restored = write(progressKey(id), previous.progress);
    state = { ...previous, saveError: !restored };
    dirty = !restored;
    emit();
    return { ok: false, error: "设置保存失败，已保留导入前恢复副本。请导出备份后重试。" };
  }
  state = { ...state, progress, settings, saveError: false };
  persistedProgress = JSON.stringify(progress);
  emit();
  return { ok: true, cards: Object.keys(progress.cards).length };
}

export function resetProgress() {
  return store.progress(() => emptyProgress(state.progress.datasetId)) && !state.saveError;
}
