import type { Atlas, Entry, IndexRow, WordRef } from "./types";
import { MEDIA } from "./types";
import { validRelease, type AtlasRelease } from "./release";

const BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/$/, "");

interface IndexFile {
  id: string;
  name: string;
  count: number;
  examples: number;
  illustrated: number;
  chunk: number;
  topics: [string, string][];
  cefr: string[];
  words: IndexRow[];
  release?: AtlasRelease;
}

export async function loadOpenAtlas(
  request: typeof fetch = fetch,
  base = BASE,
  requireRelease = import.meta.env?.PROD ?? false,
): Promise<Atlas> {
  const url = (p: string) => `${base.replace(/\/$/, "")}/atlas/${p}`;
  const res = await request(url("index.json"), { cache: "no-cache" });
  if (!res.ok) throw new Error(`词库索引加载失败（${res.status}）`);
  const idx = (await res.json()) as IndexFile;
  if (!Number.isInteger(idx.chunk) || idx.chunk < 1 || !Array.isArray(idx.words) || idx.words.length !== idx.count ||
      (requireRelease && idx.release === undefined) ||
      (idx.release !== undefined && !validRelease(idx.release, Math.ceil(idx.count / idx.chunk)))) {
    throw new Error("词库索引版本无效，请重新加载。");
  }
  const words: WordRef[] = idx.words.map((r, order) => ({
    id: r[0],
    word: r[1],
    zh: r[2],
    ipa: r[3],
    cefr: r[4],
    topic: r[5],
    media: r[6],
    order,
  }));
  const byId = new Map(words.map((w) => [w.id, w]));
  const cache = new Map<string, Entry>();
  const pending = new Map<number, Promise<void>>();

  const loadChunk = (n: number) => {
    let p = pending.get(n);
    if (!p) {
      const address = idx.release?.chunks[n];
      // Fetch integrity works without crypto.subtle, including local HTTP development.
      p = request(url(address?.file ?? `entries/${n}.json`), address ? { integrity: address.integrity } : { cache: "no-cache" })
        .then((r) => {
          if (!r.ok) throw new Error(`词条加载失败（${r.status}）`);
          return r.json() as Promise<Entry[]>;
        })
        .then((list) => {
          const rows = idx.words.slice(n * idx.chunk, (n + 1) * idx.chunk);
          if (!Array.isArray(list) || list.length !== rows.length || list.some((e, k) => !e || e.id !== rows[k][0] || e.w !== rows[k][1])) {
            throw new Error("词库分块与索引不一致，请重试或重新加载。");
          }
          list.forEach((e) => cache.set(e.id, e));
        })
        .catch((e) => {
          pending.delete(n);
          throw e;
        });
      pending.set(n, p);
    }
    return p;
  };

  return {
    id: idx.id,
    name: idx.name,
    kind: "open",
    count: idx.count,
    examples: idx.examples,
    illustrated: idx.illustrated,
    topics: idx.topics,
    cefr: idx.cefr,
    words,
    byId,
    peek: (id) => cache.get(id),
    async entry(id) {
      const hit = cache.get(id);
      if (hit) return hit;
      const ref = byId.get(id);
      if (!ref) throw new Error(`没有找到词条 ${id}`);
      await loadChunk(Math.floor(ref.order / idx.chunk));
      const e = cache.get(id);
      if (!e) throw new Error(`没有找到词条 ${id}`);
      return e;
    },
    img: (ref, size = "full") =>
      ("media" in ref && typeof ref.media === "number" ? ref.media : (ref as Entry).m) & MEDIA.img
        ? url(`${size === "thumb" ? "thumb" : "img"}/${ref.id}.webp`)
        : null,
    audio(ref, kind) {
      const m = "media" in ref && typeof ref.media === "number" ? ref.media : (ref as Entry).m;
      const bit = MEDIA[kind];
      return m & bit ? url(`audio/${kind}/${ref.id}.mp3`) : null;
    },
  };
}

/** Rows from the legacy private catalog served only by the local dev server. */
interface PrivateWord {
  id: string;
  seq: number;
  word: string;
  meaning: string;
  phonetic: string;
  sentence: string;
  translation: string;
  hint: string;
  image?: string | null;
  uk?: string | null;
  us?: string | null;
  sentenceAudio?: string | null;
}

export async function loadPrivateAtlas(open: Atlas | null): Promise<Atlas | null> {
  let res: Response;
  try {
    res = await fetch("/local/catalog.json", { cache: "no-store" });
  } catch {
    return null;
  }
  if (!res.ok || !(res.headers.get("content-type") || "").includes("json")) return null;
  const cat = (await res.json()) as { id: string; name: string; words: PrivateWord[] };
  const entries = new Map<string, Entry>();
  const twins = new Map(open?.words.map((o) => [o.word.toLowerCase(), o]) ?? []);
  const words: WordRef[] = cat.words.map((w, order) => {
    const twin = twins.get(w.word.toLowerCase());
    const pos = (w.meaning.match(/·\s*([a-z]+\.)\s*$/) || [])[1] || "";
    const zh = w.meaning.replace(/\s*·\s*[a-z]+\.\s*$/, "");
    entries.set(w.id, {
      id: w.id,
      w: w.word,
      uk: w.phonetic,
      us: "",
      senses: [{ pos, zh, en: "" }],
      ex: w.sentence ? [{ en: w.sentence, zh: w.translation }] : [],
      col: [],
      fam: [],
      syn: [],
      ant: [],
      tip: w.hint,
      cefr: twin ? (open?.cefr[twin.cefr] ?? "B1") : "B1",
      topic: twin ? (open?.topics[twin.topic]?.[0] ?? "thinking") : "thinking",
      m: (w.image ? MEDIA.img : 0) | (w.uk ? MEDIA.uk : 0) | (w.us ? MEDIA.us : 0) | (w.sentenceAudio ? MEDIA.ex : 0),
      media: { img: w.image, uk: w.uk, us: w.us, ex: w.sentenceAudio },
    });
    return {
      id: w.id,
      word: w.word,
      zh: `${pos} ${zh}`.trim(),
      ipa: w.phonetic,
      cefr: twin?.cefr ?? 2,
      topic: twin?.topic ?? 16,
      media: entries.get(w.id)!.m,
      order,
    };
  });
  const byId = new Map(words.map((w) => [w.id, w]));
  const pick = (ref: WordRef | Entry) => entries.get(ref.id)?.media;
  return {
    id: cat.id,
    name: cat.name,
    kind: "private",
    count: words.length,
    examples: [...entries.values()].reduce((n, e) => n + e.ex.length, 0),
    illustrated: words.filter((w) => w.media & MEDIA.img).length,
    topics: open?.topics ?? [["thinking", "综合"]],
    cefr: open?.cefr ?? ["A1", "A2", "B1", "B2", "C1", "C2"],
    words,
    byId,
    peek: (id) => entries.get(id),
    entry: async (id) => {
      const e = entries.get(id);
      if (!e) throw new Error(`没有找到词条 ${id}`);
      return e;
    },
    img: (ref) => pick(ref)?.img ?? null,
    audio: (ref, kind) => pick(ref)?.[kind] ?? null,
  };
}
