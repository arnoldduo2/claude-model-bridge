import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type BridgeConfig } from '../src/config.js';
import { RouteError, type RouteRequest } from '../src/routes/types.js';
import { antigravityRoute, buildAgyArgs, ensureReadOnlyAgent, READ_ONLY_TOOLS } from '../src/routes/antigravity.js';
import { defaultRoutes } from '../src/routes/index.js';
import { askWithFallback, formatFooter } from '../src/router.js';
import { formatStatus } from '../src/status.js';

const FAKE = path.join(import.meta.dirname, 'fake-agy.mjs');
const dirs: string[] = [];
function tmpDir(prefix = 'cmb-agy-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  delete process.env.FAKE_AGY_MODE;
  delete process.env.FAKE_AGY_PIDFILE;
});
afterEach(() => {
  delete process.env.FAKE_AGY_MODE;
  delete process.env.FAKE_AGY_PIDFILE;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function cfg(over: Partial<BridgeConfig['antigravity']> = {}): BridgeConfig {
  const c = loadConfig({ homeDir: tmpDir('cmb-agy-home-'), env: {} });
  c.antigravity.command = `"${process.execPath}" "${FAKE}"`;
  Object.assign(c.antigravity, over);
  return c;
}

function project(prefix = 'cmb-agy-proj-'): string {
  const d = tmpDir(prefix);
  fs.writeFileSync(path.join(d, 'readme.txt'), 'hello\n');
  return d;
}

function req(cwd: string, over: Partial<RouteRequest> = {}): RouteRequest {
  return { question: 'Where are database migrations defined?', task: 'explore', cwd, ...over };
}

const never = () => new AbortController().signal;

async function rejection(p: Promise<unknown>): Promise<RouteError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RouteError);
    return e as RouteError;
  }
  throw new Error('expected a RouteError');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('buildAgyArgs', () => {
  const agent = { name: 'cmb-readonly-0123456789abcdef', dir: path.join(os.tmpdir(), 'agy-workspace') };

  it('runs print mode with JSON output and the read-only agent, never auto-approve', () => {
    const args = buildAgyArgs('the prompt', agent);
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('the prompt');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    expect(args[args.indexOf('--agent') + 1]).toBe(agent.name);
    expect(args[args.indexOf('--add-dir') + 1]).toBe(agent.dir);
    expect(args).toContain('--disable-slash-commands');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args.some((a) => /dangerously|skip-permissions|always-proceed/i.test(a))).toBe(false);
    expect(args).not.toContain('--mode');
  });

  it('passes a model override', () => {
    const args = buildAgyArgs('p', agent, 'gemini-3.8-flash-low');
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.8-flash-low');
    expect(buildAgyArgs('p', agent)).not.toContain('--model');
  });
});

