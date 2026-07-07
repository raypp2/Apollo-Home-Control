#!/usr/bin/env node
// archive-session-log.mjs — keep session-log/session-log.md lean by rolling
// older entries into session-log/archive/ chunk files, leaving a recent tail
// + an index.
//
// WHY: session-log.md grows unboundedly (one entry per request). Reading and
// appending to a huge file wastes tokens. This rolls the bulk into archive
// chunks (grepped when needed, never read whole) and keeps the live file to
// the most recent entries plus a generated index pointing at the archives.
//
// DESIGN (deterministic + idempotent):
//  - Rebuilds from the FULL corpus every run: re-reads every archive chunk +
//    the live file, extracts all entries in order, then re-splits. Re-running
//    is a no-op; changing CHUNK/KEEP re-chunks cleanly. No entry is ever lost
//    (asserted by count BEFORE anything is written — see "atomic write" below).
//  - Entry headings: v2 date IDs (`### YYYY-MM-DD HH:MM–HH:MM — desc`) and
//    legacy v1 numbers (`### #N — desc`) are both accepted. Chunks are split
//    by sequence position (order of appearance — the only key that is stable
//    across both schemes and across parallel sessions).
//  - Archive filenames carry the chunk's DATE RANGE when its entries have
//    dates (`2026-06-09_2026-06-14.md`); legacy dateless chunks fall back to
//    sequence-position names (`seq-0001-0025.md`).
//  - Session markers (`--- session ... ---`) and milestone lines travel with
//    the entry they follow.
//  - After archiving, runs usage-snapshot.mjs if present, so the cost
//    snapshot is refreshed whenever the log is compacted.
//
// ATOMIC WRITE: new chunks are written to a staging directory and the
// conservation check runs against that staged content *before* anything real
// is touched. Only then: rename the live archive/ dir aside, rename staging
// into its place, delete the aside copy, rename the live-file temp into
// place. At every step either the OLD or the NEW complete state is on disk —
// never neither — so a crash mid-archive can't land in a half-written state.
// Any `.archive-staging-*`/`.archive-old-*` siblings left by a previous crash
// are swept at the start of the next run.
//
// USAGE:
//   node _scripts/archive-session-log.mjs            # archive + rewrite
//   node _scripts/archive-session-log.mjs --dry-run  # print the plan only
//   node _scripts/archive-session-log.mjs --root <dir>
//   node _scripts/archive-session-log.mjs --auto     # debounced: exits fast
//                                                    #   (<50ms) unless the
//                                                    #   last real check is
//                                                    #   >24h old. Wired to
//                                                    #   SessionStart/Stop
//                                                    #   hooks by /showcase-log
//                                                    #   so entries no longer
//                                                    #   pile up past ~40
//                                                    #   just because nobody
//                                                    #   remembered to ask.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from './lib/paths.mjs';
import { ENTRY_RE } from './lib/log.mjs';

const CHUNK = 25; // entries per archive file
const KEEP = 15;  // minimum recent entries always kept live (plus the partial chunk)
const LIVE_TOKEN_WARN = 10_000; // warn when the live file's estimated tokens exceed this
const DEBOUNCE_MS = 24 * 60 * 60 * 1000; // --auto: do real work at most daily

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const AUTO = argv.includes('--auto');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const P = resolvePaths(opt('--root') || path.resolve(SCRIPT_DIR, '..'));
const LIVE_FILE = P.LIVE_FILE;
const ARCHIVE_DIR = P.ARCHIVE_DIR;
const dryRun = argv.includes('--dry-run');

const readJSON = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};

// --- debounce (must stay cheap: this runs on every Stop hook) — checked
// before touching the live file or any archive chunks at all, since those
// reads scale with corpus size and a hook should stay effectively free. ---
if (AUTO) {
  const state = readJSON(P.ARCHIVE_STATE_FILE, { lastRun: 0 });
  if (Date.now() - (state.lastRun || 0) < DEBOUNCE_MS) process.exit(0);
  if (!fs.existsSync(LIVE_FILE)) process.exit(0); // nothing set up yet
}

const die = (m) => { console.error(`archive-session-log.mjs: error — ${m}`); process.exit(1); };
const pad = (n) => String(n).padStart(4, '0');
const estTokens = (text) => Math.round(Buffer.byteLength(text, 'utf8') / 4);
const fmtTok = (n) => `~${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k tok`;

