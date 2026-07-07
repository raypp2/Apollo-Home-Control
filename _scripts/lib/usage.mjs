// usage.mjs — shared usage.jsonl loading + formatting, used by
// usage-snapshot.mjs, cost-report.mjs, and generate-recap.mjs.
import fs from 'node:fs';

// The pricing table lives in usage-snapshot.mjs (the only place it's applied),
// but the as-of date is shared here so every script that surfaces cost can
// disclose it without duplicating — update this alongside that table.
export const PRICING_AS_OF = '2026-07';

export function loadUsageRows(P) {
  if (!fs.existsSync(P.USAGE_FILE)) return [];
  const rows = [];
  for (const line of fs.readFileSync(P.USAGE_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r._comment) continue;
      rows.push(r);
    } catch { /* skip corrupt line */ }
  }
  return rows;
}

export function localDay(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const fmt = (n) => n.toLocaleString('en-US');
export const money = (n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Sum {msgs, cost} for rows matching a predicate. */
export function windowTotal(rows, predicate) {
  let msgs = 0, cost = 0;
  for (const r of rows) if (predicate(r)) { msgs++; cost += r.cost_usd; }
  return { msgs, cost };
}
