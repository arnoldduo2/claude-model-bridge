import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type RouteName = 'antigravity' | 'gemini' | 'openrouter';

export interface BridgeConfig {
  routeOrder: RouteName[];
  antigravity: { command: string; timeoutMs: number };
  gemini: { apiKey?: string; model?: string; timeoutMs: number; budgetChars: number };
  openrouter: { apiKey?: string; baseUrl: string; models: string[]; timeoutMs: number; budgetChars: number };
  cooldownMs: number;
  log: { fullText: boolean };
  homeDir: string;
}

function defaults(homeDir: string): BridgeConfig {
  return {
    routeOrder: ['antigravity', 'gemini', 'openrouter'],
    antigravity: { command: 'agy', timeoutMs: 180_000 },
    gemini: { timeoutMs: 120_000, budgetChars: 400_000 },
    openrouter: { baseUrl: 'https://openrouter.ai/api/v1', models: [], timeoutMs: 120_000, budgetChars: 100_000 },
    cooldownMs: 60_000,
    log: { fullText: false },
    homeDir,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Objects merge recursively; arrays and scalars from `src` replace those in `dst`.
function deepMerge(dst: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(src)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const current = dst[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      deepMerge(current, value);
    } else {
      dst[key] = value;
    }
  }
  return dst;
}

/** A config.json problem. The message names the file and the field but never contains a configured value. */
export class ConfigError extends Error {
  constructor(
    public file: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const ROUTE_NAMES: readonly RouteName[] = ['antigravity', 'gemini', 'openrouter'];

/** Where loadConfig reads from when no homeDir is given. */
export function defaultHomeDir(): string {
  return path.join(os.homedir(), '.claude-model-bridge');
}

function readConfigFile(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ConfigError(file, `Cannot read ${file} (${(err as NodeJS.ErrnoException).code ?? 'read error'})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (err) {
    // V8 messages can quote part of the file (which may hold a key), so keep only the position.
    const msg = (err as Error).message;
    const where = /\(line \d+ column \d+\)/.exec(msg)?.[0] ?? /at position \d+/.exec(msg)?.[0] ?? '';
    throw new ConfigError(file, `Invalid JSON in ${file}${where ? ` ${where}` : ''}`);
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError(file, `Invalid config in ${file}: top-level value must be a JSON object`);
  }
  validateConfig(file, parsed);
  return parsed;
}

type FieldCheck = 'object' | 'string' | 'boolean' | 'positive' | 'strings' | 'routes';

// Fields config.json may set, with the type each must have. Unknown fields are ignored.
const FIELDS: Record<string, FieldCheck> = {
  routeOrder: 'routes',
  cooldownMs: 'positive',
  antigravity: 'object',
  'antigravity.command': 'string',
  'antigravity.timeoutMs': 'positive',
  gemini: 'object',
  'gemini.apiKey': 'string',
  'gemini.model': 'string',
  'gemini.timeoutMs': 'positive',
  'gemini.budgetChars': 'positive',
  openrouter: 'object',
  'openrouter.apiKey': 'string',
  'openrouter.baseUrl': 'string',
  'openrouter.models': 'strings',
  'openrouter.timeoutMs': 'positive',
  'openrouter.budgetChars': 'positive',
  log: 'object',
  'log.fullText': 'boolean',
};

const EXPECTED: Record<FieldCheck, string> = {
  object: 'an object',
  string: 'a string',
  boolean: 'true or false',
  positive: 'a positive number',
  strings: 'an array of strings',
  routes: `an array of route names (${ROUTE_NAMES.join(', ')})`,
};

function fieldOk(check: FieldCheck, v: unknown): boolean {
  switch (check) {
    case 'object':
      return isPlainObject(v);
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'positive':
      return typeof v === 'number' && Number.isFinite(v) && v > 0;
    case 'strings':
      return Array.isArray(v) && v.every((s) => typeof s === 'string');
    case 'routes':
      return Array.isArray(v) && v.every((s) => typeof s === 'string' && (ROUTE_NAMES as readonly string[]).includes(s));
  }
}

function validateConfig(file: string, parsed: Record<string, unknown>): void {
  for (const [field, check] of Object.entries(FIELDS)) {
    const [section, key] = field.split('.');
    const holder = key === undefined ? parsed : parsed[section];
    if (!isPlainObject(holder)) continue; // a bad section is reported by its own entry
    const value = key === undefined ? holder[section] : holder[key];
    if (value === undefined) continue;
    if (!fieldOk(check, value)) {
      throw new ConfigError(file, `Invalid config in ${file}: ${field} must be ${EXPECTED[check]}`);
    }
  }
}

// Claude Desktop (mcpb) passes `${user_config.x}` through literally when an optional field is left blank.
function envValue(v: string | undefined): string | undefined {
  if (!v || /^\$\{user_config\./.test(v)) return undefined;
  return v;
}

export function loadConfig(opts: { homeDir?: string; env?: NodeJS.ProcessEnv } = {}): BridgeConfig {
  const homeDir = opts.homeDir ?? defaultHomeDir();
  const env = opts.env ?? process.env;

  const merged = deepMerge(
    defaults(homeDir) as unknown as Record<string, unknown>,
    readConfigFile(path.join(homeDir, 'config.json')),
  ) as unknown as BridgeConfig;

  // homeDir is where the config was found, never something the file may redirect.
  merged.homeDir = homeDir;

  // Empty strings (as in config.example.json) mean "not set".
  if (!merged.gemini.apiKey) delete merged.gemini.apiKey;
  if (!merged.gemini.model) delete merged.gemini.model;
  if (!merged.openrouter.apiKey) delete merged.openrouter.apiKey;

  const geminiKey = envValue(env.GEMINI_API_KEY);
  const openrouterKey = envValue(env.OPENROUTER_API_KEY);
  if (geminiKey) merged.gemini.apiKey = geminiKey;
  if (openrouterKey) merged.openrouter.apiKey = openrouterKey;

  return merged;
}
