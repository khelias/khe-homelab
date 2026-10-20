// The deployed envs must not reach a dev origin, deploy routes over the
// dashboard's fail-open ones, or open a workers.dev or preview side door.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// JSONC to JSON: strings are kept, // and /* */ comments dropped.
function parseJsonc(text) {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : "")));
}

const config = parseJsonc(readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8"));
const PRODUCTION = { khe: "khe-fallback-khe-ee", games: "khe-fallback-games" };

test("the top level has no routes and no side doors", () => {
  assert.equal(config.routes, undefined);
  assert.equal(config.route, undefined);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});

for (const [env, name] of Object.entries(PRODUCTION)) {
  test(`env ${env} deploys ${name} with no dev origin or routes`, () => {
    const e = config.env[env];
    assert.equal(e.name, name);
    assert.equal(e.vars.SITE, env);
    assert.equal(e.vars.ORIGIN_URL, undefined);
    assert.equal(e.routes, undefined);
    assert.equal(e.route, undefined);
  });

  test(`env ${env} runs the Worker before its assets`, () => {
    const a = config.env[env].assets;
    assert.equal(a.binding, "ASSETS");
    assert.equal(a.directory, `.stage/${env}/`);
    assert.equal(a.run_worker_first, true);
    assert.equal(a.html_handling, "none");
    assert.equal(a.not_found_handling, "none");
  });
}

test("every env keeps workers.dev and previews off", () => {
  for (const [name, e] of Object.entries(config.env)) {
    assert.equal(e.workers_dev, false, name);
    assert.equal(e.preview_urls, false, name);
  }
});
