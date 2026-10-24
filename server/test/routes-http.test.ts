import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type BridgeConfig } from '../src/config.js';
import { RouteError, type RouteRequest } from '../src/routes/types.js';
import { buildPrompt } from '../src/prompts.js';
import { geminiRoute, resolveGeminiModel } from '../src/routes/gemini.js';
import { openrouterRoute } from '../src/routes/openrouter.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-routes-'));

function cfg(over: { gemini?: Partial<BridgeConfig['gemini']>; openrouter?: Partial<BridgeConfig['openrouter']> } = {}): BridgeConfig {
  const c = loadConfig({ homeDir: tmp, env: {} });
  Object.assign(c.gemini, over.gemini);
  Object.assign(c.openrouter, over.openrouter);
  return c;
}

const req: RouteRequest = { question: 'what does main do?', task: 'ask', cwd: tmp };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

function stub(fn: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => fn(String(input), init ?? {}));
  vi.stubGlobal('fetch', mock);
  return mock;
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

async function rejection(p: Promise<unknown>): Promise<RouteError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RouteError);
    return e as RouteError;
  }
  throw new Error('expected rejection');
}

function hangUntilAbort(_url: string, init: RequestInit): Promise<Response> {
  return new Promise<Response>((_res, rej) => {
    init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('gemini route', () => {
  it('configured() returns hint without key', () => {
    expect(geminiRoute.configured(cfg())).toContain('GEMINI_API_KEY');
    expect(geminiRoute.configured(cfg({ gemini: { apiKey: 'k' } }))).toBeNull();
  });

  it('sends key header and parses parts', async () => {
    const mock = stub((url, init) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gm-1:generateContent');
      expect(header(init, 'x-goog-api-key')).toBe('k');
      const body = JSON.parse(String(init.body));
      expect(body.contents[0].role).toBe('user');
      expect(body.contents[0].parts[0].text).toContain('what does main do?');
      return json({ candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }] });
    });
    const res = await geminiRoute.ask(req, cfg({ gemini: { apiKey: 'k', model: 'gm-1' } }), new AbortController().signal);
    expect(res).toEqual({ text: 'ab', model: 'gm-1' });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('discovers the model when none is configured', async () => {
    const mock = stub((url) => {
      if (url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?')) {
        return json({ models: [{ name: 'models/gemini-4-flash', supportedGenerationMethods: ['generateContent'] }] });
      }
      expect(url).toContain('/models/gemini-4-flash:generateContent');
      return json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    });
    const res = await geminiRoute.ask(req, cfg({ gemini: { apiKey: 'k' } }), new AbortController().signal);
    expect(res.model).toBe('gemini-4-flash');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('429 → rate_limit with retryAfterMs 30000', async () => {
    stub(() => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }));
    const err = await rejection(geminiRoute.ask(req, cfg({ gemini: { apiKey: 'k', model: 'gm-1' } }), new AbortController().signal));
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(30000);
  });

  it('maps 401/403 to auth and 5xx / network errors to unavailable', async () => {
    const c = cfg({ gemini: { apiKey: 'k', model: 'gm-1' } });
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [500, 'unavailable'], [503, 'unavailable']] as const) {
      stub(() => new Response('{}', { status }));
      expect((await rejection(geminiRoute.ask(req, c, new AbortController().signal))).kind).toBe(kind);
    }
    stub(() => {
      throw new TypeError('fetch failed');
    });
    expect((await rejection(geminiRoute.ask(req, c, new AbortController().signal))).kind).toBe('unavailable');
  });

  it('no candidates / empty text → empty', async () => {
    const c = cfg({ gemini: { apiKey: 'k', model: 'gm-1' } });
    stub(() => json({ candidates: [] }));
    expect((await rejection(geminiRoute.ask(req, c, new AbortController().signal))).kind).toBe('empty');
    stub(() => json({ candidates: [{ content: { parts: [{ text: '  ' }] } }] }));
    expect((await rejection(geminiRoute.ask(req, c, new AbortController().signal))).kind).toBe('empty');
  });

  it('without a key → not_configured and never calls fetch', async () => {
    const mock = stub(() => json({}));
    const err = await rejection(geminiRoute.ask(req, cfg(), new AbortController().signal));
    expect(err.kind).toBe('not_configured');
    expect(mock).not.toHaveBeenCalled();
  });

  it('abort → RouteError timeout', async () => {
    stub(hangUntilAbort);
    const ac = new AbortController();
    const p = geminiRoute.ask(req, cfg({ gemini: { apiKey: 'k', model: 'gm-1' } }), ac.signal);
    setTimeout(() => ac.abort(), 10);
    expect((await rejection(p)).kind).toBe('timeout');
  });

  it('already-aborted signal → timeout', async () => {
    stub(() => json({}));
    const ac = new AbortController();
    ac.abort();
    expect((await rejection(geminiRoute.ask(req, cfg({ gemini: { apiKey: 'k', model: 'gm-1' } }), ac.signal))).kind).toBe('timeout');
  });

  it('error messages never contain the key', async () => {
    const key = 'secret-' + 'value-123';
    stub(() => new Response(`bad ${key}`, { status: 500 }));
    const err = await rejection(geminiRoute.ask(req, cfg({ gemini: { apiKey: key, model: 'gm-1' } }), new AbortController().signal));
    expect(err.message).not.toContain(key);
  });
});

