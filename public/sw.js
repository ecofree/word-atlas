/* The production build injects a content-verified shell. Raw public/ is not an installable release. */
const RELEASE = /* __ATLAS_OFFLINE_RELEASE__ */ null;
const SCOPE = new URL(self.registration.scope);
const PREFIX = `word-atlas:${encodeURIComponent(SCOPE.href)}:`;
const VERSION = RELEASE?.version ?? "unbuilt";
const SHELL = `${PREFIX}${VERSION}:shell`;
const DATA = `${PREFIX}${VERSION}:data`;
const MEDIA = `${PREFIX}${VERSION}:media`;
const CURRENT = new Set([SHELL, DATA, MEDIA]);
const FILES = new Map((RELEASE?.files ?? []).map((file) => [new URL(file.path, SCOPE).href, file.integrity]));
const downloads = new Map();

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    if (!RELEASE || RELEASE.format !== 1 || !FILES.size) throw new Error("Build Word Atlas before installing its offline worker");
    const cache = await caches.open(SHELL);
    try {
      await cache.addAll([...FILES].map(([url, integrity]) => new Request(url, { cache: "reload", integrity })));
    } catch (error) {
      await caches.delete(SHELL);
      throw error;
    }
    // Keep the browser's normal waiting lifecycle. Never replace a worker beneath an active lesson.
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(PREFIX) &&
      /^[a-f0-9]{64}:(?:shell|data|media)$/.test(name.slice(PREFIX.length)) && !CURRENT.has(name)).map((name) => caches.delete(name)));
    // Legacy atlas-v1 caches have no scope: leave them alone, and never read them.
    await self.clients.claim();
  })());
});

function relativePath(value) {
  try {
    const url = new URL(value, SCOPE);
    if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname) || url.search || url.hash) return null;
    return url.pathname.slice(SCOPE.pathname.length);
  } catch { return null; }
}

function resourceKind(value) {
  const relative = relativePath(value);
  if (!relative) return null;
  if (/^atlas\/entries\/\d+\.[a-f0-9]{64}\.json$/.test(relative)) return "data";
  if (/^atlas\/(?:img|thumb)\/[a-z0-9-]+\.webp$/.test(relative)) return "media";
  if (/^atlas\/audio\/(?:uk|us|ex|ex2)\/[a-z0-9-]+\.mp3$/.test(relative) || /^sfx\/[a-z0-9-]+\.mp3$/.test(relative)) return "audio";
  return null;
}

function chunkIntegrity(url) {
  const hex = /\.([a-f0-9]{64})\.json$/.exec(url)?.[1];
  return hex ? `sha256-${btoa(String.fromCharCode(...hex.match(/../g).map((pair) => parseInt(pair, 16))))}` : "";
}

async function trimMedia() {
  const cache = await caches.open(MEDIA);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - 1500)).map((key) => cache.delete(key)));
}

/** Store only a complete 200 response under a Range-free key. */
async function completeResponse(url, name, integrity = "", refresh = false) {
  let cache;
  let hit;
  try {
    cache = await caches.open(name);
    hit = await cache.match(url);
    if (hit?.status !== 200 || hit.headers.has("Content-Range")) hit = undefined;
    if (hit && !refresh) return hit;
  } catch { cache = undefined; }
  const key = `${name}\n${url}\n${refresh}`;
  let download = downloads.get(key);
  if (!download) {
    download = (async () => {
      let response;
      try { response = await fetch(new Request(url, { cache: "reload", integrity })); }
      catch (error) { if (refresh && hit) return hit; throw error; }
      if (refresh && hit && (response.status !== 200 || response.headers.has("Content-Range"))) return hit;
      if (cache && response.status === 200 && response.type !== "opaque" && !response.headers.has("Content-Range")) {
        // Cache quota or eviction failures must not turn a successful online read into an error.
        await cache.put(url, response.clone()).then(() => name === MEDIA && trimMedia()).catch(() => undefined);
      }
      return response;
    })();
    downloads.set(key, download);
    void download.finally(() => downloads.delete(key)).catch(() => undefined);
  }
  return (await download).clone();
}