/** Split a file's text into entries (a heading line through the line before the
 * next heading). Text before the first entry (header/index preamble) is dropped —
 * it is regenerated. Session markers and milestones attach to the entry above. */
function extractEntries(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (ENTRY_RE.test(line)) {
      if (cur !== null) out.push(cur);
      cur = line;
    } else if (cur !== null) {
      cur += '\n' + line;
    }
  }
  if (cur !== null) out.push(cur);
  return out.map((e) => e.replace(/\s+$/, ''));
}

const entryDate = (entry) => {
  const m = entry.match(/^### (\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

if (!fs.existsSync(LIVE_FILE)) die(`session-log.md not found at ${LIVE_FILE}`);

// --- Gather the full corpus: every archive chunk (in order) then the live file.
// Extract PER FILE (each call drops that file's own preamble) and concatenate. ---
const archiveFilesPrev = fs.existsSync(ARCHIVE_DIR)
  ? fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.md')).sort()
  : [];
const sourceTexts = [
  ...archiveFilesPrev.map((f) => fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8')),
  fs.readFileSync(LIVE_FILE, 'utf8'),
];
const entries = sourceTexts.flatMap((t) => extractEntries(t));
const expected = sourceTexts.reduce(
  (n, t) => n + t.split('\n').filter((l) => ENTRY_RE.test(l)).length, 0);
if (entries.length !== expected) die(`entry-count mismatch while parsing (${entries.length} vs ${expected}) — aborting, nothing written`);
if (!entries.length) die('no entries found — aborting');

const n = entries.length;

// --- Decide the split: archive whole chunks, keep the tail (partial + KEEP) live ---
const archivedCount = Math.max(0, Math.floor((n - KEEP) / CHUNK) * CHUNK);
const archived = entries.slice(0, archivedCount);
const live = entries.slice(archivedCount);
const nChunks = archivedCount / CHUNK;

const usedNames = new Set();
const chunkPlan = [];
for (let i = 0; i < nChunks; i++) {
  const start = i * CHUNK; // 0-based
  const slice = archived.slice(start, start + CHUNK);
  const seqStart = start + 1;
  const seqEnd = start + slice.length;
  const dates = slice.map(entryDate).filter(Boolean);
  let base, span;
  if (dates.length) {
    const d1 = dates.reduce((a, b) => (a < b ? a : b));
    const d2 = dates.reduce((a, b) => (a > b ? a : b));
    base = d1 === d2 ? d1 : `${d1}_${d2}`;
    span = d1 === d2 ? d1 : `${d1} → ${d2}`;
  } else {
    base = `seq-${pad(seqStart)}-${pad(seqEnd)}`;
    span = `entries ${seqStart}–${seqEnd} (undated)`;
  }
  let name = `${base}.md`;
  for (let k = 2; usedNames.has(name); k++) name = `${base}-${k}.md`;
  usedNames.add(name);
  const body = slice.join('\n\n');
  chunkPlan.push({ name, seqStart, seqEnd, slice, span, tokens: estTokens(body) });
}

// --- Report the plan ---
console.log(`Corpus: ${n} entries. Archive ${archivedCount} into ${nChunks} chunk(s) of ${CHUNK}; keep ${live.length} live (KEEP=${KEEP}).`);
for (const c of chunkPlan) console.log(`  session-log/archive/${c.name} — ${c.slice.length} entries, ${c.span}, ${fmtTok(c.tokens)}`);
if (dryRun) { console.log('(--dry-run: nothing written)'); process.exit(0); }

// --- Self-gate: nothing to actually archive yet — skip the write phase
// entirely rather than rewrite session-log.md's header for no real change. ---
if (nChunks === 0) {
  if (AUTO) { fs.mkdirSync(P.USAGE_DIR, { recursive: true }); fs.writeFileSync(P.ARCHIVE_STATE_FILE, JSON.stringify({ lastRun: Date.now() })); }
  process.exit(0);
}

// --- Build the lean live file's text in memory ---
const indexLines = chunkPlan.length
  ? chunkPlan.map((c) => `- [\`archive/${c.name}\`](archive/${c.name}) — ${c.slice.length} entries, ${c.span} (${fmtTok(c.tokens)})`).join('\n')
  : '- _(none yet — nothing archived)_';

const header = `# Project Log

This is the live tail of the project's interaction log — everything in this
folder (\`session-log/\`) is auto-maintained by the showcase-log skill:
\`archive/\` holds older entries rolled off this file, \`usage/\` holds exact
token-cost data harvested from Claude Code transcripts, and dated recap pages
(\`YYYY-MM-DD-Recap.html\`) are generated views over all of it. None of it is
meant to be hand-edited.

---

> **Archiving:** older entries roll into \`archive/\` to keep this file lean
> (cheap to read and append to). This header + the index below are
> auto-generated by \`_scripts/archive-session-log.mjs\`. Keep appending new
> entries to the **Interaction Log** below as normal — the next run rolls the
> old ones out. Don't hand-edit the index.

### Archived entries (oldest → newest)
${indexLines}

---

## Interaction Log`;

const body = live.length ? `\n\n${live.join('\n\n')}\n` : '\n';
const liveText = `${header}${body}`;

// --- Safety gate: reconstruction must conserve every entry, checked against
// the planned content BEFORE anything on disk is touched. A failure here
// aborts with the original files completely untouched — nothing to recover. ---
const reconstructed = extractEntries([
  ...chunkPlan.map((c) => c.slice.join('\n\n')),
  live.join('\n\n'),
].join('\n')).length;
if (reconstructed !== n) die(`planned split reconstructs to ${reconstructed} entries, expected ${n} — aborting, nothing written`);

// --- Atomic write: stage everything, then swap. At every step either the OLD
// or the NEW complete state is on disk, never neither — a crash anywhere in
// here leaves something a re-run (idempotent) can recover from, not a gap. ---
const stagingDir = `${ARCHIVE_DIR}.archive-staging-${process.pid}`;
const oldDir = `${ARCHIVE_DIR}.archive-old-${process.pid}`;
const liveTmpFile = `${LIVE_FILE}.tmp-${process.pid}`;

// Sweep any staging/old dirs a previous crashed run left behind, from any pid.
const parentDir = path.dirname(ARCHIVE_DIR);
const archiveBase = path.basename(ARCHIVE_DIR);
if (fs.existsSync(parentDir)) {
  for (const name of fs.readdirSync(parentDir)) {
    if (name.startsWith(`${archiveBase}.archive-staging-`) || name.startsWith(`${archiveBase}.archive-old-`)) {
      fs.rmSync(path.join(parentDir, name), { recursive: true, force: true });
    }
  }
}

fs.mkdirSync(stagingDir, { recursive: true });
for (const c of chunkPlan) {
  const head = `<!-- Auto-generated by _scripts/archive-session-log.mjs — do not hand-edit. Archived slice of session-log.md. -->\n`
    + `# Project Log — archive (${c.span}, entries ${c.seqStart}–${c.seqEnd} in sequence)\n\n`
    + `[← back to session-log.md](../session-log.md)\n`;
  fs.writeFileSync(path.join(stagingDir, c.name), `${head}\n${c.slice.join('\n\n')}\n`);
}
fs.writeFileSync(liveTmpFile, liveText);

if (fs.existsSync(ARCHIVE_DIR)) fs.renameSync(ARCHIVE_DIR, oldDir);
fs.renameSync(stagingDir, ARCHIVE_DIR);
fs.rmSync(oldDir, { recursive: true, force: true });
fs.renameSync(liveTmpFile, LIVE_FILE);

if (AUTO) { fs.mkdirSync(P.USAGE_DIR, { recursive: true }); fs.writeFileSync(P.ARCHIVE_STATE_FILE, JSON.stringify({ lastRun: Date.now() })); }

const liveTok = estTokens(liveText);
console.log(`Wrote ${nChunks} archive chunk(s) + lean session-log.md (${live.length} live entries, ${fmtTok(liveTok)}). Total entries conserved: ${n}.`);
if (liveTok > LIVE_TOKEN_WARN) {
  console.log(`⚠ live file is ${fmtTok(liveTok)} (> ${fmtTok(LIVE_TOKEN_WARN)}) — entries are unusually large; consider a leaner detail tier.`);
}

// --- Piggyback: refresh the usage snapshot whenever the log is compacted ---
const snapshot = path.join(SCRIPT_DIR, 'usage-snapshot.mjs');
if (fs.existsSync(snapshot)) {
  const res = spawnSync(process.execPath, [snapshot, '--root', P.ROOT], { stdio: 'inherit' });
  if (res.status !== 0) console.error('(usage-snapshot failed — archive unaffected)');
}
