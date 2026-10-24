import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type BridgeConfig } from '../src/config.js';
import { RouteError, type RouteRequest } from '../src/routes/types.js';
import {
  agyEnv,
  antigravityRoute,
  buildAgyArgs,
  classifyAgyError,
  commandLineLength,
  ensureReadOnlyAgent,
  projectCustomizationProblem,
  READ_ONLY_TOOLS,
  resetAgyCache,
} from '../src/routes/antigravity.js';
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
  resetAgyCache();
  delete process.env.FAKE_AGY_MODE;
  delete process.env.FAKE_AGY_PIDFILE;
  delete process.env.FAKE_AGY_VERSION;
});
afterEach(() => {
  delete process.env.FAKE_AGY_MODE;
  delete process.env.FAKE_AGY_PIDFILE;
  delete process.env.FAKE_AGY_VERSION;
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
    expect(text).not.toMatch(/write_to_file|run_command|replace_file|call_mcp_tool|grep_search/);
    expect([...READ_ONLY_TOOLS]).toEqual(['view_file', 'list_dir', 'find_by_name']);
    // The agent workspace holds only the .agents folder: the agent, the guard hook and its script.
    expect(fs.readdirSync(a.dir)).toEqual(['.agents']);
    expect(fs.readdirSync(path.join(a.dir, '.agents')).sort()).toEqual(['agents', 'cmb-guard.mjs', 'hooks.json']);
    expect(ensureReadOnlyAgent(home).name).toBe(a.name);
    fs.writeFileSync(file, 'tampered');
    expect(ensureReadOnlyAgent(home).name).toBe(a.name);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('installs a PreToolUse guard hook with a command agy can run (no quotes, relative script)', () => {
    const home = tmpDir('cmb agy home with spaces ');
    const a = ensureReadOnlyAgent(home, 'file:///C:/some%20where/bridge.mjs');
    const hooks = JSON.parse(fs.readFileSync(path.join(a.dir, '.agents', 'hooks.json'), 'utf8'));
    const entry = hooks['claude-model-bridge-guard'].PreToolUse[0];
    expect(entry.matcher).toBe('*');
    expect(entry.hooks[0].command).toBe('node cmb-guard.mjs');
    const script = fs.readFileSync(path.join(a.dir, '.agents', 'cmb-guard.mjs'), 'utf8');
    expect(script).toContain('"file:///C:/some%20where/bridge.mjs"');
    expect(script).toContain('runAgyGuard');
    expect(script).toMatch(/catch[\s\S]*deny/);
    // Repaired when tampered with.
    fs.writeFileSync(path.join(a.dir, '.agents', 'hooks.json'), '{}');
    ensureReadOnlyAgent(home, 'file:///C:/some%20where/bridge.mjs');
    expect(JSON.parse(fs.readFileSync(path.join(a.dir, '.agents', 'hooks.json'), 'utf8'))).toEqual(hooks);
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

  it('a full path in antigravity.command is used as is (and version-checked)', () => {
    // node.exe is a real file but reports v24.x, which is not a tested agy version.
    expect(antigravityRoute.configured(cfg({ command: process.execPath }))).toMatch(/not a version the bridge was tested with/);
    expect(antigravityRoute.configured(cfg({ command: path.join(tmpDir(), 'agy.exe') }))).toMatch(/install/i);
  });

  it('the fake command (quoted exe plus script) counts as configured', () => {
    expect(antigravityRoute.configured(cfg())).toBeNull();
  });

  it.each([
    ['2.0.0', false],
    ['1.3.9', false],
    ['0.9.1', false],
    ['1.4.0', true],
    ['1.9.12', true],
  ])('agy version %s is accepted: %s', (version, ok) => {
    process.env.FAKE_AGY_VERSION = version;
    const hint = antigravityRoute.configured(cfg());
    if (ok) expect(hint).toBeNull();
    else expect(hint).toMatch(new RegExp(`${version.replace(/\./g, '\\.')} is not a version the bridge was tested with`));
  });

  it('unreadable version output → not configured', () => {
    process.env.FAKE_AGY_VERSION = 'garbage';
    expect(antigravityRoute.configured(cfg())).toMatch(/could not read the Antigravity CLI version/);
  });

  it('caches the version check', async () => {
    const c = cfg();
    expect(antigravityRoute.configured(c)).toBeNull();
    process.env.FAKE_AGY_VERSION = '2.0.0';
    expect(antigravityRoute.configured(c)).toBeNull();
    resetAgyCache();
    expect(antigravityRoute.configured(c)).toMatch(/not a version/);
    const err = await rejection(antigravityRoute.ask(req(project()), c, never()));
    expect(err.kind).toBe('not_configured');
  });

  it('not logged in → auth', async () => {
    process.env.FAKE_AGY_MODE = 'notloggedin';
    const err = await rejection(antigravityRoute.ask(req(project()), cfg(), never()));
    expect(err.kind).toBe('auth');
    expect(classifyAgyError('You are not logged into Antigravity.')).toBe('auth');
    expect(classifyAgyError('Session logged out')).toBe('auth');
    expect(classifyAgyError('design in progress')).toBe('other');
  });

  it('passes agy an environment without API keys, with the project and node on PATH', async () => {
    process.env.FAKE_AGY_MODE = 'env';
    const saved = { g: process.env.GEMINI_API_KEY, o: process.env.OPENROUTER_API_KEY, x: process.env.CMB_TEST_HOLDS_KEY };
    // Built from parts so the secret scanner does not flag the test itself.
    process.env.GEMINI_API_KEY = ['AIza', 'Sy', 'F'.repeat(33)].join('');
    process.env.OPENROUTER_API_KEY = ['sk', 'or', 'v1', 'f'.repeat(24)].join('-');
    process.env.CMB_TEST_HOLDS_KEY = 'prefix-cfgkey-0123456789-suffix';
    try {
      const c = cfg();
      c.gemini.apiKey = 'cfgkey-0123456789';
      const dir = project();
      const r = await antigravityRoute.ask(req(dir), c, never());
      const env = JSON.parse(r.text) as Record<string, string>;
      const names = Object.keys(env).map((k) => k.toUpperCase());
      expect(names).not.toContain('GEMINI_API_KEY');
      expect(names).not.toContain('OPENROUTER_API_KEY');
      expect(names).not.toContain('CMB_TEST_HOLDS_KEY');
      expect(JSON.stringify(env)).not.toContain('cfgkey-0123456789');
      expect(env.CMB_AGY_PROJECT).toBe(dir);
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') as string;
      expect(env[pathKey].split(path.delimiter)[0]).toBe(path.dirname(process.execPath));
    } finally {
      for (const [k, v] of [['GEMINI_API_KEY', saved.g], ['OPENROUTER_API_KEY', saved.o], ['CMB_TEST_HOLDS_KEY', saved.x]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('agyEnv does not let the caller pre-set the guard project', () => {
    const env = agyEnv(cfg(), 'C:/proj', 'C:/node', { CMB_AGY_PROJECT: 'C:/elsewhere', Path: 'C:/bin' });
    expect(env.CMB_AGY_PROJECT).toBe('C:/proj');
    expect(env.Path).toBe(['C:/node', 'C:/bin'].join(path.delimiter));
  });

  it('refuses a question too long for the command line', async () => {
    process.env.FAKE_AGY_MODE = 'ok';
    const err = await rejection(antigravityRoute.ask(req(project(), { question: 'x'.repeat(33_000) }), cfg(), never()));
    expect(err.kind).toBe('other');
    expect(err.message).toMatch(/too long for the agy command line \(\d+ characters, limit 32000\)/);
  });

  it('measures the quoted command line, not just the prompt', () => {
    expect(commandLineLength('agy', ['-p', 'a b'])).toBe('agy -p "a b"'.length);
    expect(commandLineLength('agy', ['say "hi"'])).toBe('agy "say \\"hi\\""'.length);
    expect(commandLineLength('C:\\Program Files\\agy.exe', ['x\\'])).toBe('"C:\\Program Files\\agy.exe" x\\'.length);
    expect(commandLineLength('agy', ['a b\\'])).toBe('agy "a b\\\\"'.length);
  });
});

describe('project customizations agy would load', () => {
  function write(file: string, text = '{}') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  function repo(): { root: string; app: string } {
    const root = tmpDir('cmb-agy-repo-');
    fs.mkdirSync(path.join(root, '.git'));
    const app = path.join(root, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'readme.txt'), 'hi');
    return { root, app };
  }

  it.each([
    ['.agents/hooks.json'],
    ['.agent/hooks.json'],
    ['_agents/hooks.json'],
    ['_agent/hooks.json'],
    ['.agents/plugins/probe/hooks.json'],
    ['.agents/plugins.json'],
    ['.agents/mcp_config.json'],
    ['.agent/mcp_config.json'],
  ])('refuses %s in the project', (rel) => {
    const { app } = repo();
    write(path.join(app, rel));
    expect(projectCustomizationProblem(app)).toContain(path.join(app, rel.split('/').slice(0, 2).join('/')));
  });

  it.each([['_agents/hooks.json'], ['.agent/plugins/x/plugin.json'], ['.agents/mcp_config.json']])(
    'refuses %s in a parent folder (repo root and above)',
    (rel) => {
      const { root, app } = repo();
      write(path.join(root, rel));
      expect(projectCustomizationProblem(app)).toBeTruthy();
      // Also above the repository root.
      const outer = tmpDir('cmb-agy-outer-');
      const nested = path.join(outer, 'repo', 'app');
      fs.mkdirSync(path.join(outer, 'repo', '.git'), { recursive: true });
      fs.mkdirSync(nested, { recursive: true });
      write(path.join(outer, rel));
      expect(projectCustomizationProblem(nested)).toBeTruthy();
    },
  );

  it.each([
    ['.agents/skills.json', '{"inherits": ["../../elsewhere"]}'],
    ['.agents/agents.json', '{"entries": [{"path": "C:/x"}]}'],
    ['_agent/skills.json', '{ "entries" : [] }'],
  ])('refuses %s that points elsewhere', (rel, text) => {
    const { app } = repo();
    write(path.join(app, rel), text);
    expect(projectCustomizationProblem(app)).toBe(path.join(app, rel));
  });

  it.each([
    ['hooks:\n  PreToolUse: []'],
    ['plugins:\n  - x'],
    ['mcpServers:\n  - name: x'],
  ])('refuses an agent definition with %s', (line) => {
    const { app } = repo();
    const f = path.join(app, '.agents', 'agents', 'helper', 'agent.md');
    write(f, `---\nname: helper\ndescription: d\n${line}\n---\n# System Prompt\nhi\n`);
    expect(projectCustomizationProblem(app)).toBe(f);
  });

  it('allows harmless customizations (rules, skills, plain agents, plain skills.json)', () => {
    const { app } = repo();
    write(path.join(app, '.agents', 'rules', 'style.md'), '# rules');
    write(path.join(app, '.agents', 'skills', 's', 'SKILL.md'), '---\nname: s\ndescription: d\n---\nbody');
    write(path.join(app, '.agents', 'skills.json'), '{"skills": []}');
    write(path.join(app, '.agents', 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: d\ntools:\n  - view_file\n---\n# hooks: in the body is fine\n');
    expect(projectCustomizationProblem(app)).toBeNull();
  });

  it("skips the user's home folder (their own agy setup)", () => {
    const { root, app } = repo();
    write(path.join(root, '.agents', 'hooks.json'));
    expect(projectCustomizationProblem(app, [root, os.homedir()])).toBeNull();
    expect(projectCustomizationProblem(app, [os.homedir()])).toBe(path.join(root, '.agents', 'hooks.json'));
  });

  it('the route refuses before starting agy and names the file', async () => {
    process.env.FAKE_AGY_MODE = 'ok';
    const { root, app } = repo();
    write(path.join(root, '_agents', 'hooks.json'));
    const err = await rejection(antigravityRoute.ask(req(app), cfg(), never()));
    expect(err.kind).toBe('unavailable');
    expect(err.message).toContain(path.join(root, '_agents', 'hooks.json'));
    expect(err.message).toMatch(/not delegating/);
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
