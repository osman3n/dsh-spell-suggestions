# Composer spellcheck (`@osman/dsh-composer-spellcheck`)

Right-click a word in the message composer and get spelling suggestions, with the
usual editing commands in the same menu.

## What it does

- Adds a **capture-phase `contextmenu` listener** on `document`. It only claims
  events whose target sits inside the composer (`[data-composer-input]`, the
  Lexical editor), so every other right-click in the app behaves exactly as
  before.
- Works out the word under the pointer, checks it against a bundled dictionary,
  and opens the shared Web context menu (`ctx.contextMenus`) with:
  1. up to five suggestions, ranked by edit distance and then word frequency;
  2. **Add to dictionary** — remembered in `localStorage` under
     `dsh.composer-spellcheck.user-words`;
  3. a separator, then **Cut, Copy, Paste, Select all, Undo, Redo**, so the
     default menu functions the shell would otherwise offer are still available.
- A word that is already known still gets the editing block, so the menu is
  useful for correct text too. Words the dictionary cannot match show
  “No suggestions” plus the same editing commands.
- Suggestions keep the original capitalisation: `Recieve` → `Receive`.

The composer is a Lexical editor; Chromium's own squiggles are untouched. This
plugin supplies the menu that makes them actionable in the desktop shell, which
has no native context menu at all.

## Files

| Path | Purpose |
| --- | --- |
| `index.js` | Host half — no service, exists so the Loader entry mounts. |
| `client.js` | Built browser half: listener, suggestion engine, menu contribution. |
| `src/client.template.js` | Source template with `__WORDS__` / `__EXTRA__` / `__DROP__` / `__TYPOS__` placeholders. |
| `src/allowlist.txt` | Extra known words for technical writing (one per line). |
| `src/typos.json` | Curated misspelling → correction pairs, including typed contractions (`dont` → `don't`). |
| `tools/prepare-words.mjs` | Downloads the frequency list once into `.tmp/`, filters and writes `.tmp/words.json`. |
| `tools/build-client.mjs` | Injects the word data into the template and writes `client.js`. |
| `tools/test-client.mjs` | Loads the built bundle through a stub loader, applies it to a fake `contextMenus`, and checks suggestions and timing. |

## Rebuild

```powershell
cd plugins/composer-spellcheck
node tools/prepare-words.mjs --limit=30000 --min-count=2   # only when refreshing the word list
node tools/build-client.mjs
node tools/test-client.mjs
```

Reload the app window afterwards; the browser half is loaded per page load.

## Dictionary

`~30k` words from the [FrequencyWords](https://github.com/hermitdave/FrequencyWords)
English list (CC-BY-SA), plus the allowlist, plus the curated corrections.
Informal spellings that the corpus contains (`dont`, `cant`, `youre`, …) are
dropped, because the curated map treats them as misspellings and they would
otherwise never get suggestions.

## Limits

- Only the composer is covered. Menu entries appear at the pointer; the menu
  itself is the app's shared Web menu, so keyboard navigation and dismissal are
  the platform's.
- Suggestions come from the bundled dictionary, not from the operating
  system's spellchecker, so the set of underlined words and the set of words
  with suggestions can differ slightly.
