import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, loadConfig } from '../src/config.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-config-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeConfig(obj: unknown): void {
  fs.writeFileSync(path.join(tmp, 'config.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
}

describe('loadConfig', () => {
  it('defaults when no file', () => {
    const cfg = loadConfig({ homeDir: tmp, env: {} });
    expect(cfg.routeOrder).toEqual(['antigravity', 'gemini', 'openrouter']);
    expect(cfg.antigravity.timeoutMs).toBe(180000);
    expect(cfg.antigravity.command).toBe('agy');
    expect(cfg.gemini.budgetChars).toBe(400000);
    expect(cfg.openrouter.models).toEqual([]);
    expect(cfg.cooldownMs).toBe(60000);
    expect(cfg.log.fullText).toBe(false);
    expect(cfg.homeDir).toBe(tmp);
  });

  it('defaults homeDir to ~/.claude-model-bridge', () => {
    const cfg = loadConfig({ env: {} });
    expect(cfg.homeDir).toBe(path.join(os.homedir(), '.claude-model-bridge'));
  });

  it('env keys override file', () => {
    writeConfig({ gemini: { apiKey: 'file' }, openrouter: { apiKey: 'file-or' } });
    const cfg = loadConfig({ homeDir: tmp, env: { GEMINI_API_KEY: 'env' } });
    expect(cfg.gemini.apiKey).toBe('env');
    expect(cfg.openrouter.apiKey).toBe('file-or');
    const cfg2 = loadConfig({ homeDir: tmp, env: { OPENROUTER_API_KEY: 'env-or' } });
    expect(cfg2.gemini.apiKey).toBe('file');
    expect(cfg2.openrouter.apiKey).toBe('env-or');
  });

  it('file merges deeply', () => {
    writeConfig({ gemini: { model: 'm1' } });
    const cfg = loadConfig({ homeDir: tmp, env: {} });
    expect(cfg.gemini.model).toBe('m1');
    expect(cfg.gemini.timeoutMs).toBe(120000);
    expect(cfg.gemini.budgetChars).toBe(400000);
  });

  it('treats an empty apiKey in the file as unset', () => {
    writeConfig({ gemini: { apiKey: '' }, openrouter: { apiKey: '' } });
    const cfg = loadConfig({ homeDir: tmp, env: {} });
    expect(cfg.gemini.apiKey).toBeUndefined();
    expect(cfg.openrouter.apiKey).toBeUndefined();
  });

  it('config.example.json loads to the defaults', () => {
    const example = path.resolve(import.meta.dirname, '../../config.example.json');
    writeConfig(fs.readFileSync(example, 'utf8'));
    const cfg = loadConfig({ homeDir: tmp, env: {} });
    expect(cfg.gemini).toEqual({ timeoutMs: 120000, budgetChars: 400000 });
    expect(cfg.openrouter).toEqual({
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [],
      timeoutMs: 120000,
      budgetChars: 100000,
    });
  });

  it('openrouter.baseUrl defaults to OpenRouter and a file value overrides it', () => {
    expect(loadConfig({ homeDir: tmp, env: {} }).openrouter.baseUrl).toBe('https://openrouter.ai/api/v1');
    writeConfig({ openrouter: { baseUrl: 'http://localhost:3001/v1' } });
    const cfg = loadConfig({ homeDir: tmp, env: {} });
    expect(cfg.openrouter.baseUrl).toBe('http://localhost:3001/v1');
    expect(cfg.openrouter.timeoutMs).toBe(120000);
  });

  it('bad JSON throws with path', () => {
    writeConfig('{ not json');
    expect(() => loadConfig({ homeDir: tmp, env: {} })).toThrow(/config\.json/);
  });

  it('bad JSON error never quotes the file contents', () => {
    const key = 'file-' + 'secret-value-123';
    writeConfig(`{"gemini": {"apiKey": "${key}"`);
    let message = '';
    try {
      loadConfig({ homeDir: tmp, env: {} });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).file).toBe(path.join(tmp, 'config.json'));
      message = (err as Error).message;
    }
    expect(message).toContain(path.join(tmp, 'config.json'));
    expect(message).not.toContain(key);
  });

  it.each([
    [{ gemini: null }, 'gemini must be an object'],
    [{ openrouter: 'x' }, 'openrouter must be an object'],
    [{ log: [] }, 'log must be an object'],
    [{ antigravity: 5 }, 'antigravity must be an object'],
    [{ gemini: { timeoutMs: '1000' } }, 'gemini.timeoutMs must be a positive number'],
    [{ gemini: { budgetChars: -1 } }, 'gemini.budgetChars must be a positive number'],
    [{ openrouter: { timeoutMs: 0 } }, 'openrouter.timeoutMs must be a positive number'],
    [{ antigravity: { timeoutMs: null } }, 'antigravity.timeoutMs must be a positive number'],
    [{ cooldownMs: 'soon' }, 'cooldownMs must be a positive number'],
    [{ routeOrder: 'gemini' }, 'routeOrder must be an array of route names'],
    [{ routeOrder: ['gemini', 'claude'] }, 'routeOrder must be an array of route names'],
    [{ openrouter: { models: 'm1:free' } }, 'openrouter.models must be an array of strings'],
    [{ openrouter: { models: ['a', 2] } }, 'openrouter.models must be an array of strings'],
    [{ openrouter: { baseUrl: 42 } }, 'openrouter.baseUrl must be a string'],
    [{ gemini: { apiKey: 12345 } }, 'gemini.apiKey must be a string'],
    [{ gemini: { model: ['m'] } }, 'gemini.model must be a string'],
    [{ openrouter: { apiKey: true } }, 'openrouter.apiKey must be a string'],
    [{ log: { fullText: 'yes' } }, 'log.fullText must be true or false'],
  ])('rejects %j with the config path and field', (obj, expected) => {
    writeConfig(obj);
    let message = '';
    try {
      loadConfig({ homeDir: tmp, env: {} });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain(expected);
    expect(message).toContain(path.join(tmp, 'config.json'));
    expect(message).not.toContain('12345');
  });

  it('accepts an empty routeOrder and ignores unknown fields', () => {
    writeConfig({ routeOrder: [], extra: { anything: 1 }, gemini: { note: 5 } });
    expect(loadConfig({ homeDir: tmp, env: {} }).routeOrder).toEqual([]);
  });

  it('Desktop manifest gives every optional key field an empty default', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../desktop/manifest.json'), 'utf8'));
    for (const field of Object.values(manifest.user_config) as Array<{ required?: boolean; default?: unknown }>) {
      if (!field.required) expect(field.default).toBe('');
    }
  });

  it('ignores env values that are unexpanded Claude Desktop placeholders', () => {
    writeConfig({ gemini: { apiKey: 'from-file-g' }, openrouter: { apiKey: 'from-file-o' } });
    const cfg = loadConfig({
      homeDir: tmp,
      env: { GEMINI_API_KEY: '${user_config.gemini_api_key}', OPENROUTER_API_KEY: '${user_config.openrouter_api_key}' },
    });
    expect(cfg.gemini.apiKey).toBe('from-file-g');
    expect(cfg.openrouter.apiKey).toBe('from-file-o');
    const none = loadConfig({ homeDir: path.join(tmp, 'missing'), env: { GEMINI_API_KEY: '${user_config.gemini_api_key}' } });
    expect(none.gemini.apiKey).toBeUndefined();
  });
});
