import fs from 'node:fs';
import path from 'node:path';
import type { BridgeConfig, RouteName } from './config.js';
import {
  RouteError,
  type FailureKind,
  type Route,
  type RouteRequest,
  type RouteResult,
} from './routes/types.js';

export interface Attempt {
  route: RouteName;
  outcome: 'ok' | FailureKind | 'cooldown';
  detail?: string;
  /** The model that answered (successful attempts only). */
  model?: string;
  ms: number;
}

export interface BridgeAnswer {
  ok: boolean;
  text: string;
  route?: RouteName;
  model?: string;
  /** The route the caller forced, if any. */
  requested?: RouteName;
  attempts: Attempt[];
  ms: number;
}

export const UNAVAILABLE_LINE = 'Do this task yourself and tell the user the bridge was unavailable.';
export const SETUP_LINE = 'Run /model-bridge:bridge-setup to configure a route.';
export const NOT_IN_BUILD = 'not available in this build';

type CooldownState = Partial<Record<RouteName, number>>;

function statePath(cfg: BridgeConfig): string {
  return path.join(cfg.homeDir, 'state.json');
}

/** A missing or corrupt state file is treated as empty; this never throws. */
function readState(cfg: BridgeConfig): CooldownState {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statePath(cfg), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: CooldownState = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key as RouteName] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function setCooldown(cfg: BridgeConfig, route: RouteName, until: number, nowMs: number): void {
  try {
    // Re-read so a concurrent bridge process' cooldowns are not clobbered; drop expired ones while here.
    const state: CooldownState = {};
    for (const [name, t] of Object.entries(readState(cfg))) {
      if ((t as number) > nowMs) state[name as RouteName] = t;
    }
    state[route] = until;
    fs.mkdirSync(cfg.homeDir, { recursive: true });
    fs.writeFileSync(statePath(cfg), JSON.stringify(state), 'utf8');
  } catch {
    // Cooldowns are an optimisation; failing to persist one must not fail the request.
  }
}

function plan(req: RouteRequest & { route?: RouteName | 'auto' }, routes: Route[], cfg: BridgeConfig): Route[] {
  const byName = new Map(routes.map((r) => [r.name, r] as const));
  const names: RouteName[] = [...new Set(cfg.routeOrder)].filter((n) => byName.has(n));
  if (req.route && req.route !== 'auto' && byName.has(req.route)) {
    names.splice(0, names.length, req.route, ...names.filter((n) => n !== req.route));
  }
  return names.map((n) => byName.get(n) as Route);
}

/** Calls route.ask and also enforces the deadline for routes that ignore their signal. */
function callRoute(route: Route, req: RouteRequest, cfg: BridgeConfig, signal: AbortSignal): Promise<RouteResult> {
  return new Promise<RouteResult>((resolve, reject) => {
    const onAbort = () => reject(new RouteError('timeout', 'no response before the route timeout'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    let pending: Promise<RouteResult>;
    try {
      pending = route.ask(req, cfg, signal);
    } catch (err) {
      signal.removeEventListener('abort', onAbort);
      reject(err);
      return;
    }
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function failureText(attempts: Attempt[]): string {
  const lines = ['The model bridge could not get an answer from any route:'];
  if (attempts.length === 0) lines.push('- no routes are enabled');
  for (const a of attempts) lines.push(`- ${a.route}: ${a.outcome}${a.detail ? ` (${a.detail})` : ''}`);
  lines.push(UNAVAILABLE_LINE);
  if (attempts.length > 0 && attempts.every((a) => a.outcome === 'not_configured')) lines.push(SETUP_LINE);
  return lines.join('\n');
}

export async function askWithFallback(
  req: RouteRequest & { route?: RouteName | 'auto' },
  routes: Route[],
  cfg: BridgeConfig,
  now: () => number = Date.now,
): Promise<BridgeAnswer> {
  const started = now();
  const { route: forcedRaw, model, ...baseReq } = req;
  const forced = forcedRaw && forcedRaw !== 'auto' ? forcedRaw : undefined;
  const cooldowns = readState(cfg);
  const attempts: Attempt[] = [];
  const answer = (a: Omit<BridgeAnswer, 'attempts' | 'ms' | 'requested'>): BridgeAnswer => ({
    ...a,
    ...(forced ? { requested: forced } : {}),
    attempts,
    ms: now() - started,
  });

  if (forced && !routes.some((r) => r.name === forced)) {
    attempts.push({ route: forced, outcome: 'not_configured', detail: NOT_IN_BUILD, ms: 0 });
  }

  // A model override names a model of one route, so it goes only to the forced route, or to the first route
  // actually called when none is forced. Fallback routes use their own configured models.
  let overrideUsed = false;

  for (const route of plan(req, routes, cfg)) {
    const t0 = now();
    const elapsed = () => now() - t0;

    const hint = route.configured(cfg);
    if (hint) {
      attempts.push({ route: route.name, outcome: 'not_configured', detail: hint, ms: elapsed() });
      continue;
    }

    const until = cooldowns[route.name];
    if (until !== undefined && until > t0) {
      attempts.push({ route: route.name, outcome: 'cooldown', detail: `until ${new Date(until).toISOString()}`, ms: elapsed() });
      continue;
    }

    const useOverride = model !== undefined && !overrideUsed && (forced ? route.name === forced : true);
    overrideUsed = true;
    const routeReq: RouteRequest = useOverride ? { ...baseReq, model } : baseReq;

    try {
      const signal = AbortSignal.timeout(cfg[route.name].timeoutMs);
      const result = await callRoute(route, routeReq, cfg, signal);
      attempts.push({ route: route.name, outcome: 'ok', model: result.model, ms: elapsed() });
      return answer({ ok: true, text: result.text, route: route.name, model: result.model });
    } catch (err) {
      if (err instanceof RouteError) {
        attempts.push({ route: route.name, outcome: err.kind, detail: err.message, ms: elapsed() });
        if (err.kind === 'rate_limit') {
          const wait = err.retryAfterMs !== undefined && err.retryAfterMs > 0 ? err.retryAfterMs : cfg.cooldownMs;
          const nowMs = now();
          cooldowns[route.name] = nowMs + wait;
          setCooldown(cfg, route.name, nowMs + wait, nowMs);
        }
      } else {
        attempts.push({ route: route.name, outcome: 'other', detail: err instanceof Error ? err.message : String(err), ms: elapsed() });
      }
    }
  }

  return answer({ ok: false, text: failureText(attempts) });
}

/** e.g. "— via gemini (gemini-4-flash) · fallbacks: antigravity: timeout · 12.4s" */
export function formatFooter(a: BridgeAnswer): string {
  const parts: string[] = [];
  parts.push(a.ok && a.route ? `— via ${a.route}${a.model ? ` (${a.model})` : ''}` : '— bridge unavailable');
  // A forced route that could not be used is always named, so the user knows their choice was not honoured.
  const requested = a.requested ? a.attempts.find((x) => x.route === a.requested) : undefined;
  if (requested?.outcome === 'not_configured') {
    parts.push(`requested ${requested.route}: ${requested.detail === NOT_IN_BUILD ? NOT_IN_BUILD : 'not configured'}`);
  }
  // Other unconfigured routes are skipped silently; they are not failures worth reporting.
  const failed = a.attempts.filter((x) => x.outcome !== 'ok' && x.outcome !== 'not_configured');
  if (failed.length > 0) parts.push(`fallbacks: ${failed.map((x) => `${x.route}: ${x.outcome}`).join(', ')}`);
  parts.push(`${(a.ms / 1000).toFixed(1)}s`);
  return parts.join(' · ');
}
