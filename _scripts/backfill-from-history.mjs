#!/usr/bin/env node
// backfill-from-history.mjs — extracts real user prompts (verbatim, timestamped)
// and the files touched after each one, from this project's Claude Code
// transcripts — for Claude to turn into session-log entries when /showcase-log
// is set up on a project that was already being worked on before logging
// existed.
//
// WHY: transcripts are the only surviving record of a project's pre-logging
// history, and Claude Code deletes them after ~30 days (cleanupPeriodDays) —
// on top of that, very long sessions get compacted, summarizing away exact
// wording even within that window. Once either happens the original prompts
// are gone for good. This recovers what it can before that happens, same
// reasoning as usage-snapshot.mjs's exact-token harvesting, applied to
// prompts instead of costs.
//
// DIVISION OF LABOR: this script only extracts (mechanical, deterministic) —
// it does not decide entry boundaries, write Outcome/Key Decisions, or infer
// which turns belong together. Claude reads the JSON this writes and drafts
// the actual session-log.md entries (see ../BACKFILL.md) — the same split as
// generate-recap.mjs's deterministic base + Claude-authored AI sections. The
// transcript-parsing itself lives in lib/transcripts.mjs, shared with
// check-log-coverage.mjs so both agree on what counts as "a real prompt."
//
// USAGE:
//   node _scripts/backfill-from-history.mjs             # write extraction
//   node _scripts/backfill-from-history.mjs --report    # print counts only
//   --root <dir>         project root (default: parent of this script's dir)
//   --transcripts <dir>  transcript dir override (default: derived from root)
//
// OUTPUT: session-log/.backfill-source.json — sessions in chronological
// order, each with its ordered real user turns (verbatim text + timestamp)
// and the file paths touched by Edit/Write/NotebookEdit before the next
// turn. Scratch input, not part of the log — delete it once entries are
// drafted (see BACKFILL.md).
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from './lib/paths.mjs';
import { transcriptDirFor, extractAllSessions } from './lib/transcripts.mjs';

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

const sessions = extractAllSessions(TRANSCRIPT_DIR);
const totalTurns = sessions.reduce((n, s) => n + s.turns.length, 0);

if (REPORT) {
  console.log(
    `backfill-from-history: ${sessions.length} session(s), ${totalTurns} recoverable `
    + `user turn(s) at ${TRANSCRIPT_DIR}`,
  );
  process.exit(0);
}

if (!sessions.length) {
  console.log(
    `backfill-from-history: no transcript folder or no recoverable turns at `
    + `${TRANSCRIPT_DIR} — nothing to backfill.`,
  );
  process.exit(0);
}

fs.mkdirSync(P.LOG_DIR, { recursive: true });
fs.writeFileSync(
  P.BACKFILL_SOURCE_FILE,
  JSON.stringify({ generated: new Date().toISOString(), sessions }, null, 2),
);
console.log(
  `backfill-from-history: wrote ${sessions.length} session(s), ${totalTurns} user turn(s) `
  + `to ${P.BACKFILL_SOURCE_FILE}`,
);
