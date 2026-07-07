#!/usr/bin/env node
// enrich-log-dates.mjs — adds real dates to log entries that have content but
// no date: specifically, the pre-v2 numbered heading format
// (`### #N — [HH:MM–HH:MM] description`, or `### #N — description`) that
// Step 1's legacy-layout migration moves into session-log/session-log.md
// as-is, unchanged. Migration fixes the *folder layout*; it was never meant
// to fix the *heading format*, and Step 4's backfill-from-history.mjs only
// knows how to draft brand-new entries into an empty log — neither one adds
// a missing date to an entry that already exists. This script is that
// missing third path.
//
// WHY THIS MATTERS: every deterministic recap feature keyed on `entry.date`
// (the daily activity chart, day drill-down panels, the workstreams gantt)
// silently renders empty for an entry whose heading has no date in it — see
// lib/log.mjs's loadEntries(), which sets `date: null` for exactly this
// heading shape. A log that migrated wholesale from v1 ships every one of
// those features empty, with nothing in setup's output to say so, even
// though the transcript history needed to fix it is very often still
// sitting right there in ~/.claude/projects/.
//
// MATCHING: reads the same transcript turns backfill-from-history.mjs does
// (lib/transcripts.mjs) and, for each undated entry's verbatim initial
// prompt, finds the best-scoring turn — score = max(longest common prefix,
// longest common substring), both case-insensitive. Matching is
// monotonic-first: for entry i, search turns strictly after the turn last
// assigned to entry i-1, and accept the best match there if its score clears
// MONOTONIC_FLOOR. Only if nothing in that remaining suffix clears the floor
// does it fall back to a global best-match search (which could land earlier
// in time), gated by a higher GLOBAL_FLOOR since it has weaker positional
// evidence. Entries with no Prompt field, or a match too weak to clear
// either bar, are interpolated from the nearest dated neighbor (an
// already-dated entry, or another entry this same run just matched) — never
// left blank if any date anywhere in the log can reach them. A final
// left-to-right pass snaps any entry whose date precedes its predecessor's
// forward onto the predecessor's date, so the result is always
// non-decreasing even where a global-fallback match landed out of order.
//
// This is a heuristic, best-effort recovery — same spirit as
// check-log-coverage.mjs's substring matching — not a guarantee of a
// perfect match for every entry.
//
// USAGE:
//   node _scripts/enrich-log-dates.mjs             # rewrite headings in place
//   node _scripts/enrich-log-dates.mjs --report    # print counts only, write nothing
//   --root <dir>         project root (default: parent of this script's dir)
//   --transcripts <dir>  transcript dir override (default: derived from root)
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from './lib/paths.mjs';
import { ENTRY_RE, corpusFiles, extractPromptBlocks } from './lib/log.mjs';
import { transcriptDirFor, extractAllSessions } from './lib/transcripts.mjs';
import { localDay } from './lib/usage.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const REPORT = flag('--report');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const P = resolvePaths(opt('--root') || path.resolve(SCRIPT_DIR, '..'));
const TRANSCRIPT_DIR = path.resolve(opt('--transcripts') || transcriptDirFor(P.ROOT));

const DATE_RE = /\d{4}-\d{2}-\d{2}/;
// Captures the "### #N — " prefix separately from the rest of the heading,
// so a date can be spliced in between without disturbing either side.
const NUMBERED_PREFIX_RE = /^(### #\d+\s*[—-]\s*)(.*)$/;

const MONOTONIC_FLOOR = 15; // score to accept a match within the remaining chronological suffix
const GLOBAL_FLOOR = 30;    // higher bar for a match found outside that suffix (weaker positional evidence)

// --- scoring: max(longest common prefix, longest common substring), case-insensitive ---
function normalize(s) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function longestCommonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Classic O(n*m) substring DP. Both inputs are capped so one very long prompt
// or turn can't blow up the cost of scoring every candidate pair.
function longestCommonSubstringLen(a, b) {
  const A = a.slice(0, 400);
  const B = b.slice(0, 400);
  let best = 0;
  let prevRow = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    const row = new Array(B.length + 1).fill(0);
    for (let j = 1; j <= B.length; j++) {
      if (A[i - 1] === B[j - 1]) {
        row[j] = prevRow[j - 1] + 1;
        if (row[j] > best) best = row[j];
      }
    }
    prevRow = row;
  }
  return best;
}

function matchScore(entryText, turnText) {
  if (!entryText || !turnText) return 0;
  const a = normalize(entryText);
  const b = normalize(turnText);
  if (!a || !b) return 0;
  return Math.max(longestCommonPrefixLen(a, b), longestCommonSubstringLen(a, b));
}

// --- parse every corpus file (archive/*.md, oldest first, then the live
// file) into its entries, tracking exactly where each heading line lives so
// a match can be written back in place without disturbing anything else. ---
function parseCorpus() {
  const files = corpusFiles(P);
  const perFile = files.map((fp) => ({ path: fp, lines: fs.readFileSync(fp, 'utf8').split('\n') }));
  const entries = [];
  perFile.forEach((f, fileIdx) => {
    let start = -1;
    const flush = (endExclusive) => {
      if (start === -1) return;
      const raw = f.lines.slice(start, endExclusive).join('\n');
      const heading = f.lines[start];
      const dateMatch = heading.match(DATE_RE);
      entries.push({
        fileIdx,
        lineIdx: start,
        heading,
        needsDate: !dateMatch,
        existingDate: dateMatch ? dateMatch[0] : null,
        prompt: extractPromptBlocks(raw)[0] || null,
      });
    };
    f.lines.forEach((line, i) => {
      if (ENTRY_RE.test(line)) { flush(i); start = i; }
    });
    flush(f.lines.length);
  });
  return { perFile, entries };
}