describe('resolveGeminiModel', () => {
  it('picks highest flash with generateContent', async () => {
    const fetchFn = vi.fn(async () =>
      json({
        models: [
          { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-4-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/gemini-4-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-4-flash-tts', supportedGenerationMethods: ['predict'] },
          // Higher-versioned, generateContent-capable, but not text models: must be skipped.
          { name: 'models/gemini-4.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-4.5-flash-image', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-4.5-flash-native-audio', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-4.5-flash-live', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-embedding-5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    ) as unknown as typeof fetch;
    expect(await resolveGeminiModel(cfg({ gemini: { apiKey: 'k' } }), fetchFn)).toBe('gemini-4-flash');
  });

  it('uses a -latest alias only when no concrete flash model exists', async () => {
    const fetchFn = (async () =>
      json({
        models: [
          { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-4-flash-image', supportedGenerationMethods: ['generateContent'] },
        ],
      })) as unknown as typeof fetch;
    expect(await resolveGeminiModel(cfg({ gemini: { apiKey: 'k' } }), fetchFn)).toBe('gemini-flash-latest');
  });

  it('strips a leading models/ from configured and requested model names', async () => {
    expect(await resolveGeminiModel(cfg({ gemini: { apiKey: 'k', model: 'models/mine' } }), vi.fn() as unknown as typeof fetch)).toBe(
      'mine',
    );
    stub((url) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gm-2:generateContent');
      return json({ candidates: [{ content: { parts: [{ text: 'x' }] } }] });
    });
    const res = await geminiRoute.ask({ ...req, model: 'models/gm-2' }, cfg({ gemini: { apiKey: 'k' } }), new AbortController().signal);
    expect(res.model).toBe('gm-2');
  });

  it('returns the configured model without any request', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    expect(await resolveGeminiModel(cfg({ gemini: { apiKey: 'k', model: 'mine' } }), fetchFn)).toBe('mine');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('no usable flash model → unavailable', async () => {
    const fetchFn = (async () =>
      json({ models: [{ name: 'models/gemini-4-pro', supportedGenerationMethods: ['generateContent'] }] })) as unknown as typeof fetch;
    expect((await rejection(resolveGeminiModel(cfg({ gemini: { apiKey: 'k' } }), fetchFn))).kind).toBe('unavailable');
  });
});

const ok = (text: string) => json({ choices: [{ message: { content: text } }] });

describe('openrouter route', () => {
  it('configured() hints at OPENROUTER_API_KEY for openrouter.ai only', () => {
    expect(openrouterRoute.configured(cfg())).toContain('OPENROUTER_API_KEY');
    expect(openrouterRoute.configured(cfg({ openrouter: { apiKey: 'k' } }))).toBeNull();
  });

  it('sends bearer auth to the chat completions endpoint', async () => {
    stub((url, init) => {
      expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(header(init, 'authorization')).toBe('Bearer k');
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('m1:free');
      expect(body.messages[0].role).toBe('user');
      return ok('hello');
    });
    const res = await openrouterRoute.ask(req, cfg({ openrouter: { apiKey: 'k', models: ['m1:free'] } }), new AbortController().signal);
    expect(res).toEqual({ text: 'hello', model: 'm1:free' });
  });

  it('falls through models on 429', async () => {
    const mock = stub((_url, init) => {
      const model = JSON.parse(String(init.body)).model;
      return model === 'm1:free' ? new Response('{}', { status: 429 }) : ok('from m2');
    });
    const res = await openrouterRoute.ask(req, cfg({ openrouter: { apiKey: 'k', models: ['m1:free', 'm2:free'] } }), new AbortController().signal);
    expect(res.model).toBe('m2:free');
    expect(res.text).toBe('from m2');
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('all models rate limited → rate_limit with retryAfterMs', async () => {
    stub(() => new Response('{}', { status: 429, headers: { 'retry-after': '7' } }));
    const err = await rejection(
      openrouterRoute.ask(req, cfg({ openrouter: { apiKey: 'k', models: ['a:free', 'b:free'] } }), new AbortController().signal),
    );
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(7000);
  });

  it('auth failure stops immediately', async () => {
    const mock = stub(() => new Response('{}', { status: 401 }));
    const err = await rejection(
      openrouterRoute.ask(req, cfg({ openrouter: { apiKey: 'k', models: ['a:free', 'b:free'] } }), new AbortController().signal),
    );
    expect(err.kind).toBe('auth');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('empty content → RouteError empty', async () => {
    stub(() => ok(''));
    const err = await rejection(
      openrouterRoute.ask(req, cfg({ openrouter: { apiKey: 'k', models: ['a:free'] } }), new AbortController().signal),
    );
    expect(err.kind).toBe('empty');
  });

  it('abort → RouteError timeout', async () => {
    const mock = stub(hangUntilAbort);
    const ac = new AbortController();
    const p = openrouterRoute.ask(req, cfg({ openrouter: { apiKey: 'k', models: ['a:free', 'b:free'] } }), ac.signal);
    setTimeout(() => ac.abort(), 10);
    expect((await rejection(p)).kind).toBe('timeout');
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('discovers :free models on openrouter.ai when none configured', async () => {
    const seen: string[] = [];
    stub((url, init) => {
      if (url === 'https://openrouter.ai/api/v1/models') {
        return json({ data: [{ id: 'paid/model' }, { id: 'x/y:free' }, { id: 'z/w:free' }] });
      }
      seen.push(JSON.parse(String(init.body)).model);
      return ok('hi');
    });
    const res = await openrouterRoute.ask(req, cfg({ openrouter: { apiKey: 'k' } }), new AbortController().signal);
    expect(res.model).toBe('x/y:free');
    expect(seen).toEqual(['x/y:free']);
  });

  it('custom baseUrl without key is configured and sends no Authorization header', async () => {
    const c = cfg({ openrouter: { baseUrl: 'http://localhost:3001/v1/', models: ['auto'] } });
    expect(openrouterRoute.configured(c)).toBeNull();
    stub((url, init) => {
      expect(url).toBe('http://localhost:3001/v1/chat/completions');
      expect(header(init, 'authorization')).toBeNull();
      return ok('local');
    });
    const res = await openrouterRoute.ask(req, c, new AbortController().signal);
    expect(res).toEqual({ text: 'local', model: 'auto' });
  });

  it('custom baseUrl with a key sends it as bearer', async () => {
    stub((_url, init) => {
      expect(header(init, 'authorization')).toBe('Bearer k');
      return ok('x');
    });
    await openrouterRoute.ask(
      req,
      cfg({ openrouter: { baseUrl: 'http://localhost:3001/v1', apiKey: 'k', models: ['auto'] } }),
      new AbortController().signal,
    );
  });

  it('custom baseUrl discovery does not filter :free', async () => {
    const seen: string[] = [];
    stub((url, init) => {
      if (url === 'http://localhost:3001/v1/models') return json({ data: [{ id: 'gpt-x' }, { id: 'other:free' }] });
      seen.push(JSON.parse(String(init.body)).model);
      return seen.length === 1 ? new Response('{}', { status: 429 }) : ok('fine');
    });
    const res = await openrouterRoute.ask(req, cfg({ openrouter: { baseUrl: 'http://localhost:3001/v1' } }), new AbortController().signal);
    expect(seen).toEqual(['gpt-x', 'other:free']);
    expect(res.model).toBe('other:free');
  });

  it('error messages never contain the key', async () => {
    const key = 'secret-' + 'value-456';
    stub(() => new Response(`bad ${key}`, { status: 502 }));
    const err = await rejection(
      openrouterRoute.ask(req, cfg({ openrouter: { apiKey: key, models: ['a:free'] } }), new AbortController().signal),
    );
    expect(err.message).not.toContain(key);
  });
});

describe('configured keys never reach the prompt', () => {
  // Plain-looking values, so only the configured-key stripping (not pattern redaction) can remove them.
  const gKey = 'gemini-' + 'configured-value-1';
  const oKey = 'openrouter-' + 'configured-value-2';

  function keyProject(): string {
    const dir = fs.mkdtempSync(path.join(tmp, 'proj-'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), `the keys are ${gKey} and ${oKey}\n`);
    return dir;
  }

  it('gemini route strips both keys from question and files', async () => {
    let sent = '';
    stub((_url, init) => {
      sent = String(init.body);
      return json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    });
    const c = cfg({ gemini: { apiKey: gKey, model: 'gm-1' }, openrouter: { apiKey: oKey } });
    await geminiRoute.ask({ ...req, question: `why is ${gKey} here?`, cwd: keyProject() }, c, new AbortController().signal);
    expect(sent).toContain('notes.txt');
    expect(sent).toContain('[REDACTED]');
    expect(sent).not.toContain(gKey);
    expect(sent).not.toContain(oKey);
  });

  it('openrouter route strips both keys from question and files', async () => {
    let sent = '';
    stub((_url, init) => {
      sent = String(init.body);
      return ok('fine');
    });
    const c = cfg({ gemini: { apiKey: gKey }, openrouter: { apiKey: oKey, models: ['a:free'] } });
    await openrouterRoute.ask({ ...req, question: `is ${oKey} valid?`, cwd: keyProject() }, c, new AbortController().signal);
    expect(sent).toContain('notes.txt');
    expect(sent).not.toContain(gKey);
    expect(sent).not.toContain(oKey);
  });
});

describe('buildPrompt', () => {
  it('contains the question, file:line citation and concision instructions', () => {
    const p = buildPrompt(req);
    expect(p).toContain('what does main do?');
    expect(p).toContain('file:line');
    expect(p.toLowerCase()).toContain('concise');
  });

  it('plan task asks for an implementation plan', () => {
    expect(buildPrompt({ ...req, task: 'plan' })).toContain('implementation plan');
  });

  it('includes provided context', () => {
    expect(buildPrompt(req, '=== a.ts ===\nconst x = 1;')).toContain('const x = 1;');
  });
});
