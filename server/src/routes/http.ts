import { RouteError } from './types.js';

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function timeoutError(): RouteError {
  return new RouteError('timeout', 'request aborted or timed out');
}

/**
 * Sends a JSON request and returns the parsed JSON body, mapping every failure to a RouteError.
 * Messages carry only the HTTP status or error code, never headers, bodies or URLs, so keys cannot leak.
 */
export async function requestJson(
  fetchFn: typeof fetch,
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: unknown },
  signal: AbortSignal,
  label: string,
): Promise<unknown> {
  if (signal.aborted) throw timeoutError();
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: init.method,
      headers: init.method === 'POST' ? { 'content-type': 'application/json', ...init.headers } : init.headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal,
    });
  } catch (err) {
    if (signal.aborted || (err as Error)?.name === 'AbortError') throw timeoutError();
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    throw new RouteError('unavailable', `${label}: network error${code ? ` (${code})` : ''}`);
  }
  if (!res.ok) {
    const status = res.status;
    if (status === 429) {
      throw new RouteError('rate_limit', `${label}: HTTP 429`, parseRetryAfter(res.headers.get('retry-after')));
    }
    if (status === 401 || status === 403) throw new RouteError('auth', `${label}: HTTP ${status}`);
    if (status >= 500) throw new RouteError('unavailable', `${label}: HTTP ${status}`);
    throw new RouteError('other', `${label}: HTTP ${status}`);
  }
  try {
    return await res.json();
  } catch {
    if (signal.aborted) throw timeoutError();
    throw new RouteError('other', `${label}: response was not valid JSON`);
  }
}
