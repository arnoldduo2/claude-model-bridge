import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type BridgeConfig, type RouteName } from '../src/config.js';
import { RouteError, type Route, type RouteRequest, type RouteResult } from '../src/routes/types.js';
import { askWithFallback, formatFooter, type BridgeAnswer } from '../src/router.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-router-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function cfg(over: Partial<BridgeConfig> = {}): BridgeConfig {
  const c = loadConfig({ homeDir: tmpDir(), env: {} });
  return Object.assign(c, over);
}

type Behavior = RouteResult | Error | ((signal: AbortSignal) => Promise<RouteResult>);
function fake(name: RouteName, behavior: Behavior, hint: string | null = null) {
  const ask = vi.fn(async (_req: RouteRequest, _cfg: BridgeConfig, signal: AbortSignal): Promise<RouteResult> => {
    if (typeof behavior === 'function') return behavior(signal);
    if (behavior instanceof Error) throw behavior;
    return behavior;
  });
  const route: Route = { name, configured: () => hint, ask };
  return { route, ask };
}

const req: RouteRequest = { question: 'q?', task: 'ask', cwd: 'C:/proj' };
const ok = (model: string): RouteResult => ({ text: `answer from ${model}`, model });
const T0 = 1_000_000;

describe('askWithFallback', () => {
  it('first ok wins', async () => {
    const a = fake('antigravity', ok('agy'));
    const b = fake('gemini', ok('m'));
    const r = await askWithFallback(req, [a.route, b.route], cfg(), () => T0);
    expect(r.ok).toBe(true);
    expect(r.route).toBe('antigravity');
    expect(r.model).toBe('agy');
    expect(r.text).toBe('answer from agy');
    expect(r.attempts).toHaveLength(1);
    expect(r.attempts[0].outcome).toBe('ok');
    expect(b.ask).not.toHaveBeenCalled();
  });

  it('timeout falls back', async () => {
    const a = fake('antigravity', new RouteError('timeout', 'took too long'));
    const b = fake('gemini', ok('m'));
    const r = await askWithFallback(req, [a.route, b.route], cfg(), () => T0);
    expect(r.ok).toBe(true);
    expect(r.route).toBe('gemini');
    expect(r.attempts[0]).toMatchObject({ route: 'antigravity', outcome: 'timeout', detail: 'took too long' });
    expect(r.attempts[1].outcome).toBe('ok');
  });

  it('not_configured skipped silently, no cooldown written', async () => {
    const c = cfg();
    const a = fake('antigravity', ok('agy'), 'install agy');
    const b = fake('gemini', ok('m'));
    const r = await askWithFallback(req, [a.route, b.route], c, () => T0);
    expect(r.ok).toBe(true);
    expect(r.route).toBe('gemini');
    expect(r.attempts[0]).toMatchObject({ route: 'antigravity', outcome: 'not_configured', detail: 'install agy' });
    expect(a.ask).not.toHaveBeenCalled();
    const state = path.join(c.homeDir, 'state.json');
    if (fs.existsSync(state)) expect(JSON.parse(fs.readFileSync(state, 'utf8'))).toEqual({});
  });

  it('429 sets cooldown and next call skips; cooldown expires', async () => {
    const c = cfg();
    const a = fake('antigravity', new RouteError('rate_limit', '429', 30_000));
    const b = fake('gemini', ok('m'));
    await askWithFallback(req, [a.route, b.route], c, () => T0);
    expect(a.ask).toHaveBeenCalledTimes(1);
    const state = JSON.parse(fs.readFileSync(path.join(c.homeDir, 'state.json'), 'utf8'));
    expect(state.antigravity).toBe(T0 + 30_000);

    const second = await askWithFallback(req, [a.route, b.route], c, () => T0 + 1000);
    expect(second.attempts[0]).toMatchObject({ route: 'antigravity', outcome: 'cooldown' });
    expect(second.route).toBe('gemini');
    expect(a.ask).toHaveBeenCalledTimes(1);

    await askWithFallback(req, [a.route, b.route], c, () => T0 + 31_000);
    expect(a.ask).toHaveBeenCalledTimes(2);
  });

  it('rate_limit without retryAfterMs uses cfg.cooldownMs', async () => {
    const c = cfg();
    const a = fake('antigravity', new RouteError('rate_limit', '429'));
    const b = fake('gemini', ok('m'));
    await askWithFallback(req, [a.route, b.route], c, () => T0);
    const state = JSON.parse(fs.readFileSync(path.join(c.homeDir, 'state.json'), 'utf8'));
    expect(state.antigravity).toBe(T0 + c.cooldownMs);
  });

  it('corrupt state.json is treated as empty', async () => {
    const c = cfg();
    fs.mkdirSync(c.homeDir, { recursive: true });
    fs.writeFileSync(path.join(c.homeDir, 'state.json'), '{not json');
    const a = fake('antigravity', ok('agy'));
    const r = await askWithFallback(req, [a.route], c, () => T0);
    expect(r.ok).toBe(true);
  });

  it('creates homeDir when missing', async () => {
    const c = cfg();
    c.homeDir = path.join(c.homeDir, 'nested', 'home');
    const a = fake('antigravity', new RouteError('rate_limit', '429', 1000));
    await askWithFallback(req, [a.route], c, () => T0);
    expect(fs.existsSync(path.join(c.homeDir, 'state.json'))).toBe(true);
  });

  it('all fail: ok false, one line per route, plus the instruction line', async () => {
    const a = fake('antigravity', new RouteError('timeout', 'slow'));
    const b = fake('gemini', new RouteError('auth', 'HTTP 401'));
    const o = fake('openrouter', ok('x'), 'set OPENROUTER_API_KEY');
    const r = await askWithFallback(req, [a.route, b.route, o.route], cfg(), () => T0);
    expect(r.ok).toBe(false);
    expect(r.route).toBeUndefined();
    const lines = r.text.split('\n');
    expect(lines.some((l) => l.includes('antigravity') && l.includes('timeout'))).toBe(true);
    expect(lines.some((l) => l.includes('gemini') && l.includes('auth'))).toBe(true);
    expect(lines.some((l) => l.includes('openrouter') && l.includes('not_configured'))).toBe(true);
    expect(lines).toContain('Do this task yourself and tell the user the bridge was unavailable.');
    expect(r.attempts).toHaveLength(3);
  });

  it('forced route is tried first, then falls back', async () => {
    const a = fake('antigravity', ok('agy'));
    const o = fake('openrouter', new RouteError('unavailable', 'HTTP 503'));
    const r = await askWithFallback({ ...req, route: 'openrouter' }, [a.route, o.route], cfg(), () => T0);
    expect(r.attempts[0].route).toBe('openrouter');
    expect(r.attempts[0].outcome).toBe('unavailable');
    expect(r.route).toBe('antigravity');
    expect(r.attempts.filter((x) => x.route === 'openrouter')).toHaveLength(1);
    expect(formatFooter(r)).toMatch(/via antigravity.*openrouter: unavailable/);
  });

  it('a forced route missing from this build is reported, not silently replaced', async () => {
    const g = fake('gemini', ok('m'));
    const r = await askWithFallback({ ...req, route: 'antigravity' }, [g.route], cfg(), () => T0);
    expect(r.ok).toBe(true);
    expect(r.route).toBe('gemini');
    expect(r.requested).toBe('antigravity');
    expect(r.attempts[0]).toMatchObject({ route: 'antigravity', outcome: 'not_configured', detail: 'not available in this build' });
    expect(formatFooter(r)).toMatch(/via gemini \(m\) · requested antigravity: not available in this build/);
  });

  it('a forced route that is not configured stays in the footer', async () => {
    const g = fake('gemini', ok('m'), 'Set GEMINI_API_KEY');
    const o = fake('openrouter', ok('x'));
    const r = await askWithFallback({ ...req, route: 'gemini' }, [g.route, o.route], cfg(), () => T0);
    expect(r.route).toBe('openrouter');
    expect(formatFooter(r)).toContain('requested gemini: not configured');
    const auto = await askWithFallback(req, [g.route, o.route], cfg(), () => T0);
    expect(formatFooter(auto)).not.toContain('requested');
  });

  it('when every route is not configured the failure says how to set one up', async () => {
    const g = fake('gemini', ok('m'), 'Set GEMINI_API_KEY');
    const r = await askWithFallback({ ...req, route: 'antigravity' }, [g.route], cfg(), () => T0);
    expect(r.ok).toBe(false);
    expect(r.text).toContain('Run /model-bridge:bridge-setup to configure a route.');
    const mixed = await askWithFallback(req, [g.route, fake('openrouter', new RouteError('timeout', 'slow')).route], cfg(), () => T0);
    expect(mixed.text).not.toContain('bridge-setup');
  });

  it('a model override goes only to the forced route, never to fallbacks', async () => {
    const a = fake('antigravity', ok('agy'));
    const o = fake('openrouter', new RouteError('unavailable', 'HTTP 503'));
    await askWithFallback({ ...req, route: 'openrouter', model: 'pick/me:free' }, [a.route, o.route], cfg(), () => T0);
    expect(o.ask.mock.calls[0][0].model).toBe('pick/me:free');
    expect(a.ask.mock.calls[0][0]).not.toHaveProperty('model');
  });

  it('without a forced route the model override goes to the first route called only', async () => {
    const a = fake('antigravity', ok('agy'), 'install agy');
    const g = fake('gemini', new RouteError('timeout', 'slow'));
    const o = fake('openrouter', ok('x'));
    await askWithFallback({ ...req, model: 'gemini-x' }, [a.route, g.route, o.route], cfg(), () => T0);
    expect(g.ask.mock.calls[0][0].model).toBe('gemini-x');
    expect(o.ask.mock.calls[0][0]).not.toHaveProperty('model');
  });

  it('records the answering model on the ok attempt', async () => {
    const r = await askWithFallback(req, [fake('gemini', ok('gemini-4-flash')).route], cfg(), () => T0);
    expect(r.attempts[0]).toMatchObject({ route: 'gemini', outcome: 'ok', model: 'gemini-4-flash' });
  });

  it("route 'auto' behaves as default order", async () => {
    const a = fake('antigravity', ok('agy'));
    const r = await askWithFallback({ ...req, route: 'auto' }, [a.route], cfg(), () => T0);
    expect(r.route).toBe('antigravity');
  });

  it('only tries routes in cfg.routeOrder', async () => {
    const c = cfg({ routeOrder: ['gemini'] });
    const a = fake('antigravity', ok('agy'));
    const b = fake('gemini', ok('m'));
    const r = await askWithFallback(req, [a.route, b.route], c, () => T0);
    expect(r.route).toBe('gemini');
    expect(a.ask).not.toHaveBeenCalled();
  });

  it('follows cfg.routeOrder rather than the order routes were passed', async () => {
    const a = fake('antigravity', ok('agy'));
    const b = fake('gemini', ok('m'));
    const c = cfg({ routeOrder: ['gemini', 'antigravity'] });
    const r = await askWithFallback(req, [a.route, b.route], c, () => T0);
    expect(r.route).toBe('gemini');
  });

  it('non-RouteError exceptions are recorded as other and never thrown', async () => {
    const a = fake('antigravity', new TypeError('boom'));
    const b = fake('gemini', ok('m'));
    const r = await askWithFallback(req, [a.route, b.route], cfg(), () => T0);
    expect(r.attempts[0]).toMatchObject({ outcome: 'other', detail: 'boom' });
    expect(r.route).toBe('gemini');
  });

  it('passes an AbortSignal with the route timeout and strips the route field', async () => {
    const c = cfg();
    c.antigravity.timeoutMs = 5000;
    const a = fake('antigravity', ok('agy'));
    const spy = vi.spyOn(AbortSignal, 'timeout');
    await askWithFallback({ ...req, route: 'auto' }, [a.route], c, () => T0);
    expect(spy).toHaveBeenCalledWith(5000);
    const [passed, , signal] = a.ask.mock.calls[0];
    expect(passed).not.toHaveProperty('route');
    expect(signal).toBeInstanceOf(AbortSignal);
    spy.mockRestore();
  });

  it('a route that ignores its signal is cut off as timeout', async () => {
    const c = cfg();
    c.antigravity.timeoutMs = 20;
    const a = fake('antigravity', () => new Promise<RouteResult>(() => {}));
    const b = fake('gemini', ok('m'));
    const r = await askWithFallback(req, [a.route, b.route], c);
    expect(r.attempts[0].outcome).toBe('timeout');
    expect(r.route).toBe('gemini');
  });
});

describe('formatFooter', () => {
  it('lists fallbacks and duration', () => {
    const a: BridgeAnswer = {
      ok: true,
      text: 't',
      route: 'gemini',
      model: 'm',
      ms: 12_400,
      attempts: [
        { route: 'antigravity', outcome: 'timeout', ms: 100 },
        { route: 'gemini', outcome: 'ok', ms: 100 },
      ],
    };
    const f = formatFooter(a);
    expect(f).toMatch(/via gemini \(m\).*antigravity: timeout/);
    expect(f).toContain('12.4s');
  });

  it('omits not_configured routes and the fallbacks section when nothing failed', () => {
    const a: BridgeAnswer = {
      ok: true,
      text: 't',
      route: 'gemini',
      model: 'm',
      ms: 1000,
      attempts: [
        { route: 'antigravity', outcome: 'not_configured', ms: 0 },
        { route: 'gemini', outcome: 'ok', ms: 10 },
      ],
    };
    const f = formatFooter(a);
    expect(f).not.toContain('fallbacks');
    expect(f).not.toContain('not_configured');
  });
});
