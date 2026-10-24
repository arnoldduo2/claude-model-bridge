import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gatherContext, isSecretDir, isSecretPath } from '../src/context.js';

let tmp: string;
let proj: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-context-'));
  proj = path.join(tmp, 'proj with space');
  fs.mkdirSync(proj);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): void {
  const file = path.join(proj, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function listAll(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true })
    .map((p) => String(p).replace(/\\/g, '/'))
    .sort();
}

describe('isSecretPath', () => {
  it.each([
    '.env',
    '.env.local',
    'config/.env.production',
    'id_rsa',
    'home/.ssh/id_ed25519',
    'server.pem',
    'cert.key',
    'cert.pfx',
    'credentials.json',
    'oauth_creds.json',
    'secrets.yaml',
    '.npmrc',
    '.git-credentials',
    'deploy\\.env',
    'CONFIG/.ENV',
    'secrets.local.yaml',
    'config/secrets.production.json',
    'infra/prod.tfvars',
    'infra/prod.auto.tfvars.json',
    'infra/terraform.tfstate',
    'infra/terraform.tfstate.backup',
    '.htpasswd',
    '.dockercfg',
    'putty.ppk',
    'AuthKey_ABC.p8',
    'vault.kdbx',
    'backup.gpg',
    'pub.asc',
    'api.secret',
    'wp-config.php',
    'certs/site.crt',
    'certs/site.cer',
    'certs/site.der',
    '.env.example',
    '.claude-model-bridge/config.json',
    'home/.claude-model-bridge/logs/2026-10.jsonl',
    '.credentials.json',
    '.claude/.credentials.json',
    '.config/gh/hosts.yml',
    'user/.config/gh/config.yml',
    '.docker/config.json',
    '.kube/config',
    'a/b/.kube/cache/x.json',
    '.config/gcloud/application_default_credentials.json',
    '.config/gcloud/configurations/config_default',
    'application_default_credentials.json',
    '.azure/msal_token_cache.json',
    'auth.json',
    '.cargo/credentials',
    '.cargo/credentials.toml',
    '.terraform.d/credentials.tfrc.json',
    '.vault-token',
    '.s3cfg',
    '.boto',
    '.my.cnf',
    '.gnupg/private-keys-v1.d/x',
    '.ENV',
    '.Env.local',
    '.CLAUDE/.credentials.json',
    '.Claude/.Credentials.JSON',
    '.SSH/config',
    '.Config/GH/hosts.yml',
  ])('flags %s', (p) => {
    expect(isSecretPath(p)).toBe(true);
  });

  it.each([
    'env.ts',
    'src/keyboard.ts',
    'README.md',
    'src/environment.php',
    'docs/secrets-handling.md',
    'docker/config.json',
    '.config/app/settings.json',
    'cargo/credentials-notes.md',
    'src/gh/hosts.ts',
  ])(
    'allows %s',
    (p) => {
      expect(isSecretPath(p)).toBe(false);
    },
  );
});

describe('isSecretDir', () => {
  it.each(['.ssh', '.claude-model-bridge', '.kube', '.azure', '.terraform.d', '.config/gh', '.config/gcloud', 'x/.AWS', '.Claude-Model-Bridge', '.CONFIG/GCLOUD'])(
    'flags %s',
    (p) => {
      expect(isSecretDir(p)).toBe(true);
    },
  );
  it.each(['.config', '.config/app', 'src', 'gh', '.docker'])('allows %s', (p) => {
    expect(isSecretDir(p)).toBe(false);
  });
});

// Secret-shaped values are assembled at runtime so this file never contains a literal one.
const fakeKey = {
  google: () => 'AIza' + 'G'.repeat(35),
  openaiProj: () => 'sk-' + 'proj-' + 'P'.repeat(40),
  anthropic: () => 'sk-' + 'ant-' + 'A'.repeat(40),
  github: () => 'ghp' + '_' + 'H'.repeat(36),
  aws: () => 'AKIA' + 'W'.repeat(16),
};

