import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { decideAgyToolCall, GUARD_PROJECT_ENV, runAgyGuard } from '../src/agy-guard.js';
import { ensureReadOnlyAgent } from '../src/routes/antigravity.js';

const root = path.resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
function tmpDir(prefix = 'cmb-guard-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const d = tmpDir('cmb guard proj ');
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src', 'db.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(d, '.env'), 'PASSWORD=canary');
  fs.mkdirSync(path.join(d, '.aws'));
  fs.writeFileSync(path.join(d, '.aws', 'config'), 'x');
  fs.mkdirSync(path.join(d, 'config'));
  fs.writeFileSync(path.join(d, 'config', 'credentials.json'), '{}');
  return d;
}

function payload(proj: string, name: string, args: Record<string, unknown>, ws: unknown = [proj.replace(/\\/g, '/'), 'C:/bridge/agy-workspace']) {
  return { toolCall: { name, args }, workspacePaths: ws, conversationId: 'c', stepIdx: 0 };
}

const allow = { decision: 'allow' };

describe('decideAgyToolCall', () => {
  it('allows a normal source file, the project folder, and a name search inside it', () => {
    const p = project();
    expect(decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: path.join(p, 'src', 'db.js') }), p)).toEqual(allow);
    expect(decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: 'src/db.js' }), p)).toEqual(allow);
    expect(decideAgyToolCall(payload(p, 'list_dir', { DirectoryPath: p }), p)).toEqual(allow);
    expect(decideAgyToolCall(payload(p, 'find_by_name', { SearchDirectory: p, Pattern: '*.js' }), p)).toEqual(allow);
  });

  it('never returns an empty decision', () => {
    for (const bad of [undefined, null, 'x', 42, {}, { toolCall: 'x' }]) {
      const d = decideAgyToolCall(bad, 'C:/x');
      expect(d.decision).toBe('deny');
      expect(d.reason).toMatch(/^Blocked by Claude Model Bridge: /);
    }
  });

  it.each([
    ['.env', (p: string) => path.join(p, '.env')],
    ['credentials.json', (p: string) => path.join(p, 'config', 'credentials.json')],
    ['a file in a secret folder', (p: string) => path.join(p, '.aws', 'config')],
    ['case variant of .env', (p: string) => path.join(p, '.ENV')],
    ['../ traversal back in', (p: string) => path.join(p, 'src', '..', '.env')],
  ])('denies view_file on %s', (_label, at) => {
    const p = project();
    const d = decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: at(p) }), p);
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/secret/);
  });

  it('denies paths outside the project, including traversal and relative escapes', () => {
    const p = project();
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, 'notes.txt'), 'x');
    for (const target of [path.join(outside, 'notes.txt'), path.join(p, '..', path.basename(outside), 'notes.txt'), '../x', os.homedir()]) {
      const d = decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: target }), p);
      expect(d.decision).toBe('deny');
      expect(d.reason).toMatch(/outside the project/);
    }
    expect(decideAgyToolCall(payload(p, 'list_dir', { DirectoryPath: path.dirname(p) }), p).decision).toBe('deny');
    expect(decideAgyToolCall(payload(p, 'find_by_name', { SearchDirectory: outside, Pattern: '*' }), p).decision).toBe('deny');
  });

  it('denies a link that leads outside the project', () => {
    const p = project();
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    fs.symlinkSync(outside, path.join(p, 'link'), 'junction');
    const d = decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: path.join(p, 'link', 'secret.txt') }), p);
    expect(d.decision).toBe('deny');
    expect(d.reason).toMatch(/resolves outside/);
  });

  it.runIf(process.platform === 'win32')('denies Windows stream, trailing-dot and device tricks', () => {
    const p = project();
    for (const target of [path.join(p, '.env::$DATA'), path.join(p, '.env:$DATA'), path.join(p, '.env.'), path.join(p, '.env '), '\\\\?\\' + path.join(p, '.env'), '\\\\localhost\\c$\\x']) {
      expect(decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: target }), p).decision).toBe('deny');
    }
  });

  describe('version-control folders', () => {
    function repoProject(): string {
      const p = project();
      fs.mkdirSync(path.join(p, '.git', 'refs'), { recursive: true });
      fs.writeFileSync(path.join(p, '.git', 'config'), '[remote "origin"]\n\turl = https://user:tok@example.invalid/r.git\n');
      fs.mkdirSync(path.join(p, 'sub', '.git'), { recursive: true });
      fs.writeFileSync(path.join(p, 'sub', '.git', 'config'), 'x');
      for (const d of ['.svn', '.hg']) {
        fs.mkdirSync(path.join(p, d));
        fs.writeFileSync(path.join(p, d, 'hgrc'), 'x');
      }
      fs.writeFileSync(path.join(p, '.gitignore'), 'node_modules\n');
      fs.mkdirSync(path.join(p, '.github', 'workflows'), { recursive: true });
      fs.writeFileSync(path.join(p, '.github', 'workflows', 'ci.yml'), 'on: push');
      return p;
    }
    const vcs = /version-control folders/;

    it.each([
      ['.git/config', (p: string) => path.join(p, '.git', 'config')],
      ['.GIT/config', (p: string) => path.join(p, '.GIT', 'config')],
      ['.git\\config (backslash)', (p: string) => `${p}\\.git\\config`],
      ['.git/config (forward slash)', (p: string) => `${p.replace(/\\/g, '/')}/.git/config`],
      ['relative .git/config', () => '.git/config'],
      ['sub/.git/config', (p: string) => path.join(p, 'sub', '.git', 'config')],
      ['src/../.git/config', (p: string) => path.join(p, 'src', '..', '.git', 'config')],
      ['.svn/…', (p: string) => path.join(p, '.svn', 'hgrc')],
      ['.hg/…', (p: string) => path.join(p, '.hg', 'hgrc')],
    ])('denies view_file on %s', (_label, at) => {
      const p = repoProject();
      const d = decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: at(p) }), p);
      expect(d.decision).toBe('deny');
      expect(d.reason).toMatch(vcs);
    });

    it('denies list_dir and find_by_name on .git or inside it', () => {
      const p = repoProject();
      for (const target of [path.join(p, '.git'), path.join(p, '.Git'), path.join(p, '.git', 'refs'), path.join(p, 'sub', '.git')]) {
        expect(decideAgyToolCall(payload(p, 'list_dir', { DirectoryPath: target }), p).reason).toMatch(vcs);
        expect(decideAgyToolCall(payload(p, 'find_by_name', { SearchDirectory: target, Pattern: '*' }), p).reason).toMatch(vcs);
      }
    });

    it.runIf(process.platform === 'win32')('denies the device-path form of .git/config', () => {
      const p = repoProject();
      for (const target of [`\\\\?\\${path.join(p, '.git', 'config')}`, `\\\\.\\${path.join(p, '.git', 'config')}`]) {
        expect(decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: target }), p).decision).toBe('deny');
      }
    });

    it.runIf(process.platform === 'win32')('denies an 8.3 short name of .git (when the volume has short names)', (ctx) => {
      const p = repoProject();
      // Verbatim arguments: Node would otherwise escape the inner quotes for cmd.exe.
      const r = spawnSync('cmd.exe', [`/d /s /c "for %I in ("${path.join(p, '.git')}") do @echo %~sI"`], {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      });
      const short = r.stdout.trim();
      if (!/~\d+$/.test(path.basename(short))) ctx.skip();
      // Only the last segment short (e.g. <project>\GIT~1\config), so the lexical checks pass and realpath must catch it.
      const target = path.join(p, path.basename(short), 'config');
      expect(path.basename(short).toLowerCase()).not.toBe('.git');
      const d = decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: target }), p);
      expect(d.decision).toBe('deny');
      expect(d.reason).toMatch(vcs);
    });

    it('still allows .gitignore, .github and the project root', () => {
      const p = repoProject();
      expect(decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: path.join(p, '.gitignore') }), p)).toEqual(allow);
      expect(decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: path.join(p, '.github', 'workflows', 'ci.yml') }), p)).toEqual(allow);
      expect(decideAgyToolCall(payload(p, 'list_dir', { DirectoryPath: p }), p)).toEqual(allow);
    });
  });

  it('denies listing or searching a secret folder', () => {
    const p = project();
    expect(decideAgyToolCall(payload(p, 'list_dir', { DirectoryPath: path.join(p, '.aws') }), p).decision).toBe('deny');
    expect(decideAgyToolCall(payload(p, 'find_by_name', { SearchDirectory: path.join(p, '.aws'), Pattern: '*' }), p).decision).toBe('deny');
  });

  it.each(['run_command', 'write_to_file', 'replace_file_content', 'grep_search', 'call_mcp_tool', 'manage_task', 'read_url_content', 'search_web'])(
    'denies tool %s',
    (name) => {
      const p = project();
      const d = decideAgyToolCall(payload(p, name, { AbsolutePath: path.join(p, 'src', 'db.js'), CommandLine: 'echo hi' }), p);
      expect(d.decision).toBe('deny');
      expect(d.reason).toMatch(/not allowed/);
    },
  );

  it('denies when the project is missing, wrong, or not agy’s workspace', () => {
    const p = project();
    const call = payload(p, 'view_file', { AbsolutePath: path.join(p, 'src', 'db.js') });
    expect(decideAgyToolCall(call, undefined).decision).toBe('deny');
    expect(decideAgyToolCall(call, 'relative/dir').decision).toBe('deny');
    expect(decideAgyToolCall(call, path.join(p, 'nope')).decision).toBe('deny');
    expect(decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: path.join(p, 'src', 'db.js') }, [tmpDir()]), p).decision).toBe('deny');
    expect(decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: path.join(p, 'src', 'db.js') }, null), p).decision).toBe('deny');
  });

  it('denies a missing or non-string path argument, and checks other path-like arguments', () => {
    const p = project();
    expect(decideAgyToolCall(payload(p, 'view_file', {}), p).decision).toBe('deny');
    expect(decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: 7 }), p).decision).toBe('deny');
    expect(decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: '' }), p).decision).toBe('deny');
    const extra = { SearchDirectory: p, Pattern: '*', OtherFilePath: path.join(p, '.env') };
    expect(decideAgyToolCall(payload(p, 'find_by_name', extra), p).decision).toBe('deny');
    expect(decideAgyToolCall(payload(p, 'view_file', { AbsolutePath: path.join(p, 'src', 'db.js'), IsSkillFile: false }), p)).toEqual(allow);
  });
});

