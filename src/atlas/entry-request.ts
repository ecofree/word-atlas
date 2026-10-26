import type { Atlas, Entry } from "./types";

export interface EntryResult {
  entry?: Entry;
  error: string | null;
}

/** A single view's request. Disposing it prevents an older result replacing a newer word. */
export function requestEntry(atlas: Pick<Atlas, "peek" | "entry">, id: string | null | undefined, receive: (result: EntryResult) => void) {
  let live = true;
  const dispose = () => {
    live = false;
  };
  const hit = id ? atlas.peek(id) : undefined;
  receive({ entry: hit, error: null });
  if (!id || hit) return dispose;

  Promise.resolve()
    .then(() => atlas.entry(id))
    .then(
      (entry) => live && receive({ entry, error: null }),
      (error: unknown) => live && receive({ error: error instanceof Error ? error.message : "词条加载失败，请重试。" }),
    );
  return dispose;
}
