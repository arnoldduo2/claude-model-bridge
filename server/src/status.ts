import fs from 'node:fs';
import path from 'node:path';
import type { BridgeConfig, RouteName } from './config.js';
import { readLog, type LogEntry } from './log.js';
import type { Route } from './routes/types.js';

const HANDOFF_SCAN_LIMIT = 100_000;

/** Remaining cooldown seconds per route from <homeDir>/state.json. A missing or corrupt file means no cooldowns. */
function readCooldowns(cfg: BridgeConfig, nowMs: number): Partial<Record<RouteName, number>> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(cfg.homeDir, 'state.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Partial<Record<RouteName, number>> = {};
    for (const [name, until] of Object.entries(parsed)) {
      if (typeof until === 'number' && Number.isFinite(until) && until > nowMs) {
        out[name as RouteName] = Math.ceil((until - nowMs) / 1000);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The route that produced the answer for a logged call, if any. */
function answeringRoute(e: LogEntry): RouteName | undefined {
  return e.attempts.find((a) => a.outcome === 'ok')?.route;
}

function handoffsToday(cfg: BridgeConfig, now: Date): Partial<Record<RouteName, number>> {
  const today = localDay(now);
  const counts: Partial<Record<RouteName, number>> = {};
  for (const e of readLog(cfg, HANDOFF_SCAN_LIMIT)) {
    const when = new Date(e.ts);
    if (Number.isNaN(when.getTime()) || localDay(when) !== today) continue;
    const route = answeringRoute(e);
    if (route) counts[route] = (counts[route] ?? 0) + 1;
  }
  return counts;
}

export function formatStatus(cfg: BridgeConfig, routes: Route[], now: Date = new Date()): string {
  const byName = new Map(routes.map((r) => [r.name, r] as const));
  const cooldowns = readCooldowns(cfg, now.getTime());
  const handoffs = handoffsToday(cfg, now);

  const lines: string[] = [];
  for (const name of [...new Set(cfg.routeOrder)]) {
    const route = byName.get(name);
    const hint = route ? route.configured(cfg) : 'not available in this build';
    const parts = [hint ? `not configured: ${hint}` : '✓ configured'];
    const cooling = cooldowns[name];
    if (cooling !== undefined) parts.push(`cooldown ${cooling}s`);
    const n = handoffs[name] ?? 0;
    parts.push(`${n} handoff${n === 1 ? '' : 's'} today`);
    lines.push(`${name}: ${parts.join(' · ')}`);
  }
  if (lines.length === 0) lines.push('no routes enabled in routeOrder');
  lines.push(`Route order: ${cfg.routeOrder.join(' → ')}`);
  lines.push(`Config file: ${path.join(cfg.homeDir, 'config.json')}`);
  return lines.join('\n');
}

/** Compact table, newest first: time, route (model), outcome, first 80 chars of the question. */
export function formatLog(entries: LogEntry[]): string {
  if (entries.length === 0) return 'No handoffs logged yet.';
  return entries
    .map((e) => {
      const d = new Date(e.ts);
      const time = Number.isNaN(d.getTime()) ? e.ts : `${localDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const okAttempt = e.attempts.find((x) => x.outcome === 'ok');
      const route = okAttempt ? `${okAttempt.route}${okAttempt.model ? ` (${okAttempt.model})` : ''}` : '-';
      const outcome = e.ok ? 'ok' : (e.attempts.at(-1)?.outcome ?? 'failed');
      const question = e.question.replace(/\s+/g, ' ').slice(0, 80);
      return `${time} | ${route} | ${outcome} | ${question}`;
    })
    .join('\n');
}
