#!/usr/bin/env node
// cost-report.mjs — quick cost answer from session-log/usage/usage.jsonl,
// in dollars first (tokens are supporting detail, not the headline).
//
// Two views: totals by model, and totals by time window (today / last 7
// days / last 30 days / all time) — the window view is what
// usage/summary.md doesn't give you (it's day×model only), so this script
// exists specifically to answer "how's my spend trending" without Claude
// having to re-read a potentially multi-MB usage.jsonl to compute it live.
//
// "Today" is calendar-day, not Claude Code session ID: a Claude Code session
// ID persists across every resume of the same conversation, so a project
// worked on intermittently over months in one long-running thread would
// otherwise report the exact same number for "this session" as "all time" —
// a real bug this used to have. Calendar-day matches what a user actually
// means by "how much have I spent recently" and can never collide with
// "all time" on a project with more than one day of history.
//
// USAGE:
//   node _scripts/cost-report.mjs           # both tables, plain text
//   node _scripts/cost-report.mjs --root <dir>
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from './lib/paths.mjs';
import { loadUsageRows, localDay, fmt, money, windowTotal, PRICING_AS_OF } from './lib/usage.mjs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const P = resolvePaths(opt('--root') || path.resolve(SCRIPT_DIR, '..'));
const rows = loadUsageRows(P);

if (!rows.length) {
  console.log('No usage data yet — nothing has been harvested. Run node _scripts/usage-snapshot.mjs.');
  process.exit(0);
}

const total = windowTotal(rows, () => true);
const days = rows.map((r) => localDay(r.ts)).filter((d) => d !== 'unknown');
const firstDay = days.reduce((a, b) => (a < b ? a : b));
const lastDay = days.reduce((a, b) => (a > b ? a : b));

// --- by model ---
const byModel = new Map();
for (const r of rows) {
  if (!byModel.has(r.model)) byModel.set(r.model, { msgs: 0, cost: 0 });
  const a = byModel.get(r.model);
  a.msgs++; a.cost += r.cost_usd;
}
const modelRows = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);

console.log(`${money(total.cost)} total (API-equivalent, list prices as of ${PRICING_AS_OF}) across ${fmt(total.msgs)} messages, ${firstDay} – ${lastDay}.`);
for (const [model, a] of modelRows) {
  const pct = total.cost > 0 ? Math.round((a.cost / total.cost) * 100) : 0;
  console.log(`  ${model.padEnd(20)} ${money(a.cost).padStart(10)}  (${pct}%)`);
}

// --- heaviest day ---
const byDay = new Map();
for (const r of rows) {
  const d = localDay(r.ts);
  byDay.set(d, (byDay.get(d) || 0) + r.cost_usd);
}
const [heaviestDay, heaviestCost] = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
console.log(`Heaviest day: ${heaviestDay} (${money(heaviestCost)})`);

// --- by time window ---
const latestTs = rows.reduce((a, r) => (r.ts && r.ts > a ? r.ts : a), '');
const now = latestTs ? new Date(latestTs) : new Date();
const today = localDay(now);
const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

const windows = [
  ['Today', (r) => localDay(r.ts) === today],
  ['Last 7 days', (r) => r.ts >= daysAgo(7)],
  ['Last 30 days', (r) => r.ts >= daysAgo(30)],
  ['All time', () => true],
];

console.log('');
console.log('Cost over time:');
for (const [label, pred] of windows) {
  const w = windowTotal(rows, pred);
  console.log(`  ${label.padEnd(14)} ${fmt(w.msgs).padStart(7)} msgs   ${money(w.cost)}`);
}
if (firstDay === daysAgo(30).slice(0, 10) || new Date(firstDay) > new Date(daysAgo(30))) {
  console.log('  (this project is young enough that "last 30 days" and "all time" mostly overlap)');
}