const { perFile, entries } = parseCorpus();
const targets = entries.filter((e) => e.needsDate);

if (!targets.length) {
  console.log(entries.length
    ? `enrich-log-dates: ${entries.length} entries, all already dated — nothing to enrich.`
    : `enrich-log-dates: no entries found in session-log/session-log.md — nothing to enrich.`);
  process.exit(0);
}

const sessions = extractAllSessions(TRANSCRIPT_DIR);
const turns = sessions.flatMap((s) => s.turns).filter((t) => t.ts);

if (REPORT) {
  console.log(
    `enrich-log-dates: ${targets.length} of ${entries.length} entries have no date `
    + `(pre-v2 heading format); ${turns.length} recoverable transcript turn(s) at ${TRANSCRIPT_DIR}.`,
  );
  process.exit(0);
}

if (!turns.length) {
  console.log(
    `enrich-log-dates: ${targets.length} of ${entries.length} entries have no date, but no `
    + `transcript history is available at ${TRANSCRIPT_DIR} to recover them from — leaving them as-is.`,
  );
  process.exit(0);
}

// --- monotonic-first matching over the flattened, chronological turn list ---
const knownDate = entries.map((e) => (e.needsDate ? null : e.existingDate));
let lastUsed = -1;
let matchedMonotonic = 0;
let matchedGlobal = 0;

entries.forEach((e, idx) => {
  if (!e.needsDate || !e.prompt) return;

  let bestIdx = -1, bestScore = -1;
  for (let j = lastUsed + 1; j < turns.length; j++) {
    const s = matchScore(e.prompt, turns[j].text);
    if (s > bestScore) { bestScore = s; bestIdx = j; }
  }
  if (bestIdx !== -1 && bestScore >= MONOTONIC_FLOOR) {
    knownDate[idx] = localDay(turns[bestIdx].ts);
    lastUsed = bestIdx;
    matchedMonotonic++;
    return;
  }

  let gBestIdx = -1, gBestScore = -1;
  for (let j = 0; j < turns.length; j++) {
    const s = matchScore(e.prompt, turns[j].text);
    if (s > gBestScore) { gBestScore = s; gBestIdx = j; }
  }
  if (gBestIdx !== -1 && gBestScore >= GLOBAL_FLOOR) {
    knownDate[idx] = localDay(turns[gBestIdx].ts);
    if (gBestIdx > lastUsed) lastUsed = gBestIdx;
    matchedGlobal++;
  }
});

// --- interpolate anything still unmatched (no prompt, or too weak a match)
// from the nearest known date: forward-fill first (an undated entry most
// often belongs the same day as the one just before it), then back-fill any
// leading gap the forward pass couldn't reach (nothing dated comes before
// it, so borrow from the next entry that is). ---
const beforeFill = knownDate.slice();
let carry = null;
for (let i = 0; i < knownDate.length; i++) {
  if (knownDate[i] !== null) carry = knownDate[i];
  else if (carry !== null) knownDate[i] = carry;
}
carry = null;
for (let i = knownDate.length - 1; i >= 0; i--) {
  if (knownDate[i] !== null) carry = knownDate[i];
  else if (carry !== null) knownDate[i] = carry;
}
let interpolated = 0;
entries.forEach((e, i) => {
  if (e.needsDate && beforeFill[i] === null && knownDate[i] !== null) interpolated++;
});

// --- final monotonic cleanup: dates are YYYY-MM-DD strings, which sort
// chronologically under plain string comparison, so this is enough to
// detect and fix a global-fallback match that landed out of order. ---
for (let i = 1; i < knownDate.length; i++) {
  if (knownDate[i] !== null && knownDate[i - 1] !== null && knownDate[i] < knownDate[i - 1]) {
    knownDate[i] = knownDate[i - 1];
  }
}

// --- rewrite headings in memory, then write back only the files that changed ---
let enriched = 0;
entries.forEach((e, idx) => {
  if (!e.needsDate || knownDate[idx] === null) return;
  const m = e.heading.match(NUMBERED_PREFIX_RE);
  if (!m) return; // unexpected heading shape — leave untouched rather than guess
  perFile[e.fileIdx].lines[e.lineIdx] = `${m[1]}${knownDate[idx]} ${m[2]}`;
  enriched++;
});

let filesWritten = 0;
perFile.forEach((f) => {
  const updated = f.lines.join('\n');
  if (updated !== fs.readFileSync(f.path, 'utf8')) {
    fs.writeFileSync(f.path, updated);
    filesWritten++;
  }
});

const stillUndated = targets.length - enriched;
console.log(
  `enrich-log-dates: ${enriched} of ${targets.length} undated entries got a date `
  + `(${matchedMonotonic} matched in order, ${matchedGlobal} matched out of order, `
  + `${interpolated} interpolated from neighbors)`
  + `${stillUndated ? `, ${stillUndated} still undated — no date anywhere in the log could reach them` : ''} `
  + `across ${filesWritten} file(s).`,
);
