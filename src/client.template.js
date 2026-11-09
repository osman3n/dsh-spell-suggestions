window.__ModuleLoader__.load({
  id: "@osman/dsh-composer-spellcheck",
  factory(require) {
    /**
     * Spellcheck suggestions for the conversation composer.
     *
     * The composer is a Lexical contentEditable ([data-composer-input]). Chromium
     * already underlines misspelled words there, but the desktop shell has no
     * native context menu, so the squiggle leads nowhere. This plugin adds one
     * menu of its own for right-clicks inside the composer: spelling suggestions
     * first, then the ordinary editing commands (cut/copy/paste/select all/undo/
     * redo) so nothing that the default menu used to offer is lost.
     *
     * Everything else about the app's right-click behaviour is untouched: the
     * listener only claims events whose target sits inside the composer.
     */

    /** Suggestion candidates are ranked by edit distance, then corpus rank. */
    const MAX_SUGGESTIONS = 5;
    const MAX_DISTANCE = 2;
    /** Words the user explicitly accepted from this menu. */
    const USER_WORDS_KEY = "dsh.composer-spellcheck.user-words";
    const COMPOSER_SELECTOR = "[data-composer-input]";
    const TARGET_KIND = "composer-spellcheck";

    // ---------------------------------------------------------------------
    // Word data. The build step replaces these four placeholders with the
    // contents of tools/prepare-words.mjs plus src/*.txt|json.
    // ---------------------------------------------------------------------
    const CORPUS = __WORDS__.split(" ");
    const EXTRA = __EXTRA__.split(" ");
    const DROP = __DROP__.split(" ");
    const TYPOS = __TYPOS__;

    const DROP_SET = new Set(DROP);

    // ---------------------------------------------------------------------
    // Locale
    // ---------------------------------------------------------------------
    const EN = {
      "suggestion.unknown": "No suggestions",
      "menu.addToDictionary": "Add to dictionary",
      "menu.cut": "Cut",
      "menu.copy": "Copy",
      "menu.paste": "Paste",
      "menu.selectAll": "Select all",
      "menu.undo": "Undo",
      "menu.redo": "Redo",
      "notify.added": "Added “{word}” to your dictionary",
      "notify.replaced": "Replaced with “{word}”",
      "notify.nothingToPaste": "Clipboard is empty",
      "notify.pasteFailed": "Could not read the clipboard",
      "notify.stale": "The text changed before the word could be replaced",
    };
    const ZH = {
      "suggestion.unknown": "没有建议",
      "menu.addToDictionary": "添加到词典",
      "menu.cut": "剪切",
      "menu.copy": "复制",
      "menu.paste": "粘贴",
      "menu.selectAll": "全选",
      "menu.undo": "撤销",
      "menu.redo": "重做",
      "notify.added": "已将“{word}”添加到词典",
      "notify.replaced": "已替换为“{word}”",
      "notify.nothingToPaste": "剪贴板是空的",
      "notify.pasteFailed": "无法读取剪贴板",
      "notify.stale": "文本已改变，无法替换该词",
    };

    // ---------------------------------------------------------------------
    // Dictionary
    // ---------------------------------------------------------------------
    /** lowercase word -> corpus rank (lower is more frequent) */
    const dictionary = new Map();
    /** word length -> entries, so a lookup only scans words of nearby length */
    const byLength = new Map();

    function letterMask(word) {
      let mask = 0;
      for (let i = 0; i < word.length; i += 1) {
        const code = word.charCodeAt(i) - 97;
        if (code >= 0 && code < 26) mask |= 1 << code;
      }
      return mask;
    }

    function popcount(value) {
      let v = value - ((value >> 1) & 0x55555555);
      v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
      return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
    }

    function addWord(word, rank) {
      const key = word.toLowerCase();
      if (!key || DROP_SET.has(key) || dictionary.has(key)) return;
      // The corpus contains informal "dont"/"cant" spellings; the curated
      // typo map owns those so they still produce suggestions.
      if (TYPOS[key]) return;
      dictionary.set(key, rank);
      const entry = { word: key, rank, mask: letterMask(key) };
      const bucket = byLength.get(key.length);
      if (bucket) bucket.push(entry);
      else byLength.set(key.length, [entry]);
    }

    function loadUserWords() {
      try {
        const raw = window.localStorage.getItem(USER_WORDS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
      } catch {
        return [];
      }
    }

    function saveUserWords(words) {
      try {
        window.localStorage.setItem(USER_WORDS_KEY, JSON.stringify(words.slice(-500)));
      } catch {
        /* storage is best effort */
      }
    }

    // ---------------------------------------------------------------------
    // Text helpers
    // ---------------------------------------------------------------------
    function normalizeCase(word) {
      return word.toLowerCase().replace(/\u2019/g, "'");
    }

    function isWordChar(ch) {
      return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "'" || ch === "\u2019";
    }

    /** Apply the source word's capitalisation to a suggestion. */
    function matchCase(source, target) {
      if (source.length > 1 && source === source.toUpperCase() && /^[A-Z][A-Z]+$/.test(source)) {
        return target.toUpperCase();
      }
      if (/^[A-Z]/.test(source)) {
        return target.charAt(0).toUpperCase() + target.slice(1);
      }
      return target;
    }

    // Rows are recycled between lookups: a right-click may compare this word
    // against thousands of candidates, and per-call allocation dominated the
    // cost of that scan.
    let scratchA = new Int32Array(64);
    let scratchB = new Int32Array(64);
    let scratchC = new Int32Array(64);

    /** Optimal string alignment distance, bailing out above `max`. */
    function distance(a, b, max) {
      const al = a.length;
      const bl = b.length;
      if (Math.abs(al - bl) > max) return max + 1;
      if (a === b) return 0;
      if (bl + 1 > scratchA.length) {
        const size = Math.max(bl + 1, 64) * 2;
        scratchA = new Int32Array(size);
        scratchB = new Int32Array(size);
        scratchC = new Int32Array(size);
      }
      let prev2 = scratchC;
      let prev = scratchA;
      let cur = scratchB;
      for (let j = 0; j <= bl; j += 1) prev[j] = j;
      for (let i = 1; i <= al; i += 1) {
        cur[0] = i;
        let rowMin = i;
        const ai = a.charCodeAt(i - 1);
        const ai2 = i > 1 ? a.charCodeAt(i - 2) : -1;
        for (let j = 1; j <= bl; j += 1) {
          const bj = b.charCodeAt(j - 1);
          const cost = ai === bj ? 0 : 1;
          let value = prev[j] + 1;
          const insertion = cur[j - 1] + 1;
          if (insertion < value) value = insertion;
          const diagonal = prev[j - 1] + cost;
          if (diagonal < value) value = diagonal;
          if (i > 1 && j > 1 && ai === b.charCodeAt(j - 2) && ai2 === bj) {
            const transposed = prev2[j - 2] + 1;
            if (transposed < value) value = transposed;
          }
          cur[j] = value;
          if (value < rowMin) rowMin = value;
        }
        if (rowMin > max) return max + 1;
        const recycled = prev2;
        prev2 = prev;
        prev = cur;
        cur = recycled;
      }
      return prev[bl];
    }

    function suggestionsFor(word) {
      const lower = normalizeCase(word);
      const found = [];
      const seen = new Set([lower]);

      const push = (candidate, force) => {
        const key = normalizeCase(candidate);
        if (seen.has(key)) return;
        if (!force && !dictionary.has(key)) return;
        seen.add(key);
        found.push(candidate);
      };

      // 1. Curated typo corrections win outright.
      const direct = TYPOS[lower];
      if (direct) push(direct, true);

      // 2. Ordinary edit-distance candidates.
      if (found.length < MAX_SUGGESTIONS) {
        const mask = letterMask(lower);
        // Two edits remove at most two distinct letters, so a candidate that
        // is missing more than that from our letter set cannot be within range.
        const needed = popcount(mask) - MAX_DISTANCE;
        const candidates = [];
        for (let length = lower.length - MAX_DISTANCE; length <= lower.length + MAX_DISTANCE; length += 1) {
          const bucket = byLength.get(length);
          if (!bucket) continue;
          for (let i = 0; i < bucket.length; i += 1) {
            const entry = bucket[i];
            if (needed > 1 && popcount(mask & entry.mask) < needed) continue;
            const d = distance(lower, entry.word, MAX_DISTANCE);
            if (d <= MAX_DISTANCE) candidates.push([d, entry.rank, entry.word]);
          }
        }
        candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        for (const [, , candidate] of candidates) {
          if (found.length >= MAX_SUGGESTIONS) break;
          push(candidate);
        }
      }

      return found.map((candidate) => matchCase(word, candidate));
    }

    // ---------------------------------------------------------------------
    // Composer access
    // ---------------------------------------------------------------------
    /** True when the node lives inside an element that opts out of spellcheck. */
    function isExcluded(node, root) {
      for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
        const tag = el.tagName;
        if (tag === "CODE" || tag === "PRE" || tag === "A") return true;
        if (el.getAttribute("spellcheck") === "false") return true;
        if (el.hasAttribute("data-composer-text-ref")) return true;
      }
      return false;
    }

    function caretAtPoint(x, y) {
      if (typeof document.caretPositionFromPoint === "function") {
        const position = document.caretPositionFromPoint(x, y);
        if (position) return { node: position.offsetNode, offset: position.offset };
      }
      if (typeof document.caretRangeFromPoint === "function") {
        const range = document.caretRangeFromPoint(x, y);
        if (range) return { node: range.startContainer, offset: range.startOffset };
      }
      return null;
    }

    /** Expand the caret position to the whole word around it. */
    function wordAt(node, offset) {
      if (!node || node.nodeType !== Node.TEXT_NODE) return null;
      const text = node.data || "";
      let index = Math.min(Math.max(offset, 0), text.length);
      // Right-clicking just past a word should still pick that word up.
      if (index > 0 && (index === text.length || !isWordChar(text[index]))) {
        if (isWordChar(text[index - 1])) index -= 1;
      }
      if (!isWordChar(text[index] || "")) return null;

      let start = index;
      while (start > 0 && isWordChar(text[start - 1])) start -= 1;
      let end = index;
      while (end < text.length && isWordChar(text[end])) end += 1;

      // Trim apostrophes at either edge ("'what'" and trailing possessives).
      while (start < end && !/[A-Za-z]/.test(text[start])) start += 1;
      while (end > start && !/[A-Za-z]/.test(text[end - 1])) end -= 1;

      const word = text.slice(start, end);
      if (!/^[A-Za-z][A-Za-z'\u2019]*$/.test(word)) return null;
      if (word.length < 2 || word.length > 40) return null;
      return { word, start, end };
    }

    function selectRange(node, start, end) {
      const selection = window.getSelection();
      if (!selection) return null;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      selection.removeAllRanges();
      selection.addRange(range);
      return range;
    }

    /** Character offset of `node`'s `offset` position, counted from the editor root. */
    function absoluteOffset(root, node, offset) {
      if (!root.contains(node)) return -1;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let total = 0;
      for (let current = walker.nextNode(); current; current = walker.nextNode()) {
        if (current === node) return total + offset;
        total += current.data.length;
      }
      return -1;
    }

    /**
     * Re-find a word inside the editor. Lexical re-renders text nodes as it
     * reconciles, so the node captured on right-click may be gone by the time a
     * menu action runs.
     */
    function locateWord(root, word, preferredOffset) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let total = 0;
      let best = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const data = node.data || "";
        let index = data.indexOf(word);
        while (index !== -1) {
          const start = total + index;
          if (!isExcluded(node, root) && (best === null || Math.abs(start - preferredOffset) < Math.abs(best.absStart - preferredOffset))) {
            best = { node, start, end: start + word.length, absStart: start };
          }
          index = data.indexOf(word, index + 1);
        }
        total += data.length;
      }
      return best;
    }

    /** The live position of the word this session was opened on, if still there. */
    function currentLocation(session) {
      const node = session.node;
      if (node && node.isConnected && (node.data || "").slice(session.start, session.end) === session.word) {
        return { node, start: session.start, end: session.end, absStart: session.absStart };
      }
      return locateWord(session.root, session.word, session.absStart);
    }

    function restoreSelection(session) {
      if (!session) return false;
      const location = currentLocation(session) || (session.node && session.node.isConnected ? { node: session.node, start: session.caret, end: session.caret } : null);
      if (!location) return false;
      const selection = window.getSelection();
      if (!selection) return false;
      if (session.savedRange) {
        try {
          selection.removeAllRanges();
          selection.addRange(session.savedRange);
          return true;
        } catch {
          /* the saved range may point at replaced text */
        }
      }
      selectRange(location.node, location.start, location.end);
      return true;
    }

    /**
     * Replace `[start, end)` of a text node with `text` and prove it stuck.
     * The first attempt goes through the editing command so Lexical sees a
     * normal input event; the fallback edits the text node directly and raises
     * an input event for the editor to reconcile.
     */
    function replaceRange(root, node, start, end, text) {
      root.focus();
      selectRange(node, start, end);
      try {
        document.execCommand("insertText", false, text);
      } catch {
        /* fall through to the direct edit */
      }
      const stillThere = node.isConnected && (node.data || "").slice(start, start + text.length) === text;
      if (stillThere || (root.textContent || "").indexOf(text) !== -1) return true;

      try {
        if (node.isConnected) {
          node.data = (node.data || "").slice(0, start) + text + (node.data || "").slice(end);
          node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        }
      } catch {
        /* nothing else to try */
      }
      return (root.textContent || "").indexOf(text) !== -1;
    }

    // ---------------------------------------------------------------------
    // Plugin
    // ---------------------------------------------------------------------
    /**
     * Undo/redo go through the editor's own keyboard command handler: a direct
     * `execCommand("undo")` rewinds the DOM behind Lexical's model and leaves
     * the two out of sync.
     */
    function dispatchShortcut(root, key, shift) {
      root.focus();
      const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || "");
      const event = new KeyboardEvent("keydown", {
        key: shift ? "Z" : key,
        code: "Key" + key.toUpperCase(),
        ctrlKey: !isMac,
        metaKey: isMac,
        shiftKey: Boolean(shift),
        bubbles: true,
        cancelable: true,
      });
      root.dispatchEvent(event);
    }

    function apply(ctx) {
      let menu = null;
      let contributed = false;

      /**
       * The shared menu is provided by a sibling plugin, so it is looked up
       * lazily: a declared inject would silently cancel this plugin whenever
       * that sibling had not been applied first, while a real right-click can
       * only happen once every bundle is loaded.
       */
      function ensureMenu() {
        if (menu) return menu;
        const candidate = (ctx.get && ctx.get("contextMenus")) || ctx.contextMenus || null;
        if (!candidate) return null;
        menu = candidate;
        if (!contributed) {
          contributed = true;
          ctx.effect(
            () => menu.register({ id: "composer-spellcheck", target: TARGET_KIND, order: 10, resolve }),
            "composer-spellcheck menu contribution",
          );
        }
        return menu;
      }

      const locale = (ctx.get && ctx.get("locale")) || null;
      if (locale && typeof locale.register === "function") {
        try {
          locale.register("composer-spellcheck", "en", EN);
          locale.register("composer-spellcheck", "zh", ZH);
        } catch (error) {
          console.warn("[composer-spellcheck] locale registration failed", error);
        }
      }
      const translator = locale && typeof locale.bind === "function" ? locale.bind("composer-spellcheck") : null;
      const t = (key, vars) => {
        if (translator) {
          try {
            const value = translator(key, vars);
            if (value && value !== key) return value;
          } catch {
            /* fall through to English */
          }
        }
        let text = EN[key] || key;
        if (vars) {
          for (const [name, value] of Object.entries(vars)) {
            text = text.split("{" + name + "}").join(String(value));
          }
        }
        return text;
      };
      const notify = (text, failed) => {
        const service = ensureMenu();
        if (service && typeof service.notify === "function") service.notify(text, !failed);
      };

      // Build the known-word index once.
      for (let i = 0; i < CORPUS.length; i += 1) addWord(CORPUS[i], i);
      for (const word of EXTRA) addWord(word, CORPUS.length + 100000);
      for (const word of loadUserWords()) addWord(word, CORPUS.length + 200000);

      /** Right-click sessions, keyed by the token embedded in the menu target. */
      const sessions = new Map();
      let nextToken = 0;

      function remember(session) {
        sessions.set(session.token, session);
        while (sessions.size > 6) {
          const oldest = sessions.keys().next();
          if (oldest.done) break;
          sessions.delete(oldest.value);
        }
      }

      function onContextMenu(event) {
        const service = ensureMenu();
        if (!service) return;

        const origin = event.target;
        const target = origin instanceof Element ? origin : origin && origin.parentElement;
        if (!target) return;
        const root = target.closest(COMPOSER_SELECTOR);
        if (!root) return;

        const point = caretAtPoint(event.clientX, event.clientY);
        if (!point || !point.node || !root.contains(point.node)) return;
        if (isExcluded(point.node, root)) return;

        const found = wordAt(point.node, point.offset);
        if (!found) return;

        // Claim the event from the app's own dismissal handler, which only
        // closes on events whose default was not already prevented.
        event.preventDefault();
        event.stopPropagation();

        const selection = window.getSelection();
        const savedRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
        const absStart = absoluteOffset(root, point.node, found.start);
        const session = {
          token: nextToken += 1,
          root,
          node: point.node,
          word: found.word,
          start: found.start,
          end: found.end,
          absStart: absStart < 0 ? found.start : absStart,
          caret: Math.min(Math.max(point.offset, found.start), found.end),
          savedRange,
        };
        remember(session);

        try {
          service.open({ kind: TARGET_KIND, value: { token: session.token } }, { x: event.clientX, y: event.clientY });
        } catch (error) {
          console.warn("[composer-spellcheck] could not open menu", error);
        }
      }

      function resolve(value) {
        const token = value && typeof value === "object" ? value.token : undefined;
        const session = typeof token === "number" ? sessions.get(token) : undefined;
        if (!session) return [];
        const lower = normalizeCase(session.word);
        const known = dictionary.has(lower);
        const actions = [];

        if (!known) {
          const suggestions = suggestionsFor(session.word);
          if (suggestions.length === 0) {
            actions.push({ id: "none", label: t("suggestion.unknown"), disabled: true });
          } else {
            suggestions.forEach((suggestion, index) => {
              actions.push({
                id: "s:" + index + ":" + suggestion,
                label: suggestion,
                run: () => replaceWord(session, suggestion),
              });
            });
          }
          actions.push({
            id: "add",
            label: t("menu.addToDictionary"),
            run: () => addToDictionary(session),
          });
        }

        actions.push({
          id: "cut",
          label: t("menu.cut"),
          separatorBefore: true,
          run: () => {
            restoreSelection(session);
            document.execCommand("cut");
          },
        });
        actions.push({
          id: "copy",
          label: t("menu.copy"),
          run: () => {
            restoreSelection(session);
            document.execCommand("copy");
          },
        });
        actions.push({
          id: "paste",
          label: t("menu.paste"),
          run: async () => {
            try {
              const text = await navigator.clipboard.readText();
              if (!text) {
                notify(t("notify.nothingToPaste"), true);
                return;
              }
              restoreSelection(session);
              session.root.focus();
              document.execCommand("insertText", false, text);
            } catch {
              notify(t("notify.pasteFailed"), true);
            }
          },
        });
        actions.push({
          id: "selectAll",
          label: t("menu.selectAll"),
          run: () => {
            session.root.focus();
            const selection = window.getSelection();
            if (!selection) return;
            const range = document.createRange();
            range.selectNodeContents(session.root);
            selection.removeAllRanges();
            selection.addRange(range);
          },
        });
        actions.push({
          id: "undo",
          label: t("menu.undo"),
          separatorBefore: true,
          run: () => dispatchShortcut(session.root, "z", false),
        });
        actions.push({
          id: "redo",
          label: t("menu.redo"),
          run: () => dispatchShortcut(session.root, "z", true),
        });

        return actions;
      }

      function replaceWord(session, suggestion) {
        const location = currentLocation(session);
        if (!location) {
          notify(t("notify.stale"), true);
          return;
        }
        const ok = replaceRange(session.root, location.node, location.start, location.end, suggestion);
        if (ok) notify(t("notify.replaced", { word: suggestion }));
        else notify(t("notify.stale"), true);
      }

      function addToDictionary(session) {
        const words = loadUserWords();
        const lower = normalizeCase(session.word);
        if (!words.some((item) => normalizeCase(item) === lower)) {
          words.push(session.word);
          saveUserWords(words);
        }
        addWord(session.word, CORPUS.length + 200000);
        notify(t("notify.added", { word: session.word }));
      }

      ctx.effect(() => {
        document.addEventListener("contextmenu", onContextMenu, true);
        return () => document.removeEventListener("contextmenu", onContextMenu, true);
      }, "composer-spellcheck right-click listener");

      // Contribute the extra actions right away when the service is already
      // up; otherwise the first right-click inside the composer does it.
      ensureMenu();
    }

    return { apply };
  },
});
