import { shuffle } from "./text";
import { clean, typingDelta } from "./typing";

export function samplePracticeIds(pool: string[], seed: number, count = 10) {
  return shuffle([...new Set(pool)], seed).slice(0, Math.max(0, count));
}

/** Follow an explicitly accepted spelling as the learner types it. */
export function practiceTarget(forms: string[], value: string) {
  const typed = Array.from(clean(value).trimStart().toLowerCase());
  let target = forms[0] ?? "";
  let best = -1;
  for (const form of forms) {
    const letters = Array.from(clean(form).toLowerCase());
    let prefix = 0;
    while (prefix < typed.length && prefix < letters.length && typed[prefix] === letters[prefix]) prefix++;
    if (prefix > best) { best = prefix; target = form; }
  }
  return target;
}

export interface TypingTotals {
  typed: number;
  correct: number;
  accepted: number;
  ms: number;
}

/** Synchronous item ownership prevents repeated input during the transition delay. */
export class TypingRun {
  private index = 0;
  private value = "";
  private phase: "typing" | "transition" | "saving" | "done" = "typing";
  private active = false;
  private started = false;
  private activeSince: number | null = null;
  private itemMs = 0;
  private totals: TypingTotals = { typed: 0, correct: 0, accepted: 0, ms: 0 };

  constructor(private readonly count: number) {
    if (!Number.isInteger(count) || count < 1) throw new Error("A typing round needs at least one item.");
  }

  snapshot() {
    return { index: this.index, value: this.value, phase: this.phase, active: this.active, totals: this.totals };
  }

  setActive(active: boolean, now: number) {
    if (active === this.active) return;
    if (this.activeSince !== null) {
      this.itemMs += Math.max(0, now - this.activeSince);
      this.activeSince = null;
    }
    this.active = active;
    if (active && this.started && this.phase === "typing") this.activeSince = now;
  }

  change(next: string, target: string, complete: boolean, now: number) {
    if (!this.active || this.phase !== "typing") return null;
    if (!this.started && next) { this.started = true; this.activeSince = now; }
    const delta = typingDelta(this.value, next, target);
    this.value = next;
    this.totals = { ...this.totals, typed: this.totals.typed + delta.total, correct: this.totals.correct + delta.correct };
    if (complete) {
      if (this.activeSince !== null) this.itemMs += Math.max(0, now - this.activeSince);
      this.activeSince = null;
      this.totals = { ...this.totals, accepted: this.totals.accepted + Array.from(clean(target)).length, ms: this.totals.ms + this.itemMs };
      this.phase = this.index + 1 === this.count ? "saving" : "transition";
    }
    return { inserted: delta.total, completed: complete };
  }

  advance() {
    if (!this.active || this.phase !== "transition") return false;
    this.index++;
    this.value = "";
    this.phase = "typing";
    this.started = false;
    this.activeSince = null;
    this.itemMs = 0;
    return true;
  }

  saved() {
    if (this.phase !== "saving") return false;
    this.phase = "done";
    return true;
  }
}
