// The copy's headers must match what nginx sends (estate ADR-016): a change
// in either nginx.conf without the same change in src/rules.mjs fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HEADER_SETS } from "../src/rules.mjs";

const APPS = join(import.meta.dirname, "../../../services/apps");

// The add_header list of one block: from its opening line to the next
// location, which is where nginx stops inheriting into it.
function blockHeaders(conf, opening) {
  const text = readFileSync(join(APPS, conf, "nginx.conf"), "utf8");
  const start = text.indexOf(opening);
  assert.notEqual(start, -1, `${opening} not in ${conf}/nginx.conf`);
  const rest = text.slice(start + opening.length);
  const block = rest.slice(0, rest.search(/\n\s*location /));
  return Object.fromEntries([...block.matchAll(/add_header (\S+) "([^"]*)" always;/g)].map((m) => [m[1], m[2]]));
}

const BLOCKS = [
  ["landing", "server {", "khe"],
  ["landing", "location ^~ /r/ {", "share"],
  ["landing", "location ^~ /trips/ {", "trips"],
  ["games", "server {", "games"],
];

for (const [conf, opening, set] of BLOCKS) {
  test(`${conf} "${opening}" sends the ${set} headers`, () => {
    assert.deepEqual(blockHeaders(conf, opening), HEADER_SETS[set]);
  });
}
