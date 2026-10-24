import type { BridgeConfig } from '../config.js';
import { gatherContext } from '../context.js';
import { buildPrompt } from '../prompts.js';
import { stripKeys } from '../redact.js';
import { requestJson } from './http.js';
import { RouteError, type Route, type RouteRequest, type RouteResult } from './types.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Resolve global fetch at call time so test stubs and runtime patches are honoured.
const globalFetch: typeof fetch = (...args) => fetch(...args);

function headers(apiKey: string): Record<string, string> {
  return { 'x-goog-api-key': apiKey };
}

function versionOf(name: string): number[] {
  return (name.match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// Variants that support generateContent but are not general text models.
const NON_TEXT_MODEL = /tts|image|audio|live|embed|vision-only/i;

/** Accepts "models/gemini-x" as well as "gemini-x". */
export function bareModelName(name: string): string {
  return name.trim().replace(/^models\//, '');
}

interface ModelEntry {
  name?: string;
  supportedGenerationMethods?: string[];
}

/**
 * Configured model if set, otherwise the highest-versioned flash text model that supports generateContent.
 * `-latest` aliases are skipped when a concrete version exists, because the alias can move to a different
 * or preview model without notice; they are used only when nothing else qualifies.
 */
export async function resolveGeminiModel(
  cfg: BridgeConfig,
  fetchFn: typeof fetch = globalFetch,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  if (cfg.gemini.model) return bareModelName(cfg.gemini.model);
  if (!cfg.gemini.apiKey) throw new RouteError('not_configured', 'Set GEMINI_API_KEY to use the Gemini route.');
  const body = (await requestJson(
    fetchFn,
    `${BASE}/models?pageSize=1000`,
    { method: 'GET', headers: headers(cfg.gemini.apiKey) },
    signal,
    'gemini model list',
  )) as { models?: ModelEntry[] };
  const usable = (body?.models ?? [])
    .filter(
      (m) =>
        m.name &&
        /flash/i.test(m.name) &&
        !NON_TEXT_MODEL.test(m.name) &&
        m.supportedGenerationMethods?.includes('generateContent'),
    )
    .map((m) => bareModelName(m.name as string));
  const concrete = usable.filter((n) => !/-latest$/i.test(n));
  const names = concrete.length > 0 ? concrete : usable;
  if (names.length === 0) throw new RouteError('unavailable', 'gemini model list: no flash model supports generateContent');
  // Highest version wins; on a tie the shorter name (plain "flash" over "flash-lite" etc.) wins.
  names.sort((a, b) => compareVersions(versionOf(b), versionOf(a)) || a.length - b.length);
  return names[0];
}

export const geminiRoute: Route = {
  name: 'gemini',

  configured(cfg) {
    return cfg.gemini.apiKey
      ? null
      : 'Set the GEMINI_API_KEY environment variable (or gemini.apiKey in config.json) to use the Gemini API route.';
  },

  async ask(req: RouteRequest, cfg: BridgeConfig, signal: AbortSignal): Promise<RouteResult> {
    const hint = this.configured(cfg);
    if (hint) throw new RouteError('not_configured', hint);
    const apiKey = cfg.gemini.apiKey as string;

    let contextText: string;
    try {
      contextText = (
        await gatherContext({ cwd: req.cwd, question: req.question, paths: req.paths, budgetChars: cfg.gemini.budgetChars })
      ).text;
    } catch (err) {
      throw new RouteError('other', `could not gather context: ${(err as Error).message}`);
    }

    const model = req.model ? bareModelName(req.model) : await resolveGeminiModel(cfg, globalFetch, signal);
    const data = (await requestJson(
      globalFetch,
      `${BASE}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: headers(apiKey),
        // Configured keys never leave in the prompt, wherever they were found (question or files).
        body: {
          contents: [
            { role: 'user', parts: [{ text: stripKeys(buildPrompt(req, contextText), [cfg.gemini.apiKey, cfg.openrouter.apiKey]) }] },
          ],
        },
      },
      signal,
      'gemini',
    )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };

    const text = (data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    if (!text.trim()) throw new RouteError('empty', 'gemini returned no text');
    return { text, model };
  },
};
