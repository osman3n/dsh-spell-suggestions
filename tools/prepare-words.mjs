/**
 * Prepare the embedded English vocabulary for the composer spellcheck plugin.
 *
 * Downloads a public frequency list once, keeps ordinary lowercase words with
 * their corpus rank, and writes `.tmp/words.json` (rank order). The client
 * bundle embeds the first N entries, so rank doubles as suggestion priority.
 *
 * Usage: node tools/prepare-words.mjs [--limit=30000] [--min-count=2]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const SOURCE = 'https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/en/en_50k.txt';
const ROOT = resolve(import.meta.dirname, '..');
const CACHE = resolve(ROOT, '.tmp/en_50k.txt');
const OUT = resolve(ROOT, '.tmp/words.json');

const args = process.argv.slice(2);
const limit = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 30000);
const minCount = Number(args.find((a) => a.startsWith('--min-count='))?.split('=')[1] ?? 2);

async function sourceText() {
  try {
    return await readFile(CACHE, 'utf8');
  } catch {
    const response = await fetch(SOURCE, { headers: { 'user-agent': 'dsh-composer-spellcheck' } });
    if (!response.ok) throw new Error(`download failed: ${response.status} ${SOURCE}`);
    const text = await response.text();
    await mkdir(dirname(CACHE), { recursive: true });
    await writeFile(CACHE, text);
    return text;
  }
}

/**
 * Ordinary dictionary-shaped word: letters plus internal apostrophes (so typed
 * contractions such as "don't" stay known), no corpus junk.
 */
function acceptable(word) {
  if (!/^[a-z][a-z']{0,22}[a-z]$/.test(word)) return false;
  if (/(.)\1{3,}/.test(word)) return false;
  if (/'{2,}/.test(word)) return false;
  return true;
}

const lines = (await sourceText()).split(/\r?\n/);
const seen = new Set();
const words = [];
for (const line of lines) {
  const match = /^([^\s]+)\s+(\d+)$/.exec(line.trim());
  if (!match) continue;
  const word = match[1].toLowerCase();
  const count = Number(match[2]);
  if (count < minCount || !acceptable(word) || seen.has(word)) continue;
  seen.add(word);
  words.push(word);
  if (words.length >= limit) break;
}

await writeFile(OUT, `${JSON.stringify(words)}\n`);
const chars = words.reduce((total, word) => total + word.length + 1, 0);
console.log(JSON.stringify({ out: OUT, words: words.length, bytes: chars, first: words.slice(0, 12), last: words.slice(-5) }, null, 2));