/** null means ignore an unsupported/invalid Range; false means an unsatisfiable byte range. */
function byteRange(header, length) {
  if (!header || !/^bytes=/i.test(header)) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const total = BigInt(length);
  if (!total) return false;
  if (!match[1]) {
    const suffix = BigInt(match[2]);
    if (!suffix) return false;
    return [Number(suffix >= total ? 0n : total - suffix), length - 1];
  }
  const start = BigInt(match[1]);
  const end = match[2] ? BigInt(match[2]) : total - 1n;
  if (start > end || start >= total) return false;
  return [Number(start), Number(end < total ? end : total - 1n)];
}

async function rangedResponse(request, complete) {
  if (!request.headers.has("Range") || complete.status !== 200) return complete;
  // Fetch decodes encoded bodies; their original byte offsets cannot safely be reconstructed.
  const encoding = complete.headers.get("Content-Encoding");
  if (encoding && encoding.toLowerCase() !== "identity") return complete;
  const validator = request.headers.get("If-Range");
  if (validator && (validator.startsWith("W/") ||
    (validator !== complete.headers.get("ETag") && validator !== complete.headers.get("Last-Modified")))) return complete;
  const body = await complete.clone().arrayBuffer();
  const range = byteRange(request.headers.get("Range"), body.byteLength);
  if (range === null) return complete;
  const headers = new Headers(complete.headers);
  headers.delete("Content-Encoding");
  headers.delete("Transfer-Encoding");
  headers.set("Accept-Ranges", "bytes");
  if (range === false) {
    headers.set("Content-Range", `bytes */${body.byteLength}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, statusText: "Range Not Satisfiable", headers });
  }
  const [start, end] = range;
  headers.set("Content-Range", `bytes ${start}-${end}/${body.byteLength}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, statusText: "Partial Content", headers });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  // A campaign/query string changes neither the hash-router entry point nor its offline shell.
  const navigation = new URL(request.url);
  if (request.mode === "navigate" && navigation.origin === SCOPE.origin &&
      (navigation.pathname === SCOPE.pathname || navigation.pathname === `${SCOPE.pathname}index.html`)) {
    const index = new URL("index.html", SCOPE).href;
    event.respondWith(completeResponse(index, SHELL, FILES.get(index)));
    return;
  }
  const relative = relativePath(request.url);
  if (relative === null) return;
  if (FILES.has(request.url)) {
    event.respondWith(completeResponse(request.url, SHELL, FILES.get(request.url)));
    return;
  }
  const kind = resourceKind(request.url);
  if (!kind) return;
  event.respondWith((async () => {
    const response = await completeResponse(request.url, kind === "data" ? DATA : MEDIA, kind === "data" ? chunkIntegrity(request.url) : "", request.cache === "reload");
    // A broken origin may return 206 even without a Range. Never slice or cache that partial body.
    if (kind === "audio" && request.headers.has("Range")) return response.status === 206 ? fetch(request) : rangedResponse(request, response);
    return response;
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_VISITED" || !Array.isArray(event.data.urls) || event.data.urls.length > 64) return;
  const source = event.source?.url;
  if (!source || new URL(source).origin !== SCOPE.origin || !new URL(source).pathname.startsWith(SCOPE.pathname)) return;
  const urls = [...new Set(event.data.urls)].filter((url) => typeof url === "string" && resourceKind(url));
  event.waitUntil((async () => {
    const cached = [];
    await Promise.all(urls.map(async (url) => {
      try {
        const kind = resourceKind(url);
        const name = kind === "data" ? DATA : MEDIA;
        await completeResponse(url, name, kind === "data" ? chunkIntegrity(url) : "");
        if ((await (await caches.open(name)).match(url))?.status === 200) cached.push(url);
      } catch { /* A later online event may retry a first-visit download. */ }
    }));
    event.ports[0]?.postMessage({ cached });
  })());
});
