/**
 * Build client.js from the template plus the word data.
 *
 *   node tools/prepare-words.mjs      # once, refreshes .tmp/words.json
 *   node tools/build-client.mjs       # every change
 *
 * The frequency list is embedded as one space-joined string; the curated typo
 * map and the technical allowlist are embedded as JSON.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relative) => readFileSync(join(ROOT, relative), "utf8");

const wordsPath = join(ROOT, ".tmp", "words.json");
if (!existsSync(wordsPath)) {
  console.error("missing .tmp/words.json — run `node tools/prepare-words.mjs` first");
  process.exit(1);
}

const corpus = JSON.parse(readFileSync(wordsPath, "utf8"));
const typos = JSON.parse(read("src/typos.json"));
const template = read("src/client.template.js");

const allowlist = read("src/allowlist.txt")
  .split(/\r?\n/)
  .map((line) => line.trim().toLowerCase())
  .filter((line) => line && !line.startsWith("#"));

const typoKeys = new Set(Object.keys(typos));
const corpusSet = new Set(corpus);

// A word the curated map already treats as a misspelling must not also count as
// known, otherwise the typo would never produce suggestions. The corpus itself
// carries informal spellings (dont, cant, youre, ...), so this filter matters.
const drop = [...typoKeys].filter((word) => corpusSet.has(word)).sort();

const known = new Set(corpus.filter((word) => !typoKeys.has(word)));
const dropSet = new Set(drop);
for (const word of dropSet) known.delete(word);

// Every curated correction must itself count as known — otherwise the word the
// user meant ("don't", "receive") would be flagged on the next right-click.
const corrections = Object.values(typos)
  .map((value) => value.toLowerCase())
  .filter((value) => /^[a-z][a-z']*[a-z]$/.test(value));

const extra = [];
const addExtra = (word) => {
  if (known.has(word) || typoKeys.has(word) || extra.includes(word)) return;
  extra.push(word);
};
for (const word of allowlist) addExtra(word);
for (const word of corrections) addExtra(word);

// Keep the corpus order: the index in this list is the frequency rank that
// breaks edit-distance ties at runtime.
const bundled = corpus.filter((word) => known.has(word));

const replacements = {
  __WORDS__: JSON.stringify(bundled.join(" ")),
  __EXTRA__: JSON.stringify(extra.join(" ")),
  __DROP__: JSON.stringify(drop.join(" ")),
  __TYPOS__: JSON.stringify(typos),
};

let output = template;
for (const [token, value] of Object.entries(replacements)) {
  if (!output.includes(token)) {
    console.error(`template is missing placeholder ${token}`);
    process.exit(1);
  }
  output = output.split(token).join(value);
}

const leftovers = output.match(/__[A-Z]+__/g);
if (leftovers) {
  console.error("unreplaced placeholders:", leftovers.join(", "));
  process.exit(1);
}

writeFileSync(join(ROOT, "client.js"), output);

console.log(
  JSON.stringify(
    {
      out: "client.js",
      bytes: output.length,
      knownWords: bundled.length,
      extraWords: extra.length,
      droppedAsTypos: drop.length,
      typoPairs: Object.keys(typos).length,
      droppedSample: drop.slice(0, 20),
      extraSample: extra.slice(0, 10),
    },
    null,
    2,
  ),
);
