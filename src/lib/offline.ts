/** Only resources already used by this page may be copied into its scope's runtime cache. */
export function offlineResource(value: string, scope: string) {
  try {
    const base = new URL(scope), url = new URL(value, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash) return false;
    const relative = url.pathname.slice(base.pathname.length);
    return /^atlas\/entries\/\d+\.[a-f0-9]{64}\.json$/.test(relative) ||
      /^atlas\/(?:img|thumb)\/[a-z0-9-]+\.webp$/.test(relative) ||
      /^atlas\/audio\/(?:uk|us|ex|ex2)\/[a-z0-9-]+\.mp3$/.test(relative) ||
      /^sfx\/[a-z0-9-]+\.mp3$/.test(relative);
  } catch { return false; }
}

/** Register immediately; retain resources begun before the first controller, even if they finish late. */
export function registerOffline(base: string) {
  if (!("serviceWorker" in navigator)) return;
  const scope = new URL(base, location.href).href;
  const script = new URL("sw.js", scope).href;
  let controlledAt = navigator.serviceWorker.controller?.scriptURL === script ? 0 : Infinity;
  let registration: ServiceWorkerRegistration | undefined;
  let sending = false;
  const pending = new Set<string>(), retry = new Set<string>(), seen = new Set<string>();

  const flush = () => {
    const worker = registration?.active;
    if (sending || !worker || worker.state !== "activated" || !pending.size) return;
    const urls = [...pending].slice(0, 64);
    urls.forEach((url) => pending.delete(url));
    sending = true;
    const channel = new MessageChannel();
    let settled = false;
    const finish = (cached: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      for (const url of urls) if (!cached.includes(url)) retry.add(url);
      sending = false;
      flush();
    };
    const timer = window.setTimeout(() => finish([]), 5000);
    channel.port1.onmessage = (event: MessageEvent<{ cached?: string[] }>) => finish(Array.isArray(event.data?.cached) ? event.data.cached : []);
    try { worker.postMessage({ type: "CACHE_VISITED", urls }, [channel.port2]); }
    catch { finish([]); }
  };
  const collect = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      if (entry.startTime >= controlledAt || seen.size >= 500 || seen.has(entry.name) || !offlineResource(entry.name, scope)) continue;
      seen.add(entry.name); pending.add(entry.name);
    }
    flush();
  };
  const retryPending = () => {
    for (const url of retry) pending.add(url);
    retry.clear();
    collect(performance.getEntriesByType("resource"));
    flush();
  };
  const controlled = () => {
    if (navigator.serviceWorker.controller?.scriptURL !== script) return;
    if (controlledAt === Infinity) controlledAt = performance.now();
    retryPending();
  };
  let observer: PerformanceObserver | undefined;
  if (typeof PerformanceObserver !== "undefined") {
    try {
      observer = new PerformanceObserver((list) => collect(list.getEntries()));
      observer.observe({ type: "resource", buffered: true });
    } catch { observer?.disconnect(); }
  }
  navigator.serviceWorker.addEventListener("controllerchange", controlled);
  window.addEventListener("online", retryPending);
  window.addEventListener("load", retryPending, { once: true });
  void navigator.serviceWorker.register(script, { scope, updateViaCache: "none" }).then((result) => {
    registration = result;
    const watch = () => {
      const worker = result.installing ?? result.waiting ?? result.active;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "activated") retryPending();
      });
    };
    result.addEventListener("updatefound", watch);
    watch();
    retryPending();
  }).catch(() => {
    observer?.disconnect();
    navigator.serviceWorker.removeEventListener("controllerchange", controlled);
    window.removeEventListener("online", retryPending);
  });
}