describe('gatherContext: credential stores and secret values', () => {
  it('a home-folder-like tree sends no credential store', async () => {
    const stores: Record<string, string> = {
      '.claude/.credentials.json': '{"t":"CRED-CLAUDE"}',
      '.claude-model-bridge/config.json': '{"k":"CRED-BRIDGE"}',
      '.config/gh/hosts.yml': 'oauth: CRED-GH\n',
      '.docker/config.json': '{"auths":"CRED-DOCKER"}',
      '.kube/config': 'cluster CRED-KUBE\n',
      '.config/gcloud/application_default_credentials.json': '{"x":"CRED-GCLOUD"}',
      '.azure/accessTokens.json': '[CRED-AZURE]',
      'proj/auth.json': '{"x":"CRED-COMPOSER"}',
      '.cargo/credentials.toml': 'CRED-CARGO\n',
      '.terraform.d/credentials.tfrc.json': 'CRED-TF\n',
      '.vault-token': 'CRED-VAULT\n',
      '.s3cfg': 'CRED-S3\n',
      '.boto': 'CRED-BOTO\n',
      '.my.cnf': 'CRED-MYCNF\n',
    };
    for (const [rel, content] of Object.entries(stores)) write(rel, content);
    write('proj/app.ts', 'export const app = 1;\n');
    const r = await gatherContext({ cwd: proj, question: 'credentials config token', budgetChars: 200_000 });
    expect(r.text).not.toMatch(/CRED-/);
    for (const rel of Object.keys(stores)) expect(r.files).not.toContain(rel);
    expect(r.files).toContain('proj/app.ts');
    expect(r.skippedSecrets).toBeGreaterThanOrEqual(10);
  });

  it('keeps project files but redacts hard-coded secrets in them', async () => {
    const projKey = fakeKey.openaiProj();
    write(
      'settings.py',
      ['DEBUG = True', "SECRET_KEY = 'django-insecure-abcdef123456'", `OPENAI_KEY = "${projKey}"`, 'ALLOWED_HOSTS = []', ''].join('\n'),
    );
    write('appsettings.json', '{\n  "Database": {\n    "Password": "Hunter2Hunter2",\n    "Host": "db.local"\n  }\n}\n');
    write('config.php', "<?php\n$db_host = 'localhost';\n$db_pass = 'pa55w0rd-value';\n");
    write(
      'notes.md',
      ['google ' + fakeKey.google(), 'anthropic ' + fakeKey.anthropic(), 'gh ' + fakeKey.github(), 'aws ' + fakeKey.aws(), ''].join('\n'),
    );
    const r = await gatherContext({ cwd: proj, question: 'settings', budgetChars: 100_000 });
    expect(r.files).toEqual(expect.arrayContaining(['settings.py', 'appsettings.json', 'config.php', 'notes.md']));
    for (const v of [
      'django-insecure-abcdef123456',
      projKey,
      'Hunter2Hunter2',
      'pa55w0rd-value',
      fakeKey.google(),
      fakeKey.anthropic(),
      fakeKey.github(),
      fakeKey.aws(),
    ]) {
      expect(r.text).not.toContain(v);
    }
    expect(r.text).toContain("SECRET_KEY = '[REDACTED]'");
    expect(r.text).toContain('"Password": "[REDACTED]"');
    expect(r.text).toContain("$db_pass = '[REDACTED]'");
    expect(r.text).toContain("$db_host = 'localhost'");
    expect(r.text).toContain('"Host": "db.local"');
    expect(r.redactions).toBeGreaterThanOrEqual(8);
  });

  it('excludes a file holding a PGP private key block', async () => {
    const begin = ['-----BEGIN PGP', 'PRIVATE KEY BLOCK-----'].join(' ');
    write('keys.txt', ['exported', begin, 'UEdQREFUQQ==', '-----END PGP PRIVATE KEY BLOCK-----', ''].join('\n'));
    write('src/app.ts', 'export const a = 1;\n');
    const r = await gatherContext({ cwd: proj, question: 'keys', budgetChars: 50_000 });
    expect(r.files).not.toContain('keys.txt');
    expect(r.text).not.toContain('UEdQREFUQQ==');
    expect(r.skippedSecrets).toBeGreaterThanOrEqual(1);
  });
});

