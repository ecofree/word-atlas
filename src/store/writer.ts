/** One progress writer per dataset. Browsing remains available in other windows. */
export type WriteAccess = "loading" | "writable" | "readonly" | "unavailable" | "conflict";

export class DatasetWriter {
  private generation = 0;
  private owned = false;
  private release: (() => void) | undefined;
  private request: AbortController | undefined;

  constructor(private readonly changed: (access: WriteAccess) => void) {}

  canWrite() {
    return this.owned;
  }

  stop() {
    this.generation++;
    this.owned = false;
    this.request?.abort();
    this.request = undefined;
    this.release?.();
    this.release = undefined;
  }

  start(datasetId: string) {
    this.stop();
    const generation = this.generation;
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) {
      // An expiring localStorage/IDB lease cannot fence a suspended tab's later
      // synchronous localStorage write. Fail closed instead of risking progress.
      this.changed("unavailable");
      return;
    }
    this.request = new AbortController();
    this.changed("readonly");
    // Queue until the visible owner releases its lock. ifAvailable would leave
    // the next tab stranded read-only if it requested just before that release.
    void locks.request(`word-atlas:writer:${datasetId}`, { mode: "exclusive", signal: this.request.signal }, async () => {
      if (generation !== this.generation) return;
      this.owned = true;
      const held = new Promise<void>((resolve) => { this.release = resolve; });
      this.changed("writable");
      await held;
    }).catch(() => {
      if (generation === this.generation) {
        this.owned = false;
        this.changed("unavailable");
      }
    });
  }
}
