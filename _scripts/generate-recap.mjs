#!/usr/bin/env node
// generate-recap.mjs — renders session-log/YYYY-MM-DD-Recap.html: the main
// report back to the user. A single page combining cost (the same two
// tables cost-report.mjs prints) — deterministic assembly of what's already
// in the log; no narrative writing, no era inference. Milestones and key
// decisions are covered by the AI-authored "Milestones & capabilities
// timeline" and the log itself, not a standalone deterministic section here.
//
// Each run writes a file stamped with today's date, so recaps accumulate
// side by side in session-log/ instead of overwriting one another — running
// it again the same day overwrites that day's file, but different days
// produce separate files.
//
// USAGE:
//   node _scripts/generate-recap.mjs           # write session-log/YYYY-MM-DD-Recap.html
//   node _scripts/generate-recap.mjs --root <dir>
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from './lib/paths.mjs';
import { loadEntries, entryLabel } from './lib/log.mjs';
import { loadUsageRows, localDay, fmt, money, windowTotal, PRICING_AS_OF } from './lib/usage.mjs';

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
// --share produces a second, separate artifact (never the default) with every
// dollar figure swapped for its time or percentage equivalent — for sending a
// recap to someone else without disclosing what was actually spent. See
// RECAP.md's "Shareable version" section for when/how this gets invoked.
const SHARE = argv.includes('--share');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const P = resolvePaths(opt('--root') || path.resolve(SCRIPT_DIR, '..'));
const projectName = path.basename(P.ROOT);

const entries = loadEntries(P);
const usageRows = loadUsageRows(P);

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- cost: by model (progress-bar rows; share = pct of total, so it also sets bar width).
// In share mode the dollar figure is dropped and only the relative split remains — the
// underlying computation is identical, just one span is omitted. ---
function costByModelTable(share) {
  const byModel = new Map();
  let total = 0;
  for (const r of usageRows) {
    byModel.set(r.model, (byModel.get(r.model) || 0) + r.cost_usd);
    total += r.cost_usd;
  }
  if (!byModel.size) return '<p class="empty-note">No usage data yet.</p>';
  return [...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([m, cost]) => {
    const pct = total > 0 ? Math.round((cost / total) * 100) : 0;
    const costSpan = share ? '' : `<span class="cost-model-cost">${money(cost)}</span>`;
    return `<div class="cost-model-row">
      <div class="cost-model-head">
        <span class="cost-model-name">${escapeHtml(m)}</span>
        ${costSpan}
        <span class="cost-model-pct">${pct}%</span>
      </div>
      <div class="cost-model-track"><div class="cost-model-fill" style="width:${pct}%"></div></div>
    </div>`;
  }).join('\n')
    + (share ? '' : `<div class="cost-footnote">Costs are API-equivalent list-price value, not necessarily what was billed.</div>`);
}

// --- cost: by time window ---
// "Today" is calendar-day, not Claude Code session ID: a session ID persists
// across every resume of the same conversation, so a project worked on
// intermittently over months in one long-running thread would otherwise
// report the exact same figure for "this session" as "all time" — a real
// bug this used to have. Calendar-day matches what a user actually means by
// "how much have I spent recently."
function costByWindowTable() {
  if (!usageRows.length) return '<p class="empty-note">No usage data yet.</p>';
  const latestTs = usageRows.reduce((a, r) => (r.ts && r.ts > a ? r.ts : a), '');
  const now = latestTs ? new Date(latestTs) : new Date();
  const today = localDay(now);
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();
  const windows = [
    ['Today', (r) => localDay(r.ts) === today],
    ['Last 7 days', (r) => r.ts >= daysAgo(7)],
    ['Last 30 days', (r) => r.ts >= daysAgo(30)],
    ['All time', () => true],
  ];
  return windows.map(([label, pred]) => {
    const w = windowTotal(usageRows, pred);
    return `<div class="cost-window-row"><span class="cost-window-name">${label}</span><span class="cost-window-cost">${money(w.cost)}</span></div>`;
  }).join('\n');
}

