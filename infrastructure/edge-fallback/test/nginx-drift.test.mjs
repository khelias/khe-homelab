// The copy's headers must match what nginx sends (estate ADR-016): a change
// in either nginx.conf without the same change in src/rules.mjs fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CSP_KHE_HA, HEADER_SETS, LANG_PAGES } from "../src/rules.mjs";

const APPS = join(import.meta.dirname, "../../../services/apps");

// The add_header list of one block: from its opening line to the next
// location, which is where nginx stops inheriting into it.
function blockHeaders(conf, opening) {
  const text = readFileSync(join(APPS, conf, "nginx.conf"), "utf8");
  const start = text.indexOf(opening);
  assert.notEqual(start, -1, `${opening} not in ${conf}/nginx.conf`);
  const rest = text.slice(start + opening.length);
  const block = rest.slice(0, rest.search(/\n\s*location /));
  const cspMap = text.slice(text.indexOf("map $uri $csp_khe {"));
  const csp = cspMap.match(/default "([^"]*)";/)?.[1];
  return Object.fromEntries(
    [...block.matchAll(/add_header (\S+) (?:"([^"]*)"|(\$csp_khe)) always;/g)].map((m) => [m[1], m[3] ? csp : m[2]]),
  );
}

const BLOCKS = [
  ["landing", "server {", "khe"],
  ["landing", "location ^~ /r/ {", "share"],
  ["landing", "location ^~ /trips/ {", "trips"],
  ["landing", "location ^~ /stories/ {", "stories"],
  ["landing", "location = /stories/manifest.webmanifest {", "stories"],
  ["games", "server {", "games"],
];

for (const [conf, opening, set] of BLOCKS) {
  test(`${conf} "${opening}" sends the ${set} headers`, () => {
    assert.deepEqual(blockHeaders(conf, opening), HEADER_SETS[set]);
  });
}

test("landing's /ha/ CSP is CSP_KHE_HA", () => {
  const text = readFileSync(join(APPS, "landing", "nginx.conf"), "utf8");
  assert.equal(text.match(/map \$uri \$csp_khe \{[^}]*~\^\/ha\/ "([^"]*)";/)?.[1], CSP_KHE_HA);
});

// A location with an add_header of its own repeats the server's security
// headers, so every copy in the games nginx has to say the same.
test("every games location repeats the same security headers", () => {
  const text = readFileSync(join(APPS, "games", "nginx.conf"), "utf8");
  for (const [name, value] of Object.entries(HEADER_SETS.games)) {
    const sent = [...text.matchAll(new RegExp(`add_header ${name} "([^"]*)" always;`, "g"))].map((m) => m[1]);
    assert.ok(sent.length > 1, name);
    assert.deepEqual([...new Set(sent)], [value], name);
  }
});

// landing's $lang_page map and LANG_PAGES name the same pairs (khe-sites ADR-001).
test("landing's $lang_page map is LANG_PAGES", () => {
  const text = readFileSync(join(APPS, "landing", "nginx.conf"), "utf8");
  const map = text.slice(text.indexOf('map "$uri:$lang_arg" $lang_page {'), text.indexOf("\n}\n", text.indexOf("$lang_page {")));
  const pairs = Object.fromEntries([...map.matchAll(/^\s+"([^"]+)" (\S+);$/gm)].map((m) => [m[1], m[2]]));
  assert.deepEqual(pairs, LANG_PAGES);
});
