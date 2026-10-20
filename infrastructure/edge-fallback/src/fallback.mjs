// Edge fallback for khe.ee and games.khe.ee (estate ADR-016). The homelab
// answers first; the static copy in env.ASSETS answers only when the origin
// fails with a 5xx, a timeout or a thrown fetch.
import { HEADER_SETS, PASS_THROUGH, locate } from "./rules.mjs";

const ORIGIN_TIMEOUT_MS = 5000;

export async function handle(request, env, { fetchOrigin = fetch, timeoutMs = ORIGIN_TIMEOUT_MS } = {}) {
  const site = env.SITE;
  const url = new URL(request.url);
  const originRequest = env.ORIGIN_URL ? retarget(request, url, env.ORIGIN_URL) : request;

  if ((request.method !== "GET" && request.method !== "HEAD") || PASS_THROUGH[site](url.pathname)) {
    return fetchOrigin(originRequest);
  }

  const origin = await tryOrigin(originRequest, fetchOrigin, timeoutMs);
  if (origin) return origin;
  return serveCopy(request, url, site, env.ASSETS);
}

// Dev only: the same request against a local origin, which wrangler dev
// points at a closed port so every request takes the fallback path.
function retarget(request, url, originUrl) {
  const target = new URL(url.pathname + url.search, originUrl);
  return new Request(target, request);
}

async function tryOrigin(request, fetchOrigin, timeoutMs) {
  // A timer cleared once the headers arrive, not AbortSignal.timeout: that
  // would also abort a body still streaming after timeoutMs.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchOrigin(request, { redirect: "manual", signal: controller.signal });
    if (response.status < 500) return response;
    await response.body?.cancel();
  } catch {
    // Unreachable, refused or timed out: all mean the copy answers.
  } finally {
    clearTimeout(timer);
  }
  return null;
}

async function serveCopy(request, url, site, assets) {
  // nginx's merge_slashes. Without it "//evil.com" would resolve as a
  // scheme-relative URL and the slash 301 would point off-site.
  const path = url.pathname.replace(/\/{2,}/g, "/");
  const location = locate(site, path);

  if (location.redirect) {
    const target = location.redirect + (location.keepQuery ? url.search : "");
    return finish(new Response(null, { status: 301, headers: { Location: target } }), location);
  }
  if (location.notFound) return finish(notFound(), location);

  // The asset, or null on a miss.
  const fetchAsset = async (assetPath) => {
    const response = await assets.fetch(
      new Request(url.origin + assetPath, { method: request.method, headers: request.headers }),
    );
    if (response.status !== 404) return response;
    await response.body?.cancel();
    return null;
  };

  if (location.file && !path.endsWith("/")) {
    const response = await fetchAsset(path);
    if (response) return finish(response, location);
  }
  if (location.dir) {
    const index = await fetchAsset(path.endsWith("/") ? `${path}index.html` : `${path}/index.html`);
    if (index && path.endsWith("/")) return finish(index, location);
    if (index) {
      // nginx's directory redirect, relative because of absolute_redirect off.
      await index.body?.cancel();
      return finish(new Response(null, { status: 301, headers: { Location: `${path}/${url.search}` } }), location);
    }
  }
  if (location.fallback) {
    const response = await fetchAsset(location.fallback);
    if (response) return finish(response, location);
  }
  return finish(notFound(), location);
}

function notFound() {
  return new Response("Not Found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function finish(response, location) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(HEADER_SETS[location.headers])) {
    out.headers.set(name, value);
  }
  if (location.cache) {
    const cache = typeof location.cache === "function" ? location.cache(out.status) : location.cache;
    if (cache) out.headers.set("Cache-Control", cache);
  }
  out.headers.set("X-KHE-Fallback", "1");
  return out;
}