// --- hours: by time window (share-mode replacement for costByWindowTable) ---
// Entries don't carry a session id the way harvested usage rows do, but that's
// moot now — "Today" is calendar-day everywhere in this file, so this matches
// costByWindowTable's definition exactly rather than merely approximating it.
function hoursByWindowTable() {
  const daily = buildDailyData();
  if (!daily.length) return '<p class="empty-note">No entries yet.</p>';
  const latestTs = usageRows.reduce((a, r) => (r.ts && r.ts > a ? r.ts : a), '');
  const today = latestTs ? localDay(latestTs) : daily[daily.length - 1].date;
  const now = latestTs ? new Date(latestTs) : new Date();
  const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString().slice(0, 10);
  const windows = [
    ['Today', (d) => d.date === today],
    ['Last 7 days', (d) => d.date >= daysAgo(7)],
    ['Last 30 days', (d) => d.date >= daysAgo(30)],
    ['All time', () => true],
  ];
  return windows.map(([label, pred]) => {
    const hrs = daily.filter(pred).reduce((s, d) => s + d.hours, 0);
    return `<div class="cost-window-row"><span class="cost-window-name">${label}</span><span class="cost-window-cost">${hrs.toFixed(1)}h</span></div>`;
  }).join('\n');
}

// --- helpers for daily grouping ---

/** Format "YYYY-MM-DD" as "Jun 10" (display only), or "Jun 10, 2026" with withYear.
 * Never used as a lookup key — the ISO string itself (e.g. "2026-06-10") is the key
 * everywhere IDs/hrefs/data attributes need to match, since two different years can
 * otherwise both render as "Jun 10" and collide. */
