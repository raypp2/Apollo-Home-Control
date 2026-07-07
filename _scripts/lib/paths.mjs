// paths.mjs — single source of truth for the session-log/ folder layout.
// Every script in this family (archive, usage-snapshot, cost-report,
// backfill-from-history, check-log-coverage, generate-recap) imports this
// instead of hardcoding paths, so they can't drift out of sync with each
// other.
//
//   session-log/
//     session-log.md       live entries + auto-generated header/index
//     archive/*.md          rolled-off older entries, chunked by date range
//     coverage.md            gaps between transcripts and logged prompts
//     usage/usage.jsonl      one row per Claude Code assistant message
//     usage/summary.md        human-readable cost rollup
//     usage/.state.json        harvest bookkeeping (mtimes + debounce stamp)
//     usage/.coverage-state.json  coverage-check debounce stamp
//     usage/.archive-state.json   auto-archive debounce stamp
//     .workstreams.json         cached workstream classification (see generate-recap.mjs)
//     YYYY-MM-DD-Recap.html     generated overview (cost + milestones + decisions), one
//                                 per generation day — generate-recap.mjs builds the
//                                 filename itself since it depends on today's date
import path from 'node:path';

export function resolvePaths(root) {
  const ROOT = path.resolve(root);
  const LOG_DIR = path.join(ROOT, 'session-log');
  const USAGE_DIR = path.join(LOG_DIR, 'usage');
  return {
    ROOT,
    LOG_DIR,
    LIVE_FILE: path.join(LOG_DIR, 'session-log.md'),
    ARCHIVE_DIR: path.join(LOG_DIR, 'archive'),
    USAGE_DIR,
    USAGE_FILE: path.join(USAGE_DIR, 'usage.jsonl'),
    SUMMARY_FILE: path.join(USAGE_DIR, 'summary.md'),
    STATE_FILE: path.join(USAGE_DIR, '.state.json'),
    WORKSTREAMS_FILE: path.join(LOG_DIR, '.workstreams.json'),
    BACKFILL_SOURCE_FILE: path.join(LOG_DIR, '.backfill-source.json'),
    COVERAGE_FILE: path.join(LOG_DIR, 'coverage.md'),
    COVERAGE_STATE_FILE: path.join(USAGE_DIR, '.coverage-state.json'),
    ARCHIVE_STATE_FILE: path.join(USAGE_DIR, '.archive-state.json'),
  };
}
