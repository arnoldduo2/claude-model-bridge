import fs from 'node:fs';
import path from 'node:path';
import type { BridgeConfig } from './config.js';
import type { TaskKind } from './routes/types.js';
import type { Attempt } from './router.js';

export interface LogEntry {
  ts: string;
  project: string;
  task: TaskKind;
  question: string;
  attempts: Attempt[];
  ok: boolean;
  inChars: number;
  outChars: number;
  ms: number;
  fullQuestion?: string;
  fullAnswer?: string;
}

const QUESTION_MAX = 200;
const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;

function logDir(cfg: BridgeConfig): string {
  return path.join(cfg.homeDir, 'logs');
}

/** YYYY-MM from the entry's own ISO timestamp (UTC). Falls back to now if ts is unparseable. */
function monthOf(ts: string): string {
  const d = new Date(ts);
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  return date.toISOString().slice(0, 7);
}

function redact(text: string, cfg: BridgeConfig): string {
  let out = text;
  for (const key of [cfg.gemini.apiKey, cfg.openrouter.apiKey]) {
    if (!key) continue;
    // The key may appear JSON-escaped inside the serialized line.
    out = out.split(JSON.stringify(key).slice(1, -1)).join('[redacted]');
  }
  return out;
}

/** Appends one JSON line to <homeDir>/logs/YYYY-MM.jsonl. Logging must never break a request, so failures are swallowed. */
export function appendLog(cfg: BridgeConfig, e: LogEntry): void {
  try {
    const record: LogEntry = { ...e, question: e.question.slice(0, QUESTION_MAX) };
    if (cfg.log.fullText) {
      if (e.fullQuestion === undefined) delete record.fullQuestion;
      if (e.fullAnswer === undefined) delete record.fullAnswer;
    } else {
      delete record.fullQuestion;
      delete record.fullAnswer;
    }
    const dir = logDir(cfg);
    fs.mkdirSync(dir, { recursive: true });
    const line = redact(JSON.stringify(record), cfg);
    fs.appendFileSync(path.join(dir, `${monthOf(e.ts)}.jsonl`), line + '\n', 'utf8');
  } catch {
    // ignore
  }
}

function parseEntry(line: string): LogEntry | null {
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    if (typeof o.ts !== 'string' || typeof o.project !== 'string') return null;
    return v as LogEntry;
  } catch {
    return null;
  }
}

/** Newest first, optionally limited to one project. Reads older month files until `n` entries are found. */
export function readLog(cfg: BridgeConfig, n: number, project?: string): LogEntry[] {
  if (n <= 0) return [];
  let files: string[];
  try {
    files = fs.readdirSync(logDir(cfg)).filter((f) => MONTH_FILE.test(f));
  } catch {
    return [];
  }
  files.sort().reverse();

  const out: LogEntry[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(logDir(cfg), file), 'utf8');
    } catch {
      continue;
    }
    const entries: LogEntry[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const entry = parseEntry(line);
      if (entry && (project === undefined || entry.project === project)) entries.push(entry);
    }
    // Reverse first so that ties on ts keep latest-appended first, then stable-sort by ts.
    entries.reverse().sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    out.push(...entries);
    if (out.length >= n) break;
  }
  return out.slice(0, n);
}
