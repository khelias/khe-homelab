// The copy's headers must match what nginx sends (estate ADR-016): a change
// in either nginx.conf or the header files they include without the same
// change in src/rules.mjs fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CSP_KHE_HA, HEADER_SETS, LANG_PAGES } from "../src/rules.mjs";

const APPS = join(import.meta.dirname, "../../../services/apps");

// A stack's nginx.conf with each include replaced by the file its compose
// file mounts at that path, so a header set kept in an include file is read.
function confText(conf) {
  const compose = readFileSync(join(APPS, conf, "docker-compose.yml"), "utf8");
  const mounts = Object.fromEntries(
    [...compose.matchAll(/^\s+- \.\/(\S+):(\/etc\/nginx\/\S+):ro$/gm)].map((m) => [m[2], m[1]]),
  );
  return readFileSync(join(APPS, conf, "nginx.conf"), "utf8").replace(/^(\s*)include (\S+);$/gm, (_, indent, path) => {
    assert.ok(mounts[path], `${conf}: ${path} is not mounted`);
    return readFileSync(join(APPS, conf, mounts[path]), "utf8").replace(/^(?=.)/gm, indent);
  });
}

// The add_header list of one block: from its opening line to the next
// location, which is where nginx stops inheriting into it.
function blockHeaders(conf, opening) {
  const text = confText(conf);
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

// Every other location with its own headers sends its set's security
// headers; its Cache-Control is its own.
const NESTED = [
  ["landing", "location ~ ^/r/[a-z0-9]+/assets/ {", "share"],
  ["landing", "location ^~ /trips/assets/ {", "trips"],
  ["landing", "location ^~ /stories/assets/ {", "stories"],
  ["landing", "location ^~ /stories/audio/ {", "stories"],
  ["landing", "location ~* \\.(css|js|woff2?|ttf|eot|png|jpg|jpeg|gif|ico|svg|webp)$ {", "khe"],
  ["games", "location /study/ {", "games"],
  ["games", "location = /study/sw.js {", "games"],
  ["games", "location = /study/manifest.webmanifest {", "games"],
  ["games", "location /study/assets/ {", "games"],
  ["games", "location /adventure/api/ {", "games"],
];
const security = (headers) => Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "Cache-Control"));

for (const [conf, opening, set] of NESTED) {
  test(`${conf} "${opening}" sends the ${set} security headers`, () => {
    assert.deepEqual(security(blockHeaders(conf, opening)), security(HEADER_SETS[set]));
  });
}

for (const [conf, opening, set] of BLOCKS) {
  test(`${conf} "${opening}" sends the ${set} headers`, () => {
    assert.deepEqual(blockHeaders(conf, opening), HEADER_SETS[set]);
  });
}

test("landing's /ha/ CSP is CSP_KHE_HA", () => {
  const text = readFileSync(join(APPS, "landing", "nginx.conf"), "utf8");
  assert.equal(text.match(/map \$uri \$csp_khe \{[^}]*~\^\/ha\/ "([^"]*)";/)?.[1], CSP_KHE_HA);
});

// A location with an add_header of its own drops the server's, so each one
// includes its header set again; landing's /healthz alone sends none.
for (const conf of ["games", "landing", "trips"]) {
  test(`every ${conf} location with its own add_header includes a header set`, () => {
    const text = readFileSync(join(APPS, conf, "nginx.conf"), "utf8");
    const blocks = text.split(/\n\s*location /).slice(1).filter((block) => /^\s*add_header /m.test(block.split("\n}")[0]));
    assert.ok(blocks.length > 0);
    for (const block of blocks) {
      if (block.startsWith("= /healthz ")) continue;
      assert.match(block, /^\s*include \/etc\/nginx\/\S*headers\.conf;/m, block.split("\n")[0]);
    }
    assert.doesNotMatch(text, /^\s*add_header (?!Cache-Control)/m);
  });
}

// landing's $lang_page map and LANG_PAGES name the same pairs (khe-sites ADR-001).
test("landing's $lang_page map is LANG_PAGES", () => {
  const text = readFileSync(join(APPS, "landing", "nginx.conf"), "utf8");
  const map = text.slice(text.indexOf('map "$uri:$lang_arg" $lang_page {'), text.indexOf("\n}\n", text.indexOf("$lang_page {")));
  const pairs = Object.fromEntries([...map.matchAll(/^\s+"([^"]+)" (\S+);$/gm)].map((m) => [m[1], m[2]]));
  assert.deepEqual(pairs, LANG_PAGES);
});