function shortDate(ymd, withYear) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [y, m, d] = ymd.split('-');
  const base = `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
  return withYear ? `${base}, ${y}` : base;
}

/** Format "YYYY-MM-DD" as full date like "June 10, 2025" */
function fullDate(ymd) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const [y, m, d] = ymd.split('-');
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

/** Parse "HH:MM" to fractional hours since midnight */
function timeToHours(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h + m / 60;
}

/** Build per-day data structure used by dailyBars, dayPanels, and JS output */
function buildDailyData() {
  // Group entries by date
  const byDay = new Map();
  for (const e of entries) {
    const d = e.date || 'undated';
    if (d === 'undated') continue;
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }

  // Group usage by date
  const usageByDay = new Map();
  for (const r of usageRows) {
    const d = localDay(r.ts);
    if (d === 'unknown') continue;
    usageByDay.set(d, (usageByDay.get(d) || 0) + r.cost_usd);
  }

  // Per-entry rate for days whose token usage was never harvested. Rather than
  // a flat constant, derive this project's OWN measured average — total measured
  // cost divided by entries on days that have usage — so an estimated day
  // inherits this project's real intensity and model mix instead of an arbitrary
  // guess. Fall back to $8/entry only when there's no measured usage anywhere to
  // derive from (a brand-new project, or one whose transcripts all aged out).
  const FALLBACK_PER_ENTRY = 8;
  let measuredCost = 0;
  let measuredEntries = 0;
  for (const d of byDay.keys()) {
    if (usageByDay.has(d)) {
      measuredCost += usageByDay.get(d);
      measuredEntries += byDay.get(d).length;
    }
  }
  const perEntryEstimate = measuredEntries > 0 ? measuredCost / measuredEntries : FALLBACK_PER_ENTRY;

  // Build sorted array of days
  const days = [...byDay.keys()].sort();
  const result = [];
  for (const d of days) {
    const dayEntries = byDay.get(d);
    const count = dayEntries.length;
    const estimated = !usageByDay.has(d);
    const cost = estimated ? count * perEntryEstimate : usageByDay.get(d);

    // Compute hours from start/end times
    let hours = 0;
    for (const e of dayEntries) {
      const s = timeToHours(e.start);
      const en = timeToHours(e.end);
      if (s !== null && en !== null && en > s) {
        hours += en - s;
      }
    }

    result.push({ date: d, entries: dayEntries, count, cost, hours, estimated });
  }
  return result;
}

// --- daily cost chart ---
// Returns three separate pieces: the bars (which live INSIDE the flex row
// `.cost-chart`), and the axis + legend, which must render as siblings OUTSIDE
// that flex row — if they're placed inside `.cost-chart` they become flex items
// and stack to the right of the bars instead of below them.
function dailyChart(share) {
  const daily = buildDailyData();
  if (!daily.length) {
    // Entries can exist but still produce zero dated days — a log migrated
    // from the pre-v2 numbered heading format (`### #N — ...`) has content
    // but no date in any heading until enrich-log-dates.mjs runs. Tell the
    // user what happened and how to fix it, rather than a bare empty state
    // that reads as "there's nothing here yet."
    const msg = entries.length
      ? 'No dated entries yet — the log&rsquo;s entries use the pre-v2 heading format without dates. Say &ldquo;backfill dates&rdquo; to enrich them from transcript history.'
      : 'No dated entries yet.';
    return { bars: `<p class="empty-note">${msg}</p>`, axis: '', legend: '' };
  }

  // Share mode scales and labels bars by hours, not cost — sizing the bars by
  // cost while labeling them with hours would still visually leak the relative
  // cost shape even with the dollar figure itself removed.
  const metric = share ? 'hours' : 'cost';
  const maxVal = Math.max(...daily.map((d) => d[metric]));
  const peak = daily.reduce((a, b) => (b[metric] > a[metric] ? b : a));

  const bars = daily.map((d, idx) => {
    const pct = maxVal > 0 ? Math.max(6, Math.round((d[metric] / maxVal) * 100)) : 6;
    const dom = parseInt(d.date.split('-')[2], 10);
    const hoursStr = d.hours > 0 ? `${d.hours.toFixed(1)}h` : '—';
    const barLabel = share ? hoursStr : `${d.estimated ? '~$' : '$'}${Math.round(d.cost)}`;
    const tip = share
      ? `${shortDate(d.date, true)} · ${hoursStr} · ${d.count} entries`
      : `${shortDate(d.date, true)} · ${money(d.cost)}${d.estimated ? ' (est.)' : ''} · ${d.count} entries · ${hoursStr} · ${d.estimated ? 'est. cost' : 'cost'}`;

    return `<a class="cost-bar-wrap" href="#panel-${d.date}" data-day="${d.date}" data-idx="${idx}" title="${escapeHtml(tip)}">
  <div class="cost-bar-cost">${barLabel}</div>
  <div class="cost-bar${d.estimated && !share ? ' estimated-bar' : ''}" style="height:${pct}%"></div>
  <div class="cost-bar-label">${dom}</div>
</a>`;
  }).join('\n');

  // Hatching flags an *estimated* figure — hours are always directly measured
  // from logged start/end times, never estimated, so this note is meaningless
  // (and the hatching itself misleading) in share mode.
  let legend = '';
  if (!share) {
    const hasEstimated = daily.some((d) => d.estimated);
    if (hasEstimated) {
      // Every estimated day's cost is count × the same per-entry rate, so recover
      // that rate from any estimated day (cost/count) rather than recomputing it.
      const estDay = daily.find((d) => d.estimated && d.count > 0);
      const perEntry = estDay ? Math.round(estDay.cost / estDay.count) : 8;
      const anyMeasured = daily.some((d) => !d.estimated);
      const basis = anyMeasured
        ? `this project's measured average (~$${perEntry}/entry)`
        : `a $${perEntry}/entry placeholder`;
      legend = `<div class="chart-legend-note">Hatched bars are estimated at ${basis} — no usage data was harvested for those days</div>`;
    }
  }

  // Add date axis: first day … peak day … last day
  const peakStr = share ? `${peak.hours.toFixed(1)}h` : money(peak.cost);
  const axis = `<div class="date-axis"><span>${shortDate(daily[0].date)}</span><span>peak ${shortDate(peak.date)} · ${peakStr}</span><span>${shortDate(daily[daily.length - 1].date)}</span></div>`;
  return { bars, axis, legend };
}

// --- no-JS day panels ---
function dayPanels(share) {
  const daily = buildDailyData();
  if (!daily.length) return '';

  return daily.map((d) => {
    const full = fullDate(d.date);
    const costStr = (d.estimated ? '~$' : '$') + Math.round(d.cost);
    const hrsStr = d.hours > 0 ? ` · ${d.hours.toFixed(1)}h logged` : '';
    const primaryStat = share ? (d.hours > 0 ? `${d.hours.toFixed(1)}h` : '—') : costStr;
    const metaStr = share ? `${d.count} entries` : `${d.count} entries${hrsStr}${d.estimated ? ' · estimated' : ''}`;

    const entryItems = d.entries.map((e) => {
      const label = entryLabel(e.heading);
      const timeStr = e.start && e.end ? ` <span class="entry-meta">${e.start}–${e.end}</span>` : '';
      return `<div class="entry-item">
        <div class="entry-dot"></div>
        <div class="entry-text"><div class="entry-desc">${escapeHtml(label)}</div>${timeStr}</div>
      </div>`;
    }).join('\n');

    return `<div id="panel-${d.date}" class="day-panel-target">
  <a href="#page" class="panel-bg" aria-label="Close"></a>
  <div class="panel-fg">
    <div class="panel-header">
      <div>
        <div class="panel-date">${full}</div>
        <div class="panel-stats"><span class="panel-cost">${primaryStat}</span><span class="panel-meta">${metaStr}</span></div>
      </div>
      <a href="#page" class="panel-close-link" aria-label="Close">&times;</a>
    </div>
    <div class="panel-body">
      ${entryItems}
    </div>
  </div>
</div>`;
  }).join('\n');
}

