// transcripts.mjs — shared extraction of real user turns from Claude Code
// transcript files (~/.claude/projects/<flattened-path>/*.jsonl). Used by
// backfill-from-history.mjs (recovering prompts before they age out) and
// check-log-coverage.mjs (auditing whether every prompt made it into the
// log) — both need the exact same definition of "a real thing the user
// said," so it lives here once instead of drifting between two copies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code flattens a project path into its transcript folder name by
 * replacing every non-alphanumeric character with '-'. */
export function transcriptDirFor(root) {
  const flattened = path.resolve(root).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', flattened);
}

// A "user" turn whose content is a plain string is a real human prompt. When
// content is an array instead, it's usually a tool_result being fed back in —
// a synthetic continuation, not something the user said — but a real prompt
// with an attachment (an image, say) also arrives as an array: a text block
// plus the attachment block(s), no tool_result. Treat the presence of a
// tool_result block as the actual signal, not "is it an array." Among real
// text, a handful of prefixes mark slash-command echoes and session-resume
// summaries rather than actual prompts.
const JUNK_PREFIXES = [
  '<command-name>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  'This session is being continued from a previous conversation',
];
const isJunk = (text) => JUNK_PREFIXES.some((p) => text.startsWith(p));

/** Pull the real prompt text out of a user message's content, or null if this
 * turn carries nothing a human actually typed (a tool_result continuation, or
 * an attachment with no caption). */
function extractUserText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    if (content.some((b) => b.type === 'tool_result')) return null;
    const textBlock = content.find((b) => b.type === 'text');
    return textBlock ? textBlock.text : null;
  }
  return null;
}

const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/** Parse one transcript file into its ordered real user turns:
 * { ts, text, files }[] — files are paths touched by Edit/Write/NotebookEdit
 * between this turn and the next. */
export function extractSessionTurns(filePath) {
  const turns = [];
  let currentTurn = null;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === 'user') {
      const text = extractUserText(rec.message && rec.message.content);
      if (text && text.trim() && !isJunk(text)) {
        currentTurn = { ts: rec.timestamp || null, text, files: [] };
        turns.push(currentTurn);
      }
      continue;
    }
    if (rec.type === 'assistant' && currentTurn) {
      const blocks = (rec.message && rec.message.content) || [];
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b.type === 'tool_use' && FILE_EDIT_TOOLS.has(b.name) && b.input && b.input.file_path
            && !currentTurn.files.includes(b.input.file_path)) {
            currentTurn.files.push(b.input.file_path);
          }
        }
      }
    }
  }
  return turns;
}

/** Parse every *.jsonl transcript in transcriptDir into
 * { sessionId, turns }[], sorted chronologically by each session's first
 * turn. Returns [] if the directory doesn't exist or has no real turns. */
export function extractAllSessions(transcriptDir) {
  const sessions = [];
  if (fs.existsSync(transcriptDir)) {
    for (const name of fs.readdirSync(transcriptDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const turns = extractSessionTurns(path.join(transcriptDir, name));
      if (turns.length) sessions.push({ sessionId: path.basename(name, '.jsonl'), turns });
    }
  }
  sessions.sort((a, b) => String(a.turns[0]?.ts || '').localeCompare(String(b.turns[0]?.ts || '')));
  return sessions;
}
