import { Headphones, Keyboard, RotateCcw, Type } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { prefetch, useAtlas } from "../atlas/context";
import type { Entry } from "../atlas/types";
import { play, stopAudio } from "../lib/audio";
import { cue } from "../lib/sound";
import { acceptedForms, acceptsAnswer, hashSeed, preferredForm } from "../lib/text";
import { practiceTarget, samplePracticeIds, TypingRun } from "../lib/practice";
import { same, typingMetrics } from "../lib/typing";
import { flush, store, useStore, type TypingRound as SavedTypingRound } from "../store/store";
import { AmbiencePicker } from "../ui/Ambience";
import { Illustration } from "../ui/Illustration";

type Mode = "word" | "sentence" | "dictation";
type Source = "recent" | "mistakes" | "saved" | "path";

const MODES: [Mode, string, string, typeof Type][] = [
  ["word", "单词", "看图写出单词", Type],
  ["sentence", "例句", "照着抄写，练出手感", Keyboard],
  ["dictation", "听写", "只听声音，写下整句", Headphones],
];
const SOURCES: [Source, string][] = [
  ["recent", "最近学过"],
  ["mistakes", "错词本"],
  ["saved", "收藏"],
  ["path", "学习路线"],
];

export function Practice() {
  const atlas = useAtlas();
  const progress = useStore((s) => s.progress);
  const startLevel = useStore((s) => s.settings.startLevel);
  const [mode, setMode] = useState<Mode>("word");
  const [source, setSource] = useState<Source>(() => (Object.keys(progress.cards).length ? "recent" : "path"));
  const [round, setRound] = useState<{ entries: Entry[]; key: number; mode: Mode } | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const request = useRef(0);
  const loading = useRef(false);
  useEffect(() => () => { request.current++; }, []);

  const pool = useMemo(() => {
    const learned = Object.entries(progress.cards)
      .sort((a, b) => (b[1].last ?? 0) - (a[1].last ?? 0))
      .map(([id]) => id);
    const ids =
      source === "recent" ? learned : source === "mistakes" ? progress.mistakes : source === "saved" ? progress.bookmarks : atlas.words.filter((w) => w.cefr >= startLevel).slice(0, 400).map((w) => w.id);
    return ids.filter((id) => atlas.byId.has(id));
  }, [atlas, progress.cards, progress.mistakes, progress.bookmarks, source, startLevel]);

  const start = async () => {
    if (loading.current || store.get().writeAccess !== "writable") return;
    const key = ++request.current;
    loading.current = true;
    setStarting(true);
    setStartError(null);
    const ids = samplePracticeIds(pool, hashSeed(String(Date.now())));
    const entries = (await prefetch(atlas, ids)).filter((e): e is Entry => !!e && (mode === "word" || e.ex.length > 0));
    if (request.current !== key) return;
    loading.current = false;
    setStarting(false);
    if (entries.length) setRound({ entries, key, mode });
    else setStartError("这轮词条暂时加载不了，请检查网络后重试。");
  };

  const cancelRound = () => {
    request.current++;
    loading.current = false;
    setStarting(false);
    setStartError(null);
    setRound(null);
  };

  if (round) return <TypingRound key={round.key} mode={round.mode} entries={round.entries} onExit={cancelRound} onAgain={start} restarting={starting} startError={startError} />;

  const best = progress.typing.filter((t) => t.mode === mode).reduce((m, t) => Math.max(m, t.wpm), 0);
  return (
    <div className="page practice">
      <header className="page-head">
        <p className="eyebrow">练习 · Typing Studio</p>
        <h1 className="display">让手，也记住它们。</h1>
        <p className="lede">打字只练拼写和手感，不会改动记忆进度。</p>
      </header>
      <div className="practice-grid">
        <section className="panel">
          <h3 className="eyebrow">模式</h3>
          <div className="mode-cards">
            {MODES.map(([k, name, desc, Icon]) => (
              <button key={k} className={`mode-card ${mode === k ? "is-on" : ""}`} onClick={() => setMode(k)} aria-pressed={mode === k} disabled={starting}>
                <Icon size={22} strokeWidth={1.7} />
                <b>{name}</b>
                <small>{desc}</small>
              </button>
            ))}
          </div>
          <h3 className="eyebrow">词来自</h3>
          <div className="segmented segmented-wide">
            {SOURCES.map(([k, label]) => (
              <button key={k} className={source === k ? "is-on" : ""} onClick={() => setSource(k)} aria-pressed={source === k} disabled={starting}>
                {label}
              </button>
            ))}
          </div>
          <p className="muted">
            {pool.length
              ? source === "path"
                ? "从学习路线的前 400 个词里随机抽 10 个。"
                : `可练 ${pool.length} 个词，每轮随机 10 个。`
              : "这里还没有词，先去学几个，或换个来源。"}
          </p>
          {startError && <p role="alert">{startError}</p>}
          <button className="btn btn-primary btn-xl" onClick={start} disabled={!pool.length || starting}>
            {starting ? "正在准备…" : "开始一轮"}
          </button>
        </section>
        <section className="panel practice-side">
          <img src={`${import.meta.env.BASE_URL}brand/${mode === "dictation" ? "listen" : "typing"}.webp`} alt="" />
          <dl className="mini-stats">
            <div>
              <dt>最佳速度</dt>
              <dd>
                {best}
                <small>WPM</small>
              </dd>
            </div>
            <div>
              <dt>完成轮次</dt>
              <dd>{progress.typing.length}</dd>
            </div>
          </dl>
          <p className="muted">WPM 按标准每 5 个字符计 1 词，只统计正确输入。</p>
        </section>
      </div>
    </div>
  );
}

