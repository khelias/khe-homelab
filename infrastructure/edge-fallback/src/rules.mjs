// What the landing and games nginx serve, restated for the fallback copy
// (estate ADR-016). A header, redirect or SPA-fallback change in
// services/apps/landing/nginx.conf, services/apps/games/nginx.conf or
// khe-ai-adventure's web/nginx.conf is mirrored here in the same commit;
// test/nginx-drift.test.mjs compares the header values.

const PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()";
const NOINDEX = "noindex, nofollow, noarchive";
const REFERRER = "strict-origin-when-cross-origin";
const HSTS_KHE = "max-age=31536000";

export const CSP_KHE =
  "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; upgrade-insecure-requests";
export const CSP_GAMES =
  "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: https:; font-src 'self' data: https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; connect-src 'self' https://cloudflareinsights.com; upgrade-insecure-requests";

// One set per nginx block that has its own add_header list.
export const HEADER_SETS = {
  khe: {
    "Strict-Transport-Security": HSTS_KHE,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": REFERRER,
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Content-Security-Policy": CSP_KHE,
  },
  // /r/ has no HSTS and no Permissions-Policy, as in nginx.
  share: {
    "Cache-Control": "private, no-cache",
    "X-Robots-Tag": NOINDEX,
    "Referrer-Policy": REFERRER,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "frame-ancestors 'none'",
  },
  trips: {
    "Strict-Transport-Security": HSTS_KHE,
    "Cache-Control": "private, no-cache",
    "X-Robots-Tag": NOINDEX,
    "Referrer-Policy": REFERRER,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "frame-ancestors 'none'",
  },
  games: {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": REFERRER,
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Content-Security-Policy": CSP_GAMES,
  },
};

// landing's $share_asset_cache map.
export function shareAssetCache(status) {
  return status === 200 || status === 206 || status === 304
    ? "private, max-age=604800, immutable"
    : "private, no-cache";
}

// nginx's expires applies only to a success, and landing's asset
// Cache-Control has no "always"; on a miss the copy sends ifMissed.
function onSuccess(value, ifMissed) {
  return (status) => (status === 200 || status === 206 || status === 304 ? value : ifMissed);
}

// Requests the copy never answers: the origin's reply, failure included,
// reaches the client (estate ADR-016 point 5).
export const PASS_THROUGH = {
  khe: (path) => path === "/healthz",
  games: (path) => path.startsWith("/adventure/api/"),
};

const LANDING_ASSET = /\.(css|js|woff2?|ttf|eot|png|jpg|jpeg|gif|ico|svg|webp)$/i;

// A location says how nginx answers a path:
//   redirect   301 to this target
//   notFound   404 without looking up a file
//   file       try the path as a file
//   dir        try path/index.html, with nginx's slash 301 for a bare path
//   fallback   the file served when both miss; none means 404
//   headers    the HEADER_SETS entry, the site's own when unset
//   cache      Cache-Control to set, a string or a function of the status
// keepQuery appends the request's query to a redirect, as nginx's
// $is_args$args and rewrite do. A location is an object, or a function of
// the path where the answer depends on it.
const kheLocations = [
  [(p) => p === "/reports" || p.startsWith("/reports/"), { notFound: true }],
  [(p) => p === "/lab" || p.startsWith("/lab/"), { redirect: "/architecture/", keepQuery: true }],
  [(p) => p === "/house3d", { redirect: "/ha/", keepQuery: true }],
  [(p) => p.startsWith("/house3d/"), (p) => ({ redirect: `/ha/${p.slice("/house3d/".length)}`, keepQuery: true })],
  [(p) => p === "/architecture/decisions/", { redirect: "/architecture/#decisions" }],
  [(p) => p.startsWith("/architecture/decisions/"), { file: true, dir: true }],
  [(p) => p === "/r" || p === "/r/", { notFound: true }],
  [(p) => /^\/r\/[a-z0-9]+\/assets\//.test(p), { file: true, headers: "share", cache: shareAssetCache }],
  [(p) => p.startsWith("/r/"), { file: true, dir: true, headers: "share" }],
  [(p) => p === "/trips", { redirect: "/trips/", keepQuery: true }],
  [(p) => p.startsWith("/trips/assets/"), { file: true, headers: "trips", cache: shareAssetCache }],
  [(p) => p.startsWith("/trips/"), { file: true, dir: true, fallback: "/trips/index.html", headers: "trips" }],
  [(p) => LANDING_ASSET.test(p), { file: true, cache: onSuccess("public, max-age=2592000") }],
  [() => true, { file: true, dir: true, fallback: "/index.html" }],
];

// study/ and adventure/ are mounted beside the launcher root, not in it, so
// games' "/" location never finds them as files or directories.
const OUTSIDE_LAUNCHER = /^\/(study|adventure)(\/|$)/;

const gamesLocations = [
  [(p) => p === "/adventure/config.js", { file: true, cache: "no-store" }],
  [(p) => p.startsWith("/adventure/assets/"), { file: true, cache: "public, max-age=31536000, immutable" }],
  [(p) => p.startsWith("/adventure/"), { file: true, dir: true, fallback: "/adventure/index.html", cache: "no-cache, must-revalidate" }],
  [(p) => p.startsWith("/study/assets/"), { file: true, cache: onSuccess("public, max-age=31536000, immutable", "public, immutable") }],
  [(p) => p.startsWith("/study/"), { file: true, dir: true, fallback: "/study/index.html" }],
  [(p) => OUTSIDE_LAUNCHER.test(p), { fallback: "/index.html" }],
  [() => true, { file: true, dir: true, fallback: "/index.html" }],
];

const LOCATIONS = { khe: kheLocations, games: gamesLocations };

export function locate(site, path) {
  const locations = LOCATIONS[site];
  if (!locations) throw new Error(`unknown SITE ${site}`);
  for (const [matches, location] of locations) {
    if (!matches(path)) continue;
    const found = typeof location === "function" ? location(path) : location;
    return { headers: site, ...found };
  }
}