async function runWith(input: string | null, env: NodeJS.ProcessEnv, timeoutMs = 2000): Promise<string> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (d) => (out += d));
  const done = runAgyGuard({ stdin, stdout, env, timeoutMs });
  if (input !== null) stdin.end(input);
  await done;
  return out;
}

describe('runAgyGuard', () => {
  it('writes allow for a permitted call and deny for garbage, never nothing', async () => {
    const p = project();
    const env = { [GUARD_PROJECT_ENV]: p };
    const ok = JSON.parse(await runWith(JSON.stringify(payload(p, 'view_file', { AbsolutePath: path.join(p, 'src', 'db.js') })), env));
    expect(ok).toEqual(allow);
    for (const bad of ['', 'not json', '{}', JSON.stringify(payload(p, 'run_command', { CommandLine: 'x' }))]) {
      expect(JSON.parse(await runWith(bad, env)).decision).toBe('deny');
    }
    expect(JSON.parse(await runWith(JSON.stringify(payload(p, 'view_file', { AbsolutePath: 'src/db.js' })), {})).decision).toBe('deny');
  });

  it('denies when stdin never ends', async () => {
    const out = await runWith(null, { [GUARD_PROJECT_ENV]: 'C:/x' }, 200);
    expect(JSON.parse(out).decision).toBe('deny');
  });

  it('reports whether the decision was written', async () => {
    const p = project();
    const stdin = new PassThrough();
    const ok = new PassThrough();
    const okRun = runAgyGuard({ stdin, stdout: ok, env: { [GUARD_PROJECT_ENV]: p } });
    stdin.end('{}');
    expect(await okRun).toBe(true);

    const broken = new Writable({ write: (_c, _e, cb) => cb(new Error('EPIPE')) });
    broken.on('error', () => {});
    const stdin2 = new PassThrough();
    const badRun = runAgyGuard({ stdin: stdin2, stdout: broken, env: { [GUARD_PROJECT_ENV]: p } });
    stdin2.end('{}');
    expect(await badRun).toBe(false);
  });
});