function TypingRound({ mode, entries, onExit, onAgain, restarting, startError }: { mode: Mode; entries: Entry[]; onExit: () => void; onAgain: () => void; restarting: boolean; startError: string | null }) {
  const atlas = useAtlas();
  const settings = useStore((s) => s.settings);
  const [run] = useState(() => new TypingRun(entries.length));
  const [state, setState] = useState(() => run.snapshot());
  const { index: i, value, phase, active, totals } = state;
  const refresh = useCallback(() => setState(run.snapshot()), [run]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const record = useRef<SavedTypingRound | null>(null);
  const recorded = useRef(false);
  const attemptedSave = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const e = entries[i];
  const forms = mode === "word" ? acceptedForms(e.w) : [e.ex[0].en];
  const target = mode === "word" ? practiceTarget(forms, value) || preferredForm(e.w) : e.ex[0].en;

  useEffect(() => {
    const update = () => {
      run.setActive(document.visibilityState !== "hidden" && store.get().writeAccess === "writable", performance.now());
      refresh();
    };
    const unsubscribe = store.subscribe(update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", update);
      run.setActive(false, performance.now());
    };
  }, [run, refresh]);

  useEffect(() => {
    if (!active || phase !== "typing") { stopAudio(); return; }
    input.current?.focus();
    if (mode === "dictation") void play(atlas.audio(e, "ex"), e.ex[0].en, settings.accent);
    if (mode === "word" && settings.autoplay) void play(atlas.audio(e, settings.accent), e.w, settings.accent);
  }, [i, active, phase]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => stopAudio(), []);

  useEffect(() => {
    if (phase !== "transition" || !active) return;
    const timer = window.setTimeout(() => { if (run.advance()) refresh(); }, 260);
    return () => window.clearTimeout(timer);
  }, [run, refresh, i, phase, active]);

  const saveResult = useCallback(() => {
    if (run.snapshot().phase !== "saving") return;
    attemptedSave.current = true;
    if (store.get().writeAccess !== "writable" || document.visibilityState === "hidden") {
      setSaveError("请回到拥有编辑权限的窗口后重试保存，本轮输入会保留。");
      return;
    }
    if (!record.current) {
      const t = run.snapshot().totals;
      const m = typingMetrics(t.correct, t.typed, t.accepted, t.ms);
      record.current = { at: Date.now(), mode, items: entries.length, wpm: m.wpm, accuracy: m.accuracy };
    }
    if (!recorded.current) {
      const saved = record.current;
      if (!store.progress((p) => ({ ...p, typing: [...p.typing, saved].slice(-500) }))) {
        setSaveError("暂时不能保存本轮记录，请恢复编辑权限后重试。");
        return;
      }
      recorded.current = true;
    }
    // An accepted mutation can still be dirty when localStorage is full. A retry
    // flushes that same record instead of appending the completed round again.
    if (!flush() || store.get().saveError) {
      setSaveError("浏览器还没有保存这轮记录。请重试保存，或到「我的」导出备份。");
      return;
    }
    run.saved();
    setSaveError(null);
    refresh();
  }, [run, refresh, mode, entries.length]);

  useEffect(() => {
    if (phase === "saving" && active && !attemptedSave.current) saveResult();
  }, [phase, active, saveResult]);

  const onChange = (next: string) => {
    if (store.get().writeAccess !== "writable" || document.visibilityState === "hidden") return;
    const expected = mode === "word" ? practiceTarget(forms, next) : target;
    const complete = mode === "word" ? acceptsAnswer(next, e.w) : same(next.trimEnd(), target);
    const result = run.change(next, expected, complete, performance.now());
    if (!result) return;
    if (settings.sfx && result.inserted > 0) void cue("key");
    if (settings.sfx && result.completed) void cue("correct");
    refresh();
  };

  const m = typingMetrics(totals.correct, totals.typed, totals.accepted, totals.ms);
  const chars = Array.from(target);
  const typed = Array.from(value);

  if (phase === "done" || phase === "saving")
    return (
      <div className="page practice">
        <section className="panel typing-done">
          <p className="eyebrow">{phase === "done" ? "本轮完成" : "本轮记录尚未保存"}</p>
          <h1 className="display">
            {m.wpm} <small>WPM</small>
          </h1>
          <p className="lede">准确率 {m.accuracy}% · {entries.length} 项</p>
          {saveError && <p role="alert">{saveError}</p>}
          {startError && <p role="alert">{startError}</p>}
          <div className="summary-actions">
            <button className="btn btn-ghost" onClick={onExit}>
              返回
            </button>
            {phase === "done" ? (
              <button className="btn btn-primary btn-xl" onClick={onAgain} autoFocus disabled={restarting}>
                <RotateCcw size={18} /> {restarting ? "正在准备…" : "再来一轮"}
              </button>
            ) : <button className="btn btn-primary btn-xl" onClick={saveResult} disabled={!active}>重试保存</button>}
          </div>
        </section>
      </div>
    );

  return (
    <div className="page practice typing">
      <header className="typing-top">
        <button className="btn btn-ghost" onClick={onExit}>
          结束
        </button>
        <AmbiencePicker />
        <div className="learn-progress">
          <span style={{ width: `${(i / entries.length) * 100}%` }} />
        </div>
        <span className="typing-meter">
          <b>{m.wpm}</b> WPM · <b>{m.accuracy}%</b>
        </span>
      </header>
      <section className="typing-stage" onClick={() => input.current?.focus()}>
        {mode === "word" && (
          <div className="typing-cue">
            <Illustration src={atlas.img(e)} word={e.w} topic={0} eager />
            <p>
              <span className="pos">{e.senses[0].pos}</span> {e.senses[0].zh}
            </p>
          </div>
        )}
        {mode !== "word" && (
          <p className="typing-zh">
            {mode === "dictation" && (
              <button className="link" onClick={() => play(atlas.audio(e, "ex"), e.ex[0].en, settings.accent)}>
                再听一遍
              </button>
            )}
            {e.ex[0].zh}
          </p>
        )}
        <p className={`typing-text ${mode === "word" ? "is-word" : ""} ${mode === "dictation" ? "is-hidden" : ""}`} lang="en" aria-hidden="true">
          {chars.map((ch, k) => {
            const t = typed[k];
            const cls = t === undefined ? (k === typed.length ? "is-caret" : "") : same(t, ch) ? "is-ok" : "is-bad";
            const show = mode === "dictation" && t === undefined ? (ch === " " ? " " : /[A-Za-z]/.test(ch) ? "·" : ch) : ch;
            return (
              <span key={k} className={cls}>
                {show}
              </span>
            );
          })}
        </p>
        <input
          ref={input}
          className="typing-input"
          value={value}
          readOnly={phase !== "typing" || !active}
          onChange={(ev) => onChange(ev.target.value)}
          autoFocus
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-label="在这里输入"
        />
        <p className="muted typing-help">
          {mode === "dictation" ? "听不清可以点「再听一遍」。" : "直接开始输入，全部正确后自动进入下一项。"} 第 {i + 1}/{entries.length} 项
        </p>
      </section>
    </div>
  );
}