describe('gatherContext: paths', () => {
  it('named paths keep their order, ahead of ranked files', async () => {
    write('a.txt', 'a\n');
    write('b.txt', 'b q\n');
    write('c.txt', 'c\n');
    const r = await gatherContext({ cwd: proj, question: 'q', paths: ['c.txt', 'a.txt'], budgetChars: 50_000 });
    expect(r.files).toEqual(['c.txt', 'a.txt', 'b.txt']);
  });

  it('a named path beyond the scan cap is still sent', async () => {
    for (let i = 0; i < 30; i++) write(`f${String(i).padStart(2, '0')}.txt`, `file ${i}\n`);
    const r = await gatherContext({ cwd: proj, question: 'q', paths: ['f29.txt'], budgetChars: 50_000, maxFilesScanned: 5 });
    expect(r.files[0]).toBe('f29.txt');
    expect(r.text).toContain('file 29');
    expect(r.truncated).toBe(true);
  });

  it('a named file over maxFileBytes is sent as a head and tail slice', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${'x'.repeat(40)}`);
    write('big.log', lines.join('\n') + '\n');
    const size = fs.statSync(path.join(proj, 'big.log')).size;
    const r = await gatherContext({ cwd: proj, question: 'q', paths: ['big.log'], budgetChars: 20_000, maxFileBytes: 10_000 });
    expect(r.files[0]).toBe('big.log');
    expect(r.text).toContain('\n1| line 1 ');
    expect(r.text).toContain('\n5000| line 5000 ');
    const omitted = Number(/\[… (\d+) bytes omitted …\]/.exec(r.text)?.[1]);
    expect(omitted).toBeGreaterThan(0);
    expect(omitted).toBeLessThan(size);
    expect(r.text).not.toContain('line 2500 ');
    expect(r.text.length).toBeLessThanOrEqual(20_000);
    expect(r.text).toMatch(/Project files:\n[^\n]*big\.log/);
  });

  it('a large file that is not named is still left out', async () => {
    write('big.log', 'y'.repeat(20_000));
    write('ok.txt', 'ok\n');
    const r = await gatherContext({ cwd: proj, question: 'q', budgetChars: 50_000, maxFileBytes: 10_000 });
    expect(r.files).toEqual(['ok.txt']);
  });

  it('supports *, ** and ? globs', async () => {
    write('src/a.ts', 'a\n');
    write('src/deep/b.ts', 'b\n');
    write('src/c.js', 'c\n');
    write('aaa.ts', 'root\n');
    const one = await gatherContext({ cwd: proj, question: 'q', paths: ['src/*.ts'], budgetChars: 50_000 });
    expect(one.files[0]).toBe('src/a.ts');
    expect(one.files[1]).toBe('aaa.ts');
    const deep = await gatherContext({ cwd: proj, question: 'q', paths: ['src/**/*.ts'], budgetChars: 50_000 });
    expect(deep.files.slice(0, 2).sort()).toEqual(['src/a.ts', 'src/deep/b.ts']);
    const q = await gatherContext({ cwd: proj, question: 'q', paths: ['src/?.js'], budgetChars: 50_000 });
    expect(q.files[0]).toBe('src/c.js');
  });

  it('a named secret file or credential folder is still excluded', async () => {
    write('.kube/config', 'KUBE-SECRET\n');
    write('config/.env.production', 'ENV-SECRET\n');
    write('src/a.ts', 'a\n');
    const r = await gatherContext({
      cwd: proj,
      question: 'q',
      paths: ['.kube', '.kube/config', 'config/.env.production', 'config/*'],
      budgetChars: 50_000,
    });
    expect(r.text).not.toContain('KUBE-SECRET');
    expect(r.text).not.toContain('ENV-SECRET');
    expect(r.skippedSecrets).toBeGreaterThanOrEqual(3);
  });
});

describe('gatherContext: paths cannot dodge the secret rules with another name for a file', () => {
  const isWin = process.platform === 'win32';

  function writeStores(): void {
    write('.env', 'ENV-MARKER\n');
    write('.env.local', 'ENVLOCAL-MARKER\n');
    write('.claude/.credentials.json', '{"t":"CLAUDE-MARKER"}\n');
    write('.claude-model-bridge/config.json', '{"k":"BRIDGE-MARKER"}\n');
    write('.kube/config', 'KUBE-MARKER\n');
    write('src/app.ts', 'export const app = 1;\n');
  }

  function gatherWith(paths: string[]) {
    return gatherContext({ cwd: proj, question: 'q', paths, budgetChars: 100_000 });
  }

  // `.env::$DATA` and `.env:$DATA` are NTFS stream names for `.env`; Windows drops a trailing dot or space.
  it.each([
    '.env::$DATA',
    '.env:$DATA',
    '.claude/.credentials.json::$DATA',
    '.claude/.credentials.json:$DATA',
    '.env.',
    '.env ',
    '.claude./.credentials.json',
    '.claude /.credentials.json',
    '.kube./config',
  ])('a stream, colon, trailing dot or trailing space name is never read: %j', async (entry) => {
    writeStores();
    const baseline = await gatherWith([]);
    const r = await gatherWith([entry]);
    expect(r.text).not.toMatch(/[A-Z]+-MARKER/);
    expect(r.files[0]).toBe('src/app.ts');
    expect(r.skippedSecrets).toBe(baseline.skippedSecrets + 1);
  });

  it('a colon entry is refused even when it names no secret', async () => {
    write('notes.txt', 'NOTES\n');
    const r = await gatherWith(['notes.txt::$DATA', 'notes.txt:extra']);
    expect(r.files).toEqual(['notes.txt']);
    expect(r.skippedSecrets).toBe(2);
  });

  it.skipIf(!isWin)('upper-case names of secret files and folders are still excluded on Windows', async () => {
    writeStores();
    const r = await gatherWith(['.ENV', '.Env.local', '.CLAUDE/.credentials.json', '.CLAUDE/.CREDENTIALS.JSON', '.KUBE', '.Kube/Config']);
    expect(r.text).not.toMatch(/[A-Z]+-MARKER/);
    expect(r.files).toEqual(['src/app.ts']);
  });

  it.skipIf(!isWin)('a Windows short (8.3) name is checked under its real name', async (ctx) => {
    writeStores();
    // Short names exist only when the volume generates them; keep the guesses that resolve to a store.
    const aliases: string[] = [];
    for (const guess of ['ENV~1', 'ENV~2', 'ENVLOC~1', 'CLAUDE~1', 'CLAUDE~2', 'KUBE~1']) {
      try {
        if (path.basename(fs.realpathSync.native(path.join(proj, guess))) !== guess) aliases.push(guess);
      } catch {
        // no such short name
      }
    }
    if (aliases.length === 0) ctx.skip();
    const r = await gatherWith([...aliases, ...aliases.map((a) => `${a}/config.json`), ...aliases.map((a) => `${a}/*`)]);
    expect(r.text).not.toMatch(/[A-Z]+-MARKER/);
    expect(r.files).toEqual(['src/app.ts']);
  });

  it('a named directory sends its files but not a secret file inside it', async () => {
    write('config/app.json', '{"name":"app"}\n');
    write('config/.env.production', 'ENVPROD-MARKER\n');
    write('config/deploy/id_rsa', 'RSA-MARKER\n');
    const r = await gatherWith(['config', 'config/**']);
    expect(r.files).toEqual(['config/app.json']);
    expect(r.text).not.toMatch(/[A-Z]+-MARKER/);
    expect(r.skippedSecrets).toBeGreaterThanOrEqual(2);
  });

  it('a path through a link into a credential folder is checked under its real path', async () => {
    writeStores();
    fs.symlinkSync(path.join(proj, '.kube'), path.join(proj, 'kubelink'), 'junction');
    fs.symlinkSync(path.join(proj, '.claude-model-bridge'), path.join(proj, 'bridgelink'), 'junction');
    const r = await gatherWith(['kubelink/config', 'bridgelink/config.json', 'bridgelink/*']);
    expect(r.text).not.toMatch(/[A-Z]+-MARKER/);
    expect(r.files).toEqual(['src/app.ts']);
  });

  it('a named file is listed under its real name', async () => {
    write('src/Main.ts', 'export const main = 1;\n');
    const named = isWin ? 'SRC/main.TS' : 'src/Main.ts';
    const r = await gatherWith([named]);
    expect(r.files).toEqual(['src/Main.ts']);
  });
});

describe('gatherContext', () => {
  it('includes tree and line-numbered files', async () => {
    write('src/vat.php', '<?php\n\nfunction vat() {}\n');
    write('README.md', '# hello\n');
    const r = await gatherContext({ cwd: proj, question: 'where is vat calculated', budgetChars: 50_000 });
    expect(r.text).toContain('src/vat.php');
    expect(r.text).toContain('3| function vat() {}');
    expect(r.files).toContain('src/vat.php');
    expect(r.truncated).toBe(false);
    expect(r.skippedSecrets).toBe(0);
  });

  it('numbers lines of CRLF files without carriage returns', async () => {
    write('a.txt', 'one\r\ntwo\r\n');
    const r = await gatherContext({ cwd: proj, question: 'a', budgetChars: 50_000 });
    expect(r.text).toContain('2| two\n');
    expect(r.text).not.toContain('\r');
  });

  it('never includes .env', async () => {
    write('.env', 'DB_PASS=x\n');
    write('config/.env.production', 'DB_PASS=y\n');
    write('src/app.ts', 'export const a = 1;\n');
    const r = await gatherContext({ cwd: proj, question: 'db pass env', budgetChars: 50_000 });
    expect(r.text).not.toContain('DB_PASS');
    expect(r.files.some((f) => f.includes('.env'))).toBe(false);
    expect(r.skippedSecrets).toBeGreaterThanOrEqual(1);
  });

  it('never includes a secret even when named in paths', async () => {
    write('.env', 'DB_PASS=x\n');
    write('src/app.ts', 'export const a = 1;\n');
    const r = await gatherContext({ cwd: proj, question: 'q', paths: ['.env'], budgetChars: 50_000 });
    expect(r.text).not.toContain('DB_PASS');
    expect(r.files).not.toContain('.env');
  });

  it('excludes a private key block found inside an innocuous file', async () => {
    const begin = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    write('notes.txt', ['my notes', begin, 'Zm9vYmFy', '-----END PRIVATE KEY-----', ''].join('\n'));
    write('src/app.ts', 'export const a = 1;\n');
    const r = await gatherContext({ cwd: proj, question: 'notes', budgetChars: 50_000 });
    expect(r.files).not.toContain('notes.txt');
    expect(r.text).not.toContain('Zm9vYmFy');
    expect(r.text).not.toContain('my notes');
    expect(r.skippedSecrets).toBeGreaterThanOrEqual(1);
  });

  it('skips heavy dirs', async () => {
    for (const d of ['node_modules', 'vendor', '.git', 'dist', 'build']) write(`${d}/lib/x.js`, 'x\n');
    write('src/main.js', 'main\n');
    const r = await gatherContext({ cwd: proj, question: 'x lib', budgetChars: 50_000 });
    expect(r.files).toEqual(['src/main.js']);
  });

  it('respects .gitignore', async () => {
    write('.gitignore', '# comment\nlogs/\n*.tmp\n/rootonly.txt\n');
    write('logs/app.log', 'log line\n');
    write('src/logs/deep.txt', 'also ignored\n');
    write('scratch.tmp', 'tmp\n');
    write('rootonly.txt', 'root\n');
    write('src/rootonly.txt', 'nested stays\n');
    write('src/keep.ts', 'keep\n');
    const r = await gatherContext({ cwd: proj, question: 'log', budgetChars: 50_000 });
    expect(r.files).not.toContain('logs/app.log');
    expect(r.files).not.toContain('src/logs/deep.txt');
    expect(r.files).not.toContain('scratch.tmp');
    expect(r.files).not.toContain('rootonly.txt');
    expect(r.files).toContain('src/rootonly.txt');
    expect(r.files).toContain('src/keep.ts');
  });

  it('skips binary and oversized', async () => {
    write('bin.dat', Buffer.from([0x41, 0x00, 0x42]));
    write('dump.sql', 'x'.repeat(300 * 1024));
    write('ok.txt', 'fine\n');
    const r = await gatherContext({ cwd: proj, question: 'dump bin', budgetChars: 50_000 });
    expect(r.files).not.toContain('bin.dat');
    expect(r.files).not.toContain('dump.sql');
    expect(r.files).toContain('ok.txt');
    expect(r.text).not.toContain('bin.dat');
    expect(r.text).not.toContain('dump.sql');
  });

  it('budget', async () => {
    for (let i = 0; i < 10; i++) write(`f${i}.txt`, 'abcdefghi\n'.repeat(100));
    const r = await gatherContext({ cwd: proj, question: 'abcdefghi', budgetChars: 2000 });
    expect(r.text.length).toBeLessThanOrEqual(2000);
    expect(r.truncated).toBe(true);
  });

  it('paths focus: a named file comes first even when another file scores higher', async () => {
    write('src/vat.php', 'vat vat\n');
    write('src/other.php', 'vat vat vat\n');
    write('zz/plain.php', 'nothing relevant\n');
    const r = await gatherContext({ cwd: proj, question: 'vat', paths: ['zz/plain.php'], budgetChars: 50_000 });
    expect(r.files[0]).toBe('zz/plain.php');
    expect(r.files).toEqual(expect.arrayContaining(['src/vat.php', 'src/other.php']));
  });

  it('paths may be directories, backslashed, and cannot escape cwd', async () => {
    write('src/a.txt', 'a\n');
    write('lib/b.txt', 'b\n');
    fs.writeFileSync(path.join(tmp, 'outside.txt'), 'outside\n');
    const r = await gatherContext({
      cwd: proj,
      question: 'zzz',
      paths: ['lib\\', '../outside.txt', path.join(tmp, 'outside.txt')],
      budgetChars: 50_000,
    });
    expect(r.files[0]).toBe('lib/b.txt');
    expect(r.text).not.toContain('outside');
  });

  it('ranks by question terms in path and content', async () => {
    write('a.txt', 'nothing\n');
    write('b.txt', 'the invoice total\n');
    write('invoice.txt', 'nothing\n');
    const r = await gatherContext({ cwd: proj, question: 'invoice', budgetChars: 50_000 });
    expect(r.files).toEqual(['invoice.txt', 'b.txt', 'a.txt']);
  });

  it('cwd with spaces', async () => {
    expect(path.basename(proj)).toContain(' ');
    write('src/a.ts', 'const a = 1;\n');
    const r = await gatherContext({ cwd: proj, question: 'a', budgetChars: 50_000 });
    expect(r.files).toEqual(['src/a.ts']);
  });

  it('does not write anything inside cwd', async () => {
    write('.env', 'S=1\n');
    write('src/a.ts', 'a\n');
    const before = listAll(proj);
    await gatherContext({ cwd: proj, question: 'a', budgetChars: 50_000 });
    expect(listAll(proj)).toEqual(before);
  });

  it('stops walking at maxFilesScanned', async () => {
    for (let i = 0; i < 30; i++) write(`f${i}.txt`, 'x\n');
    const r = await gatherContext({ cwd: proj, question: 'x', budgetChars: 50_000, maxFilesScanned: 10 });
    expect(r.files.length).toBeLessThanOrEqual(10);
    expect(r.truncated).toBe(true);
  });

  it('content-scores past 2000 files so a late-sorting content match ranks first', async () => {
    const dirs = 30;
    const perDir = 80; // 2400 filler files, all same extension and depth
    for (let d = 0; d < dirs; d++) {
      const dir = path.join(proj, `a${String(d).padStart(2, '0')}`);
      fs.mkdirSync(dir);
      await Promise.all(
        Array.from({ length: perDir }, (_, i) => fs.promises.writeFile(path.join(dir, `f${i}.txt`), 'filler\n')),
      );
    }
    fs.mkdirSync(path.join(proj, 'zzz'));
    fs.writeFileSync(path.join(proj, 'zzz', 'last.txt'), 'compute the quokka rate here\n');
    const r = await gatherContext({ cwd: proj, question: 'where is quokka calculated', budgetChars: 5_000 });
    expect(r.files[0]).toBe('zzz/last.txt');
  }, 60_000);

  it('huge tree is fast', async () => {
    const dirs = 250;
    const perDir = 100;
    for (let d = 0; d < dirs; d++) {
      const dir = path.join(proj, `d${d}`);
      fs.mkdirSync(dir);
      await Promise.all(
        Array.from({ length: perDir }, (_, i) => fs.promises.writeFile(path.join(dir, `f${i}.txt`), 'x\n')),
      );
    }
    const t0 = Date.now();
    const r = await gatherContext({ cwd: proj, question: 'where is vat calculated', budgetChars: 100_000 });
    const elapsed = Date.now() - t0;
    expect(r.files.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  }, 120_000);
});
