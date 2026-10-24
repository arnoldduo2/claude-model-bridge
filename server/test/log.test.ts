import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type BridgeConfig } from '../src/config.js';
import { appendLog, readLog, type LogEntry } from '../src/log.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-log-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function cfg(fullText = false): BridgeConfig {
  const c = loadConfig({ homeDir: tmpDir(), env: {} });
  c.log.fullText = fullText;
  return c;
}

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: '2026-10-15T12:00:00.000Z',
    project: 'C:/proj',
    task: 'ask',
    question: 'what?',
    attempts: [{ route: 'gemini', outcome: 'ok', ms: 5 }],
    ok: true,
    inChars: 5,
    outChars: 10,
    ms: 5,
    ...over,
  };
}

function lines(file: string): string[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

describe('appendLog', () => {
  it('appends jsonl to the month file', () => {
    const c = cfg();
    appendLog(c, entry());
    appendLog(c, entry({ question: 'second' }));
    const file = path.join(c.homeDir, 'logs', '2026-10.jsonl');
    const l = lines(file);
    expect(l).toHaveLength(2);
    expect(JSON.parse(l[1]).question).toBe('second');
  });

  it('uses the entry timestamp (UTC) for the month file', () => {
    const c = cfg();
    appendLog(c, entry({ ts: '2026-11-30T23:59:59.000Z' }));
    appendLog(c, entry({ ts: '2027-01-01T00:00:00.000Z' }));
    expect(fs.existsSync(path.join(c.homeDir, 'logs', '2026-11.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(c.homeDir, 'logs', '2027-01.jsonl'))).toBe(true);
  });

  it('truncates question to 200', () => {
    const c = cfg();
    appendLog(c, entry({ question: 'x'.repeat(500) }));
    const [e] = readLog(c, 1);
    expect(e.question).toHaveLength(200);
  });

  it('omits full text unless log.fullText', () => {
    const off = cfg(false);
    appendLog(off, entry({ fullQuestion: 'FQ', fullAnswer: 'FA' }));
    const raw = fs.readFileSync(path.join(off.homeDir, 'logs', '2026-10.jsonl'), 'utf8');
    expect(raw).not.toContain('fullQuestion');
    expect(raw).not.toContain('fullAnswer');

    const on = cfg(true);
    appendLog(on, entry({ fullQuestion: 'FQ', fullAnswer: 'FA' }));
    const [e] = readLog(on, 1);
    expect(e.fullQuestion).toBe('FQ');
    expect(e.fullAnswer).toBe('FA');
  });

  it('never writes API keys', () => {
    const c = cfg();
    c.gemini.apiKey = 'AIzaSECRETKEY123456';
    c.openrouter.apiKey = 'sk-or-SECRET987654';
    appendLog(
      c,
      entry({
        question: 'use AIzaSECRETKEY123456 please',
        attempts: [{ route: 'gemini', outcome: 'other', detail: 'bad sk-or-SECRET987654', ms: 1 }],
      }),
    );
    const raw = fs.readFileSync(path.join(c.homeDir, 'logs', '2026-10.jsonl'), 'utf8');
    expect(raw).not.toContain('AIzaSECRETKEY123456');
    expect(raw).not.toContain('sk-or-SECRET987654');
  });

  it('never writes inside project cwd', () => {
    const c = cfg();
    const proj = tmpDir();
    appendLog(c, entry({ project: proj }));
    expect(fs.readdirSync(proj)).toEqual([]);
  });

  it('never throws if the log cannot be written', () => {
    const c = cfg();
    fs.writeFileSync(path.join(c.homeDir, 'logs'), 'a file where the dir should be');
    expect(() => appendLog(c, entry())).not.toThrow();
  });
});

describe('readLog', () => {
  it('returns newest first, filtered by project', () => {
    const c = cfg();
    appendLog(c, entry({ ts: '2026-10-01T00:00:00.000Z', project: 'A', question: 'a1' }));
    appendLog(c, entry({ ts: '2026-10-02T00:00:00.000Z', project: 'B', question: 'b1' }));
    appendLog(c, entry({ ts: '2026-10-03T00:00:00.000Z', project: 'A', question: 'a2' }));
    expect(readLog(c, 10).map((e) => e.question)).toEqual(['a2', 'b1', 'a1']);
    expect(readLog(c, 10, 'A').map((e) => e.question)).toEqual(['a2', 'a1']);
    expect(readLog(c, 1).map((e) => e.question)).toEqual(['a2']);
  });

  it('reads across month files, newest month first', () => {
    const c = cfg();
    appendLog(c, entry({ ts: '2026-09-30T00:00:00.000Z', question: 'sep' }));
    appendLog(c, entry({ ts: '2026-10-01T00:00:00.000Z', question: 'oct' }));
    expect(readLog(c, 5).map((e) => e.question)).toEqual(['oct', 'sep']);
  });

  it('tolerates a missing log dir', () => {
    expect(readLog(cfg(), 5)).toEqual([]);
  });

  it('skips malformed lines', () => {
    const c = cfg();
    appendLog(c, entry({ question: 'good' }));
    const file = path.join(c.homeDir, 'logs', '2026-10.jsonl');
    fs.appendFileSync(file, 'not json\n{"half":\n');
    expect(readLog(c, 5).map((e) => e.question)).toEqual(['good']);
  });
});
