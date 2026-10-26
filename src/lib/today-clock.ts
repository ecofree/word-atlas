import { useEffect, useState } from "react";
import type { Progress } from "../store/store";

/** Wake at the next due card, calendar boundary, or minute (also catches clock changes). */
export function nextTodayRefresh(cards: Progress["cards"], now: number) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  let next = Math.min(midnight.getTime(), (Math.floor(now / 60_000) + 1) * 60_000);
  for (const card of Object.values(cards)) if (card.due > now) next = Math.min(next, card.due);
  return next;
}

/** One timestamp drives the plan, date, streak, daily word and today's highlights. */
export function useTodayNow(cards: Progress["cards"]) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      const current = Date.now();
      setNow(current);
      timer = setTimeout(refresh, Math.max(1, nextTodayRefresh(cards, current) - current));
    };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [cards]);
  return now;
}
