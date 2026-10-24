import { geminiRoute } from './gemini.js';
import { openrouterRoute } from './openrouter.js';
import type { Route } from './types.js';

/** The routes the server uses unless a caller passes its own. */
export function defaultRoutes(): Route[] {
  return [geminiRoute, openrouterRoute];
}
