import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Atlas } from "./types";
import { requestEntry, type EntryResult } from "./entry-request";

export const AtlasContext = createContext<Atlas | null>(null);

export function useAtlas() {
  const a = useContext(AtlasContext);
  if (!a) throw new Error("Atlas not loaded");
  return a;
}

/** Full entry for an id; returns the cached copy synchronously when available. */
export function useEntry(id: string | null | undefined) {
  const atlas = useAtlas();
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<EntryResult & { atlas: Atlas; id: typeof id }>(() => ({
    atlas,
    id,
    entry: id ? atlas.peek(id) : undefined,
    error: null,
  }));
  useEffect(() => requestEntry(atlas, id, (next) => setResult({ atlas, id, ...next })), [atlas, id, attempt]);
  const retry = useCallback(() => {
    setResult({ atlas, id, error: null });
    setAttempt((n) => n + 1);
  }, [atlas, id]);
  const current = result.atlas === atlas && result.id === id ? result : undefined;
  return { entry: current?.entry, error: current?.error ?? null, retry };
}

/** Warm the chunks for a list of ids (e.g. a learning session). */
export function prefetch(atlas: Atlas, ids: string[]) {
  return Promise.all(ids.map((id) => atlas.entry(id).catch(() => null)));
}