// --- JS data for interactive enhancement ---
// Both objects below are keyed by the ISO date ("2026-06-10"), matching
// dayKeys/dayIndexToKey in the template — never the display label, which
// collides across years ("Jun 10" says nothing about which June).
// In share mode the cost field is omitted from the data entirely, not just
// hidden from view — it's read straight out of this script tag by anyone who
// opens dev tools or view-source, so hiding the rendered `$` label alone
// wouldn't actually withhold it.
function dailyDataJs(share) {
  const daily = buildDailyData();
  const items = daily.map((d) => {
    const costField = share ? '' : `c:${Math.round(d.cost)},`;
    return `{key:"${d.date}",n:${d.count},${costField}h:${Math.round(d.hours * 10) / 10},e:${d.estimated ? 1 : 0}}`;
  }).join(',\n  ');
  if (share) {
    const maxHours = daily.length ? Math.round(Math.max(...daily.map((d) => d.hours)) * 10) / 10 : 0;
    return `var dailyData = [\n  ${items}\n];\nvar maxHours = ${maxHours};`;
  }
  const maxCost = daily.length ? Math.round(Math.max(...daily.map((d) => d.cost))) : 0;
  return `var dailyData = [\n  ${items}\n];\nvar maxCost = ${maxCost};`;
}

