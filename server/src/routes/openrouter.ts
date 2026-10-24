import type { BridgeConfig } from '../config.js';
import { gatherContext } from '../context.js';
import { buildPrompt } from '../prompts.js';
import { stripKeys } from '../redact.js';
import { requestJson } from './http.js';
import { RouteError, type Route, type RouteRequest, type RouteResult } from './types.js';

// Discovered lists can be long; cap how many models one request cycles through.
const MAX_DISCOVERED_ATTEMPTS = 5;
// Kinds where trying another model may help; anything else (auth, timeout) ends the attempt.
const FALL_THROUGH: ReadonlySet<string> = new Set(['rate_limit', 'unavailable', 'empty', 'other']);

// Resolve global fetch at call time so test stubs and runtime patches are honoured.
const globalFetch: typeof fetch = (...args) => fetch(...args);

function baseUrlOf(cfg: BridgeConfig): string {
  return cfg.openrouter.baseUrl.replace(/\/+$/, '');
}

function isOpenRouter(cfg: BridgeConfig): boolean {
  try {
    return new URL(cfg.openrouter.baseUrl).hostname === 'openrouter.ai';
  } catch {
    return false;
  }
}

function authHeaders(cfg: BridgeConfig): Record<string, string> {
  return cfg.openrouter.apiKey ? { authorization: `Bearer ${cfg.openrouter.apiKey}` } : {};
}

async function discoverModels(cfg: BridgeConfig, signal: AbortSignal): Promise<string[]> {
  const body = (await requestJson(
    globalFetch,
    `${baseUrlOf(cfg)}/models`,
    { method: 'GET', headers: authHeaders(cfg) },
    signal,
    'model list',
  )) as { data?: { id?: unknown }[] };
  const ids = (body?.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
  const chosen = isOpenRouter(cfg) ? ids.filter((id) => id.endsWith(':free')) : ids;
  if (chosen.length === 0) throw new RouteError('unavailable', 'model list: no usable models found');
  return chosen.slice(0, MAX_DISCOVERED_ATTEMPTS);
}

export const openrouterRoute: Route = {
  name: 'openrouter',

  configured(cfg) {
    try {
      new URL(cfg.openrouter.baseUrl);
    } catch {
      return 'openrouter.baseUrl in config.json is not a valid URL.';
    }
    if (isOpenRouter(cfg) && !cfg.openrouter.apiKey) {
      return 'Set the OPENROUTER_API_KEY environment variable (or openrouter.apiKey in config.json) to use the OpenRouter route.';
    }
    return null;
  },

  async ask(req: RouteRequest, cfg: BridgeConfig, signal: AbortSignal): Promise<RouteResult> {
    const hint = this.configured(cfg);
    if (hint) throw new RouteError('not_configured', hint);

    let contextText: string;
    try {
      contextText = (
        await gatherContext({ cwd: req.cwd, question: req.question, paths: req.paths, budgetChars: cfg.openrouter.budgetChars })
      ).text;
    } catch (err) {
      throw new RouteError('other', `could not gather context: ${(err as Error).message}`);
    }
    // Configured keys never leave in the prompt, wherever they were found (question or files).
    const prompt = stripKeys(buildPrompt(req, contextText), [cfg.gemini.apiKey, cfg.openrouter.apiKey]);

    const models = req.model
      ? [req.model]
      : cfg.openrouter.models.length > 0
        ? cfg.openrouter.models
        : await discoverModels(cfg, signal);

    let last: RouteError | undefined;
    for (const model of models) {
      try {
        const data = (await requestJson(
          globalFetch,
          `${baseUrlOf(cfg)}/chat/completions`,
          { method: 'POST', headers: authHeaders(cfg), body: { model, messages: [{ role: 'user', content: prompt }] } },
          signal,
          `chat completion (${model})`,
        )) as { choices?: { message?: { content?: unknown } }[] };
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) throw new RouteError('empty', `${model} returned no text`);
        return { text: content, model };
      } catch (err) {
        if (!(err instanceof RouteError) || !FALL_THROUGH.has(err.kind)) throw err;
        last = err;
      }
    }
    throw last ?? new RouteError('unavailable', 'no models to try');
  },
};
