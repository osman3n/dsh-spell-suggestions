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
source = source.replace(
  NEEDLE,
  "return { apply, __test: { suggestionsFor, dictionary, distance, fitMenuToViewport, menuRowContainer } };",
);

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
    addEventListener() {},
    removeEventListener() {},
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
if (captured.id !== "@osman3n/dsh-spell-suggestions") throw new Error("unexpected module id " + captured.id);

let contributed = null;
const disposers = [];
const contextMenus = {
  register(def) {
    contributed = def;
    return () => disposers.push("menu");
  },
  notify() {},
  open() {},
  close() {},
};
const ctx = {
  // cordis: ctx.get(name) reads a service without the inject requirement, and
  // reading ctx.<service> for anything not injected throws. The plugin must
  // only ever go through get().
  get(name) {
    return name === "contextMenus" ? contextMenus : undefined;
  },
  effect(fn, label) {
    const dispose = fn();
    disposers.push(label);
    return dispose;
  },
};

const exports = captured.factory(() => ({}));
if (typeof exports.apply !== "function") throw new Error("apply is not exported");

// Regression: when the sibling context-menu plugin has not provided its
// service yet, apply() must still activate. It used to read ctx.contextMenus
// directly and throw, which failed the whole client entry at boot:
// "web boot: 1 entry did not activate".
const quiet = [];
exports.apply({
  get() {
    return undefined;
  },
  effect(fn, label) {
    quiet.push(label);
    fn();
    return () => {};
  },
});
if (contributed !== null) throw new Error("contributed a menu without a menu service");
if (quiet.length !== 2) throw new Error("unexpected effects without a menu service: " + quiet.join(","));

exports.apply(ctx);

const problems = [];
const check = (label, condition, detail) => {
  if (!condition) problems.push(label + (detail ? ` — ${detail}` : ""));
};

check("contributions registered", contributed !== null);
check("target kind", contributed && contributed.target === "spell-suggestions", contributed && contributed.target);
check("disposers registered", disposers.length === 3, String(disposers.length));check("unknown token resolves to empty", Array.isArray(contributed.resolve({ token: 12345 })) && contributed.resolve({ token: 12345 }).length === 0);
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

// Regression for the in-plugin fallback that keeps a tall menu reachable. The
// shared menu already clamps and scrolls itself, so the fitter must be a no-op
// in that case and only step in when the measured box leaves the viewport or
// its rows overflow a container that cannot scroll.
const { fitMenuToViewport } = exports.__test;

function fakeMenu({ top = 100, height = 600, width = 200, right = 400, rows = 12, clientHeight = 600, scrollHeight = 600, overflowY = "visible" } = {}) {
  const items = Array.from({ length: rows }, () => ({}));
  const ownerDocument = {
    defaultView: {
      innerHeight: 300,
      innerWidth: 800,
      getComputedStyle: (element) => ({ overflowY: element.__overflowY || "visible" }),
    },
    documentElement: {},
  };
  const rowElement = {
    ownerDocument,
    __overflowY: overflowY,
    clientHeight,
    scrollHeight,
    style: {},
    querySelectorAll: () => items,
  };
  const menu = {
    ownerDocument,
    style: {},
    children: [rowElement],
    querySelectorAll: () => items,
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: () => ({ top, bottom: top + height, height, width, right, left: right - width }),
  };
  return { menu, rowElement };
}

const alreadyFine = fakeMenu({ top: 20, height: 200, clientHeight: 200, scrollHeight: 200 });
check("fit leaves a menu that already fits untouched", fitMenuToViewport(alreadyFine.menu) === false);
check("fit did not restyle a menu that fits", !alreadyFine.menu.style.maxHeight && !alreadyFine.rowElement.style.overflowY);

const hostScrolls = fakeMenu({ top: 20, height: 200, clientHeight: 200, scrollHeight: 420, overflowY: "auto" });
check("fit trusts a container the host already made scrollable", fitMenuToViewport(hostScrolls.menu) === false);
check("fit did not touch the host scroll container", !hostScrolls.rowElement.style.overflowY);

const spills = fakeMenu({ top: 100, height: 600 });
check("fit clamps a menu that spills past the viewport", fitMenuToViewport(spills.menu) === true);
check("fit capped the spilled menu", /^\d+px$/.test(spills.menu.style.maxHeight || ""), spills.menu.style.maxHeight);
check("fit made the spilled rows scroll", spills.rowElement.style.overflowY === "auto", spills.rowElement.style.overflowY);
check("fit hid overflow on the frame", spills.menu.style.overflow === "hidden", spills.menu.style.overflow);

const clipped = fakeMenu({ top: 20, height: 200, clientHeight: 200, scrollHeight: 420 });
check("fit acts when rows overflow a clipped container", fitMenuToViewport(clipped.menu) === true);
check("fit made clipped rows scroll", clipped.rowElement.style.overflowY === "auto");

const tinyRoom = fakeMenu({ top: 280, height: 600, right: 900 });
fitMenuToViewport(tinyRoom.menu);
check("fit pins a menu with no room below it", tinyRoom.menu.style.top === "8px", tinyRoom.menu.style.top);
check("fit pulls a menu back inside the window", tinyRoom.menu.style.left === "592px", tinyRoom.menu.style.left);


if (problems.length) {
  console.error("\nFAILED");
  for (const problem of problems) console.error(" - " + problem);
  process.exit(1);
}
console.log("\nall checks passed");
