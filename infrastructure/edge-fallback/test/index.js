// Node 24 runs `node --test test/` as a single entry point and resolves the
// directory to this file, so it loads every *.test.mjs beside it.
import { readdirSync } from "node:fs";

for (const file of readdirSync(import.meta.dirname).filter((f) => f.endsWith(".test.mjs")).sort()) {
  await import(`./${file}`);
}