describe('the installed hook end to end (committed bundle)', () => {
  const bundle = path.join(root, 'plugin', 'server', 'bridge.mjs');

  function hook(input: string, env: NodeJS.ProcessEnv, moduleUrl = pathToFileURL(bundle).href) {
    const a = ensureReadOnlyAgent(tmpDir('cmb guard home '), moduleUrl);
    const cwd = path.join(a.dir, '.agents');
    const hooks = JSON.parse(fs.readFileSync(path.join(cwd, 'hooks.json'), 'utf8'));
    const [cmd, ...args] = (hooks['claude-model-bridge-guard'].PreToolUse[0].hooks[0].command as string).split(' ');
    expect(cmd).toBe('node');
    const r = spawnSync(process.execPath, args, { cwd, input, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it('allows a source file and denies .env, outside paths and other tools', () => {
    const p = project();
    const env = { [GUARD_PROJECT_ENV]: p };
    expect(JSON.parse(hook(JSON.stringify(payload(p, 'view_file', { AbsolutePath: path.join(p, 'src', 'db.js') })), env).stdout)).toEqual(allow);
    for (const call of [
      payload(p, 'view_file', { AbsolutePath: path.join(p, '.env') }),
      payload(p, 'view_file', { AbsolutePath: path.join(p, '..') }),
      payload(p, 'run_command', { CommandLine: 'echo' }),
    ]) {
      const r = hook(JSON.stringify(call), env);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).decision).toBe('deny');
    }
  }, 60_000);

  it('denies when the bundle cannot be loaded', () => {
    const p = project();
    const r = hook(JSON.stringify(payload(p, 'view_file', { AbsolutePath: path.join(p, 'src', 'db.js') })), { [GUARD_PROJECT_ENV]: p }, pathToFileURL(path.join(tmpDir(), 'missing.mjs')).href);
    expect(JSON.parse(r.stdout).decision).toBe('deny');
    expect(r.status).toBe(0);
  }, 60_000);

  it('exits 0 only after a decision is written: allow → 0, and .git/config is denied', () => {
    const p = project();
    fs.mkdirSync(path.join(p, '.git'));
    fs.writeFileSync(path.join(p, '.git', 'config'), 'x');
    const env = { [GUARD_PROJECT_ENV]: p };
    const ok = hook(JSON.stringify(payload(p, 'view_file', { AbsolutePath: path.join(p, 'src', 'db.js') })), env);
    expect(ok.status).toBe(0);
    expect(ok.stdout).not.toBe('');
    const git = hook(JSON.stringify(payload(p, 'view_file', { AbsolutePath: path.join(p, '.git', 'config') })), env);
    expect(JSON.parse(git.stdout).reason).toMatch(/version-control/);
  }, 60_000);

  it('the shim starts with a failing exit code and clears it only on a written decision', () => {
    const a = ensureReadOnlyAgent(tmpDir(), 'file:///x/bridge.mjs');
    const script = fs.readFileSync(path.join(a.dir, '.agents', 'cmb-guard.mjs'), 'utf8');
    const lines = script.split('\n');
    const first = lines.findIndex((l) => !l.startsWith('//') && l.trim());
    expect(lines[first]).toBe('process.exitCode = 1;');
    expect(script).toContain('if ((await m.runAgyGuard()) === true) process.exitCode = 0;');
    expect(script).toMatch(/\(err\) => \{ if \(!err\) process\.exitCode = 0; \}/);
  });
});