function entriesJs() {
  const daily = buildDailyData();
  const dayStrings = daily.map((d) => {
    const items = d.entries.map((e) => {
      const desc = entryLabel(e.heading).replace(/"/g, '\\"');
      return `"${desc}"`;
    }).join(',');
    return `"${d.date}": [${items}]`;
  }).join(',\n');
  return `var E = {\n${dayStrings}\n};`;
}

function startDateJs() {
  const dates = entries.map((e) => e.date).filter(Boolean).sort();
  if (!dates.length) return 'var startDate = new Date();';
  const [y, m, d] = dates[0].split('-').map(Number);
  return `var startDate = new Date(${y}, ${m - 1}, ${d});`;
}

function totalDaysJs() {
  const dates = entries.map((e) => e.date).filter(Boolean).sort();
  if (dates.length < 2) return `var totalDays = ${dates.length};`;
  const first = new Date(dates[0]);
  const last = new Date(dates[dates.length - 1]);
  const diff = Math.round((last - first) / 86400000) + 1;
  return `var totalDays = ${diff};`;
}

// --- hours estimate ---
function hoursEstimate() {
  let totalHours = 0;
  for (const e of entries) {
    const s = timeToHours(e.start);
    const en = timeToHours(e.end);
    if (s !== null && en !== null && en > s) {
      totalHours += en - s;
    }
  }
  if (totalHours === 0) return '—';
  return `${totalHours.toFixed(1)}h`;
}

// --- AI section placeholders ---
function aiPlaceholder() {
  return `<p class="empty-note" style="margin-top:16px;">This section is generated by Claude when you ask for a full recap. Run the script first, then ask Claude to fill in the analysis sections.</p>`;
}

function workstreamsPlaceholder() { return aiPlaceholder(); }
function timelinePlaceholder() { return aiPlaceholder(); }
function patternsPlaceholder() { return aiPlaceholder(); }
function findingsPlaceholder() { return aiPlaceholder(); }
function threeThingsPlaceholder() { return aiPlaceholder(); }

const dates = entries.map((e) => e.date).filter(Boolean);
const dateRange = dates.length
  ? `${fullDate(dates.reduce((a, b) => (a < b ? a : b)))} – ${fullDate(dates.reduce((a, b) => (a > b ? a : b)))}`
  : 'no dated entries yet';
const dayCount = new Set(dates).size;
const totalCost = usageRows.reduce((s, r) => s + r.cost_usd, 0);

const chart = dailyChart(SHARE);
const generatedDate = new Date().toISOString().slice(0, 10);

const primaryStat = SHARE
  ? ''
  : `<div class="stat"><div class="stat-value">${usageRows.length ? money(totalCost) : '—'}</div><div class="stat-label">Total spend</div></div>`;
const chartHoverDefault = SHARE
  ? `Bar height = hours logged that day. Tap a bar to open that day's log.`
  : `Bar height = spend that day. Tap a bar to open that day's log.`;
const costSectionHeading = SHARE ? 'Time &amp; activity' : 'Cost &amp; time';
const costMethodologyNote = SHARE
  ? `<p><strong>Time, not cost.</strong> This is the shareable version of a recap that otherwise reports cost — every dollar figure has been replaced with the time-based or relative-share equivalent (hours instead of spend, percentage instead of amount) so it can be sent to someone else without disclosing what was actually spent. The private version has the full cost breakdown.</p>`
  : `<p><strong>Cost.</strong> Per-message token usage priced at published API list rates (as of ${escapeHtml(PRICING_AS_OF)}) — <em>not necessarily what was billed</em> — then summed by model, by time window, and by day. Daily bars are real sums of that day's messages, not a day total split evenly across requests. Days whose usage was never harvested are estimated by carrying this project's own measured average cost-per-entry across that day's entries (hatched bars); with no measured data anywhere to derive from, they fall back to a flat $8/entry placeholder chosen as a reasonable assumption.</p>`;
const shareBadge = SHARE
  ? `<div class="share-badge">Shareable version — dollar figures replaced with time spent</div>`
  : '';

const templatePath = path.join(SCRIPT_DIR, '..', 'assets', 'recap-template.html');
let html = fs.readFileSync(templatePath, 'utf8');
html = html
  .replaceAll('{{PROJECT_NAME}}', escapeHtml(projectName))
  .replaceAll('{{DATE_RANGE}}', escapeHtml(dateRange))
  .replaceAll('{{GENERATED_DATE}}', generatedDate)
  .replaceAll('{{PRICING_AS_OF}}', escapeHtml(PRICING_AS_OF))
  .replace('{{ENTRY_COUNT}}', fmt(entries.length))
  .replace('{{PRIMARY_STAT}}', primaryStat)
  .replace('{{DAY_COUNT}}', fmt(dayCount))
  .replace('{{COST_BY_MODEL_TABLE}}', costByModelTable(SHARE))
  .replace('{{COST_BY_WINDOW_TABLE}}', SHARE ? hoursByWindowTable() : costByWindowTable())
  .replace('{{COST_SECTION_HEADING}}', costSectionHeading)
  .replace('{{COST_METHODOLOGY_NOTE}}', costMethodologyNote)
  .replace('{{CHART_HOVER_DEFAULT}}', chartHoverDefault)
  .replace('{{SHARE_BADGE}}', shareBadge)
  .replaceAll('{{SHARE_MODE}}', SHARE ? 'true' : 'false')
  .replace('{{DAILY_BARS}}', chart.bars)
  .replace('{{DAILY_AXIS}}', chart.axis)
  .replace('{{DAILY_LEGEND}}', chart.legend)
  .replace('{{DAY_PANELS}}', dayPanels(SHARE))
  .replace('{{DAILY_DATA_JS}}', dailyDataJs(SHARE))
  .replace('{{ENTRIES_JS}}', entriesJs())
  .replace('{{START_DATE_JS}}', startDateJs())
  .replace('{{TOTAL_DAYS_JS}}', totalDaysJs())
  .replace('{{HOURS_ESTIMATE}}', hoursEstimate())
  .replace('{{WORKSTREAMS_SECTION}}', workstreamsPlaceholder())
  .replace('{{TIMELINE_SECTION}}', timelinePlaceholder())
  .replace('{{PATTERNS_SECTION}}', patternsPlaceholder())
  .replace('{{FINDINGS_SECTION}}', findingsPlaceholder())
  .replace('{{THREE_THINGS_SECTION}}', threeThingsPlaceholder());

const recapFile = path.join(P.LOG_DIR, `${generatedDate}-Recap${SHARE ? '-Shared' : ''}.html`);
fs.mkdirSync(P.LOG_DIR, { recursive: true });
fs.writeFileSync(recapFile, html);
console.log(`Wrote ${recapFile} (${entries.length} entries)`);
