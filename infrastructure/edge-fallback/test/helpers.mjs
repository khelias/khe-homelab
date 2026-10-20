import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handle } from "../src/fallback.mjs";

// The tests serve exactly what scripts/edge-fallback-stage.sh stages from
// test/fixtures/, so its layout and config.js stub are tested too.
const TMP = mkdtempSync(join(tmpdir(), "edge-fallback-"));
const STAGE = join(TMP, "stage");
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
execFileSync("bash", [join(import.meta.dirname, "../../../scripts/edge-fallback-stage.sh"), "--fixtures", STAGE], {
  stdio: "ignore",
});

// env.ASSETS as Workers static assets behave with html_handling "none" and
// not_found_handling "none": an exact file or a 404.
export function fakeAssets(site) {
  const root = join(STAGE, site);
  return {
    async fetch(request) {
      const file = join(root, decodeURIComponent(new URL(request.url).pathname));
      if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
        return new Response("asset not found", { status: 404 });
      }
      const body = request.method === "HEAD" ? null : readFileSync(file);
      return new Response(body, { headers: { "Content-Type": file.endsWith(".html") ? "text/html" : "text/javascript" } });
    },
  };
}

export const origins = {
  status: (status, headers = {}) => async () => new Response(`origin ${status}`, { status, headers }),
  throws: () => async () => {
    throw new TypeError("fetch failed");
  },
  hangs: () => (request, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
};

const HOSTS = { khe: "https://khe.ee", games: "https://games.khe.ee" };

// Requests `path` on `site` with the origin stubbed; records what reached it.
export async function request(site, path, { origin = origins.status(530), method = "GET", timeoutMs = 50 } = {}) {
  const seen = [];
  const fetchOrigin = (req, init) => {
    seen.push({ request: req, init });
    return origin(req, init);
  };
  const response = await handle(
    new Request(HOSTS[site] + path, { method }),
    { SITE: site, ASSETS: fakeAssets(site) },
    { fetchOrigin, timeoutMs },
  );
  return { response, seen, body: method === "HEAD" ? "" : await response.text() };
}
