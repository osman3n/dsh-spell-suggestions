/**
 * Offline check of the built client bundle: loads client.js through a stub
 * module loader, runs apply() against a fake contextMenus service, then queries
 * the suggestion engine directly. This proves data, ranking and wiring without
 * a browser.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let source = readFileSync(join(ROOT, "client.js"), "utf8");

const NEEDLE = 'return { apply };';
if (!source.includes(NEEDLE)) throw new Error("cannot find factory return statement");
source = source.replace(NEEDLE, 'return { apply, __test: { suggestionsFor, dictionary, distance } };');

let captured = null;
const sandbox = {
  console,
  window: {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
    localStorage: {
      store: new Map(),
      getItem(key) {
        return this.store.has(key) ? this.store.get(key) : null;
      },
      setItem(key, value) {
        this.store.set(key, String(value));
      },
    },
    getSelection() {
      return null;
    },
  },
  document: {
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
  },
  Node: { TEXT_NODE: 3 },
  InputEvent: class {},
  navigator: { clipboard: { readText: async () => "" } },
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "client.js" });

if (!captured) throw new Error("module loader was not called");
if (captured.id !== "@osman3n/dsh-composer-spellcheck") throw new Error("unexpected module id " + captured.id);

let contributed = null;
const disposers = [];
const ctx = {
  get() {
    return undefined;
  },
  contextMenus: {
    register(def) {
      contributed = def;
      return () => disposers.push("menu");
    },
    notify() {},
    open() {},
    close() {},
  },
  effect(fn, label) {
    const dispose = fn();
    disposers.push(label);
    return dispose;
  },
};

const exports = captured.factory(() => ({}));
if (typeof exports.apply !== "function") throw new Error("apply is not exported");
exports.apply(ctx);

const problems = [];
const check = (label, condition, detail) => {
  if (!condition) problems.push(label + (detail ? ` — ${detail}` : ""));
};

check("contributions registered", contributed !== null);
check("target kind", contributed && contributed.target === "composer-spellcheck", contributed && contributed.target);
check("disposers registered", disposers.length === 2, String(disposers.length));
check("unknown token resolves to empty", Array.isArray(contributed.resolve({ token: 12345 })) && contributed.resolve({ token: 12345 }).length === 0);
check("resolve tolerates junk", Array.isArray(contributed.resolve(null)));

const { suggestionsFor, dictionary } = exports.__test;
check("dictionary loaded", dictionary.size > 25000, String(dictionary.size));

const cases = [
  ["recieve", "receive"],
  ["definately", "definitely"],
  ["seperate", "separate"],
  ["dont", "don't"],
  ["teh", "the"],
  ["implmentation", "implementation"],
  ["accomodate", "accommodate"],
  ["succesful", "successful"],
  ["performace", "performance"],
  ["untill", "until"],
  ["Recieve", "Receive"],
];

console.log("word            -> suggestions");
for (const [word, expected] of cases) {
  const started = process.hrtime.bigint();
  const list = suggestionsFor(word);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const hit = list.some((item) => item.toLowerCase() === expected.toLowerCase());
  console.log(`${word.padEnd(15)} -> ${list.join(", ")}   [${ms.toFixed(2)} ms]`);
  check(`suggestion for ${word}`, hit, "expected " + expected + ", got " + JSON.stringify(list));
}

for (const word of ["the", "github", "javascript", "typescript", "plugin", "kubernetes", "composer", "spellcheck", "don't", "config", "implementation", "configuration", "receive"]) {
  check(`known word ${word}`, dictionary.has(word), "not in dictionary");
}

const slow = [];
for (const word of ["implementatoin", "configuratoin", "unnecesarily", "internatonal", "widht", "recieving"]) {
  const started = process.hrtime.bigint();
  const list = suggestionsFor(word);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  slow.push(`${word}:${ms.toFixed(1)}ms(${list.length})`);
  check(`suggestions for ${word}`, list.length > 0, "none");
}
console.log("timing: " + slow.join("  "));

if (problems.length) {
  console.error("\nFAILED");
  for (const problem of problems) console.error(" - " + problem);
  process.exit(1);
}
console.log("\nall checks passed");