describe('read-only agent definition', () => {
  it('lives in the bridge home, lists only read tools, drops MCP and keeps a stable random name', () => {
    const home = tmpDir();
    const a = ensureReadOnlyAgent(home);
    expect(a.name).toMatch(/^cmb-readonly-[0-9a-f]{16}$/);
    expect(a.dir).toBe(path.join(home, 'agy-workspace'));
    const file = path.join(a.dir, '.agents', 'agents', `${a.name}.md`);
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain(`name: ${a.name}`);
    expect(text).toContain('inheritMcp: false');
    expect(text).toContain('commandExecutionPolicy: off');
    for (const t of READ_ONLY_TOOLS) expect(text).toContain(`  - ${t}`);
    expect(text).not.toMatch(/write_to_file|run_command|replace_file|call_mcp_tool/);
    // The only thing in the agent workspace is the agent file.
    expect(fs.readdirSync(a.dir)).toEqual(['.agents']);
    expect(ensureReadOnlyAgent(home).name).toBe(a.name);
    fs.writeFileSync(file, 'tampered');
    expect(ensureReadOnlyAgent(home).name).toBe(a.name);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('gets a different name on another install', () => {
    expect(ensureReadOnlyAgent(tmpDir()).name).not.toBe(ensureReadOnlyAgent(tmpDir()).name);
  });
});

describe('antigravityRoute', () => {
  it('parses answer field', async () => {
    process.env.FAKE_AGY_MODE = 'ok';
    const r = await antigravityRoute.ask(req(project()), cfg(), never());
    expect(r.text).toBe('Migrations are defined in db/migrate/001_init.sql:1');
    expect(r.model).toBe('agy');
  });

  it('reports the model override', async () => {
    process.env.FAKE_AGY_MODE = 'ok';
    const r = await antigravityRoute.ask(req(project(), { model: 'gemini-3.8-flash-low' }), cfg(), never());
    expect(r.model).toBe('gemini-3.8-flash-low');
  });

  it('sends the prompt without gathered file contents and with the secret-file rule', async () => {
    process.env.FAKE_AGY_MODE = 'args';
    const dir = project();
    fs.writeFileSync(path.join(dir, 'migrations.sql'), 'CREATE TABLE secret_marker_xyz (id int);');
    const r = await antigravityRoute.ask(req(dir), cfg(), never());
    const args = JSON.parse(r.text) as string[];
    const prompt = args[args.indexOf('-p') + 1];
    expect(prompt).toContain('Where are database migrations defined?');
    expect(prompt).toContain(dir);
    expect(prompt).toMatch(/\.env/);
    expect(prompt).toMatch(/credential/i);
    expect(prompt).not.toContain('secret_marker_xyz');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('waits on stdin → timeout, and kills the whole process tree', async () => {
    process.env.FAKE_AGY_MODE = 'hang';
    const pidFile = path.join(tmpDir(), 'pids.json');
    process.env.FAKE_AGY_PIDFILE = pidFile;
    const t0 = Date.now();
    const err = await rejection(antigravityRoute.ask(req(project()), cfg({ timeoutMs: 1500 }), never()));
    expect(err.kind).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(3000);
    const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as number[];
    expect(pids).toHaveLength(2);
    // taskkill may take a moment to reap the grandchild.
    for (let i = 0; i < 20 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
    for (const pid of pids) expect(alive(pid)).toBe(false);
  }, 10_000);

  it('aborting the signal kills the run as a timeout', async () => {
    process.env.FAKE_AGY_MODE = 'hang';
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const err = await rejection(antigravityRoute.ask(req(project()), cfg(), ac.signal));
    expect(err.kind).toBe('timeout');
  }, 10_000);

  it('signed out → auth', async () => {
    process.env.FAKE_AGY_MODE = 'signedout';
    const err = await rejection(antigravityRoute.ask(req(project()), cfg(), never()));
    expect(err.kind).toBe('auth');
    expect(err.message).toMatch(/log back in/i);
  });

  it('quota → rate_limit', async () => {
    process.env.FAKE_AGY_MODE = 'quota';
    const err = await rejection(antigravityRoute.ask(req(project()), cfg(), never()));
    expect(err.kind).toBe('rate_limit');
  });

  it('unknown agent → unavailable', async () => {
    process.env.FAKE_AGY_MODE = 'unknownagent';
    const err = await rejection(antigravityRoute.ask(req(project()), cfg(), never()));
    expect(err.kind).toBe('unavailable');
    expect(err.message).toMatch(/read-only agent/);
  });

  it('empty response → empty, naming denied actions', async () => {
    process.env.FAKE_AGY_MODE = 'empty';
    const err = await rejection(antigravityRoute.ask(req(project()), cfg(), never()));
    expect(err.kind).toBe('empty');
    expect(err.message).toContain('read_file');
  });

  it('unparseable output → other', async () => {
    process.env.FAKE_AGY_MODE = 'garbage';
    const err = await rejection(antigravityRoute.ask(req(project()), cfg(), never()));
    expect(err.kind).toBe('other');
  });

  it('cwd with spaces', async () => {
    process.env.FAKE_AGY_MODE = 'cwd';
    const dir = project('cmb agy proj with spaces ');
    expect(dir).toContain(' ');
    const r = await antigravityRoute.ask(req(dir), cfg(), never());
    expect(fs.realpathSync(r.text)).toBe(fs.realpathSync(dir));
  });

  it('writes nothing into the project folder', async () => {
    process.env.FAKE_AGY_MODE = 'ok';
    const dir = project();
    await antigravityRoute.ask(req(dir), cfg(), never());
    expect(fs.readdirSync(dir)).toEqual(['readme.txt']);
  });

  it('refuses a project that defines agy hooks', async () => {
    process.env.FAKE_AGY_MODE = 'ok';
    const dir = project();
    fs.mkdirSync(path.join(dir, '.agents'));
    fs.writeFileSync(path.join(dir, '.agents', 'hooks.json'), '{}');
    const err = await rejection(antigravityRoute.ask(req(dir), cfg(), never()));
    expect(err.kind).toBe('unavailable');
    expect(err.message).toMatch(/hooks/);
  });

  it('missing binary → not_configured', async () => {
    const c = cfg({ command: 'agy-does-not-exist' });
    const hint = antigravityRoute.configured(c);
    expect(hint).toMatch(/install/i);
    const err = await rejection(antigravityRoute.ask(req(project()), c, never()));
    expect(err.kind).toBe('not_configured');
  });

  it('a full path in antigravity.command is used as is', () => {
    expect(antigravityRoute.configured(cfg({ command: process.execPath }))).toBeNull();
    expect(antigravityRoute.configured(cfg({ command: path.join(tmpDir(), 'agy.exe') }))).toMatch(/install/i);
  });

  it('the fake command (quoted exe plus script) counts as configured', () => {
    expect(antigravityRoute.configured(cfg())).toBeNull();
  });
});

describe('antigravity in the default routes', () => {
  it('comes first', () => {
    expect(defaultRoutes().map((r) => r.name)).toEqual(['antigravity', 'gemini', 'openrouter']);
  });

  it('bridge_status reports it through configured()', () => {
    const c = cfg({ command: 'agy-does-not-exist' });
    const text = formatStatus(c, defaultRoutes());
    expect(text).toMatch(/^antigravity: not configured: [^\n]*install/m);
    expect(text).not.toContain('not available in this build');
  });

  it('a forced antigravity route that cannot be used is named in the footer', async () => {
    const c = cfg({ command: 'agy-does-not-exist' });
    const r = await askWithFallback({ ...req(project()), route: 'antigravity' }, defaultRoutes(), c);
    expect(r.ok).toBe(false);
    expect(r.attempts[0]).toMatchObject({ route: 'antigravity', outcome: 'not_configured' });
    expect(formatFooter(r)).toContain('requested antigravity: not configured');
  });
});
