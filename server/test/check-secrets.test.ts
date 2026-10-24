import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.resolve(import.meta.dirname, '../../scripts/check-secrets.mjs');
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-secrets-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Secret-shaped values are assembled at runtime so this file never contains one.
function run(content: string | Buffer) {
  const file = path.join(tmp, 'sample.txt');
  fs.writeFileSync(file, content);
  return spawnSync(process.execPath, [script, '--files'], { input: file + '\n', encoding: 'utf8' });
}

describe('check-secrets --files', () => {
  it('passes clean files', () => {
    const r = run('hello world\nno secrets here\n');
    expect(r.status).toBe(0);
  });

  it.each([
    ['google-api-key', 'key = ' + 'AIza' + 'x'.repeat(35)],
    ['google-api-key-new', 'key = ' + 'AQ.' + 'y'.repeat(30)],
    ['openrouter-api-key', 'key = ' + 'sk-or-' + 'z'.repeat(24)],
    ['private-key-block', '-----BEGIN ' + 'RSA PRIVATE KEY-----'],
    ['windows-user-path', 'cwd = C:' + '\\Users\\' + 'someone\\proj'],
    ['windows-user-path', 'cwd = d:' + '/users/' + 'someone/proj'],
    ['windows-user-path', '"cwd": "E:' + '\\\\Users\\\\' + 'someone\\\\proj"'],
    ['private-key-block', '-----BEGIN PGP ' + 'PRIVATE KEY BLOCK-----'],
    ['posix-home-path', 'cd ' + '/home/' + 'someone/proj'],
    ['posix-home-path', "path = '" + '/HOME/' + "someone/x'"],
    ['mac-user-path', 'open ' + '/Users/' + 'someone/Documents'],
    ['mac-user-path', '(' + '/users/' + 'someone/)'],
  ])('blocks %s and reports path:line without the value', (name, line) => {
    const r = run('first line\n' + line + '\n');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`sample.txt:2: ${name}`);
    expect(r.stderr).not.toContain('xxxxxxxx');
    expect(r.stderr).not.toContain('yyyyyyyy');
    expect(r.stderr).not.toContain('zzzzzzzz');
    expect(r.stderr).not.toContain('someone');
  });

  it.each([
    'see https://api.github.com' + '/users/' + 'octocat/repos',
    "app.get('" + '/users/' + ":id/posts')",
    'Windows: <drive>:' + '\\Users\\' + '<name>',
    'POSIX: ' + '/home/' + '<name>/ or ' + '/Users/' + '$USER/',
    'cd ' + '~/' + 'projects/x',
    'C:' + '\\Users\\' + '%USERNAME%\\x',
  ])('allows placeholders and URL paths: %s', (line) => {
    expect(run(line + '\n').status).toBe(0);
  });

  it('skips binary files and missing paths', () => {
    const bin = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('AIza' + 'x'.repeat(35))]);
    expect(run(bin).status).toBe(0);
    const r = spawnSync(process.execPath, [script, '--files'], {
      input: path.join(tmp, 'does-not-exist.txt') + '\n',
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
  });
});
