import type { BridgeConfig, RouteName } from '../config.js';

export type TaskKind = 'explore' | 'plan' | 'review' | 'ask';

export interface RouteRequest {
  question: string;
  task: TaskKind;
  cwd: string;
  paths?: string[];
  model?: string;
}

export interface RouteResult {
  text: string;
  model: string;
}

export type FailureKind = 'not_configured' | 'rate_limit' | 'timeout' | 'auth' | 'unavailable' | 'empty' | 'other';

export class RouteError extends Error {
  constructor(
    public kind: FailureKind,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RouteError';
  }
}

export interface Route {
  name: RouteName;
  /** null = ready to use, otherwise a setup hint for the user. */
  configured(cfg: BridgeConfig): string | null;
  ask(req: RouteRequest, cfg: BridgeConfig, signal: AbortSignal): Promise<RouteResult>;
}
