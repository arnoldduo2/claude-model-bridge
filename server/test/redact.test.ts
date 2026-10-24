import { describe, it, expect } from 'vitest';
import { redactSecrets, stripKeys } from '../src/redact.js';

// Secret-shaped values are assembled at runtime so this file never contains a literal one.
const keys: Array<[string, string]> = [
  ['google', 'AIza' + 'a'.repeat(35)],
  ['google-new', 'AQ.' + 'b'.repeat(32)],
  ['openrouter', 'sk-' + 'or-v1-' + 'c'.repeat(40)],
  ['anthropic', 'sk-' + 'ant-api03-' + 'd'.repeat(40)],
  ['openai-project', 'sk-' + 'proj-' + 'e'.repeat(40)],
  ['openai-generic', 'sk-' + 'F'.repeat(32)],
  ['github-classic', 'ghp' + '_' + 'G'.repeat(36)],
  ['github-fine-grained', 'github' + '_pat_' + 'H'.repeat(40)],
  ['aws', 'AKIA' + 'J'.repeat(16)],
  ['slack', 'xox' + 'b-' + '1234567890-abcdefghij'],
];

describe('redactSecrets', () => {
  it.each(keys)('replaces a %s key wherever it appears', (_name, key) => {
    const r = redactSecrets(`see ${key} here`);
    expect(r.text).toBe('see [REDACTED] here');
    expect(r.count).toBe(1);
  });

  it.each([
    ["SECRET_KEY = 'abc123def'", "SECRET_KEY = '[REDACTED]'"],
    ['"Password": "Hunter2"', '"Password": "[REDACTED]"'],
    ["$db_pass = 'letmein';", "$db_pass = '[REDACTED]';"],
    ["'api_key' => 'k-123456'", "'api_key' => '[REDACTED]'"],
    ['DB_PASSWORD=hunter2', 'DB_PASSWORD=[REDACTED]'],
    ['client_secret: s3cr3t-value', 'client_secret: [REDACTED]'],
    ['access_key := "zzz"', 'access_key := "[REDACTED]"'],
    ['auth_token=abc.def-ghi', 'auth_token=[REDACTED]'],
    ['connect(password="x-secret-1")', 'connect(password="[REDACTED]")'],
    ['env: PASSWORD=x9secret', 'env: PASSWORD=[REDACTED]'],
    ['--password=x9secret', '--password=[REDACTED]'],
    ['cmd --db-password x --api-key=k3y-value', 'cmd --db-password x --api-key=[REDACTED]'],
    ['url?user=bob&token=abc123', 'url?user=bob&token=[REDACTED]'],
    ['opts = {a: 1, secret: "s"}', 'opts = {a: 1, secret: "[REDACTED]"}'],
    // A single bare word after a secret key may be the secret itself; only references are kept.
    ['POSTGRES_PASSWORD: postgres', 'POSTGRES_PASSWORD: [REDACTED]'],
    ['MYSQL_ROOT_PASSWORD=rootpassword', 'MYSQL_ROOT_PASSWORD=[REDACTED]'],
    ['password = letmein', 'password = [REDACTED]'],
    ['api_key: ' + 'abcdefghijklmnopqrstuvwxyz' + 'ABCDEF', 'api_key: [REDACTED]'],
    ['secret: SuperSecretValue', 'secret: [REDACTED]'],
    ['tokenizer = AutoTokenizer', 'tokenizer = [REDACTED]'],
    ['passwordHash: hash,', 'passwordHash: [REDACTED],'],
  ])('redacts the value in %s', (input, expected) => {
    expect(redactSecrets(input).text).toBe(expected);
  });

  it.each([
    'maxTokens: 4096',
    'password: z.string(),',
    'token: string;',
    'apiKey: cfg.gemini.apiKey,',
    'if (password == "x") {}',
    'const tokens = tokenize(text);',
    'password: ${DB_PASSWORD}',
    'api_key = ""',
    'host = "db.local"',
    'tokens => tokens.length',
    'const token = $token;',
    '$pw = $input',
    'password = config.password',
    'token: self.token',
    'DB_PASS=process.env.DB_PASS',
    'secret_name: my_secret.name',
  ])('leaves code and non-secrets alone: %s', (input) => {
    expect(redactSecrets(input).text).toBe(input);
  });

  it('keeps line structure', () => {
    const r = redactSecrets("a = 1\nsecret = 'x1'\nb = 2\n");
    expect(r.text).toBe("a = 1\nsecret = '[REDACTED]'\nb = 2\n");
  });

  it('a line over 4096 characters keeps token redaction but skips assignment redaction', () => {
    const google = keys[0][1];
    const long = `${'x'.repeat(5000)} ${google} password = "hunter2"`;
    const r = redactSecrets(`${long}\nsecret = 'x1'\n`);
    expect(r.text).toBe(`${'x'.repeat(5000)} [REDACTED] password = "hunter2"\nsecret = '[REDACTED]'\n`);
    expect(r.count).toBe(2);
  });
});

describe('redactSecrets runs in linear time', () => {
  const HEX = '0123456789abcdef';
  const ALPHA = 'abcdefghijklmnopqrstuvwxyz';
  const run = (alphabet: string, n: number, step: number) =>
    Array.from({ length: n }, (_, i) => alphabet[(i * step + 3) % alphabet.length]).join('');

  function timed(text: string): number {
    const t = performance.now();
    redactSecrets(text);
    return performance.now() - t;
  }

  it('one 200,000-character hex line takes under 200 ms', () => {
    expect(timed(run(HEX, 200_000, 7))).toBeLessThan(200);
  });

  it('2,000 lines of 100-character identifier runs take under 200 ms', () => {
    const text = Array.from({ length: 2000 }, () => run(ALPHA, 100, 5)).join('\n');
    expect(timed(text)).toBeLessThan(200);
  });

  it.each([
    ['a 100,000-character SQL 0x blob line', () => `INSERT INTO t VALUES (0x${run(HEX, 100_000, 7)});`],
    ['a 100,000-character dashed run', () => 'a-'.repeat(50_000)],
    ['a 100,000-character dotted run', () => 'a.'.repeat(50_000)],
    ['a run of JWT-like prefixes', () => 'eyJ'.repeat(33_000)],
    ['200 lines of unterminated quoted assignments', () => Array.from({ length: 200 }, () => 'a="'.repeat(1300)).join('\n')],
    ['200 lines of chained secret assignments', () => Array.from({ length: 200 }, () => 'pw=('.repeat(1000)).join('\n')],
  ])('%s takes under 200 ms', (_name, make) => {
    expect(timed(make())).toBeLessThan(200);
  });
});

describe('stripKeys', () => {
  it('removes each configured key and ignores empty or very short ones', () => {
    const a = 'plain-key-value-123';
    const b = 'another-configured-key';
    expect(stripKeys(`x ${a} y ${b} z ${a}`, [a, undefined, b])).toBe('x [REDACTED] y [REDACTED] z [REDACTED]');
    expect(stripKeys('keep k and kk', ['k', ''])).toBe('keep k and kk');
  });
});
