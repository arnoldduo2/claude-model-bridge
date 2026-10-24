import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BridgeConfig } from '../config.js';
import { buildPrompt } from '../prompts.js';
import { stripKeys } from '../redact.js';
import { RouteError, type FailureKind, type Route, type RouteRequest, type RouteResult } from './types.js';

// How agy is driven is recorded in docs/findings.md. In short: print mode with JSON output, no shell, no TTY, and a
// custom agent whose tool list has no write, shell or MCP tools. The default agent writes files and runs allow-listed
// commands in print mode, so it is never used.

/** The only tools the bridge's agy agent gets. */
export const READ_ONLY_TOOLS = ['view_file', 'list_dir', 'grep_search', 'find_by_name'] as const;

const AGENT_PREFIX = 'cmb-readonly-';
const AGENT_FILE_RE = /^cmb-readonly-[0-9a-f]{16}\.md$/;
const AGENT_WORKSPACE = 'agy-workspace';
// Windows limits a whole command line to 32767 characters.
const MAX_PROMPT_CHARS = 30_000;
const MAX_OUTPUT_BYTES = 5_000_000;
// After a kill, how long to wait for the process to report its exit before giving up on it.
const KILL_GRACE_MS = 2_000;

const INSTALL_HINT =
  'Antigravity CLI (agy) not found. To install it on Windows (PowerShell): irm https://antigravity.google/cli/install.ps1 | iex — then run agy once in a terminal and sign in. If agy is installed somewhere else, set antigravity.command in ~/.claude-model-bridge/config.json to its full path.';

export interface ReadOnlyAgent {
  /** Agent name passed to --agent. */
  name: string;
  /** Bridge-owned folder holding .agents/agents/<name>.md, passed to --add-dir. */
  dir: string;
}

function agentDefinition(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'description: Read-only code analysis agent used by Claude Model Bridge.',
    'tools:',
    ...READ_ONLY_TOOLS.map((t) => `  - ${t}`),
    'mainAgent: true',
    'subagent: false',
    'inheritMcp: false',
    'commandExecutionPolicy: off',
    '---',
    '',
    '# System Prompt',
    'You are a read-only code analysis assistant. You can only view, list and search files. You never create, modify or delete files and never run commands.',
    '',
  ].join('\n');
}

/**
 * Writes (or repairs) the bridge's read-only agy agent under <homeDir>/agy-workspace and returns it.
 * The name has a random suffix made once per install, so a project cannot shadow it with an agent of the same name.
 */
export function ensureReadOnlyAgent(homeDir: string): ReadOnlyAgent {
  const dir = path.join(homeDir, AGENT_WORKSPACE);
  const agentsDir = path.join(dir, '.agents', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  const existing = fs.readdirSync(agentsDir).filter((f) => AGENT_FILE_RE.test(f)).sort()[0];
  const name = existing ? existing.slice(0, -'.md'.length) : AGENT_PREFIX + crypto.randomBytes(8).toString('hex');
  const file = path.join(agentsDir, `${name}.md`);
  const want = agentDefinition(name);
  let have: string | undefined;
  try {
    have = fs.readFileSync(file, 'utf8');
  } catch {
    have = undefined;
  }
  if (have !== want) fs.writeFileSync(file, want, 'utf8');
  return { name, dir };
}

export function buildAgyArgs(prompt: string, agent: ReadOnlyAgent, model?: string): string[] {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--disable-slash-commands',
    '--agent',
    agent.name,
    '--add-dir',
    agent.dir,
  ];
  if (model) args.push('--model', model);
  return args;
}

/** Splits `cfg.antigravity.command` into executable and leading arguments. Double quotes group words. */
export function splitCommand(command: string): string[] {
  const trimmed = command.trim();
  if (isFile(trimmed)) return [trimmed];
  const parts: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(trimmed); m; m = re.exec(trimmed)) parts.push(m[1] ?? m[2]);
  return parts;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function windowsExtensions(): string[] {
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  return ['', ...exts.map((e) => e.toLowerCase())];
}

/** Absolute path of the executable, or null. Bare names are looked up on PATH (and agy's default install folder). */
function resolveExecutable(name: string): string | null {
  const win = process.platform === 'win32';
  const candidates = (base: string) => (win && !path.extname(base) ? windowsExtensions().map((e) => base + e) : [base]);
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    return candidates(path.resolve(name)).find(isFile) ?? null;
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (win && name.toLowerCase() === 'agy' && process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, 'agy', 'bin'));
  }
  for (const d of dirs) {
    const hit = candidates(path.join(d, name)).find(isFile);
    if (hit) return hit;
  }
  return null;
}

type Resolved = { exe: string; args: string[] } | { hint: string };
const resolveCache = new Map<string, Resolved>();

function resolveCommand(command: string): Resolved {
  const cached = resolveCache.get(command);
  if (cached) return cached;
  const [first, ...rest] = splitCommand(command);
  let result: Resolved;
  const exe = first ? resolveExecutable(first) : null;
  if (!exe) {
    result = { hint: INSTALL_HINT };
  } else if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(exe)) {
    // Node can only start a .cmd through cmd.exe, which would re-parse the prompt. Require the real .exe instead.
    result = { hint: `antigravity.command resolves to ${exe}, a batch file. Set antigravity.command to the full path of agy.exe.` };
  } else {
    result = { exe, args: rest };
  }
  resolveCache.set(command, result);
  return result;
}

function projectPrompt(req: RouteRequest): string {
  return [
    buildPrompt(req),
    [
      'Project files:',
      `Not attached. Read what you need yourself from the project folder ${req.cwd} with your file tools, and stay inside that folder.`,
      'Never open, read or quote .env files (.env, .env.*), private keys or certificates (*.pem, *.key, *.p12, *.pfx, id_rsa*, id_ed25519*), or credential and secret stores (credentials*, secrets*, *.keystore, .npmrc, .netrc, .pypirc, service-account JSON). If the answer depends on them, say so instead.',
    ].join('\n'),
  ].join('\n\n');
}

/** Kills the process and everything it started. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on('error', () => child.kill('SIGKILL'));
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

interface AgyEnvelope {
  status?: string;
  response?: string;
  error?: string;
  denied_actions?: { action?: string; display_name?: string }[];
}

function parseEnvelope(stdout: string): AgyEnvelope | null {
  const tryParse = (s: string): AgyEnvelope | null => {
    try {
      const v: unknown = JSON.parse(s);
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as AgyEnvelope) : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(stdout.trim());
  if (whole) return whole;
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  return lines.length > 0 ? tryParse(lines[lines.length - 1]) : null;
}

/** First meaningful lines of an error, without account e-mail addresses, kept short for logs and footers. */
function summarise(text: string): string {
  const s = text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' | ');
  return s.length > 300 ? `${s.slice(0, 297)}...` : s;
}

/** Maps agy's error text (see docs/findings.md) to a failure kind. */
export function classifyAgyError(text: string): FailureKind {
  if (/unknown agent/i.test(text)) return 'unavailable';
  if (/RESOURCE_EXHAUSTED|quota|rate.?limit|too many requests|credits balance is too low|\b429\b/i.test(text)) return 'rate_limit';
  if (/UNAUTHENTICATED|authenticat|\blog ?(back )?in\b|\bsign ?in\b|\bsigned out\b|\bnot signed\b|\b401\b/i.test(text)) return 'auth';
  if (/UNAVAILABLE|\b503\b|network|connection|timed? ?out|DEADLINE_EXCEEDED/i.test(text)) return 'unavailable';
  return 'other';
}

function failure(code: number | null, envelope: AgyEnvelope | null, stderr: string): RouteError {
  const text = [envelope?.error ?? '', stderr].filter(Boolean).join('\n');
  const kind = classifyAgyError(text);
  const detail = summarise(text) || `agy exited with code ${code}`;
  if (kind === 'unavailable' && /unknown agent/i.test(text)) {
    return new RouteError(
      'unavailable',
      "agy did not load the bridge's read-only agent (is the project folder trusted in agy?); not running without it",
    );
  }
  return new RouteError(kind, `agy (exit ${code}): ${detail}`);
}

export const antigravityRoute: Route = {
  name: 'antigravity',

  configured(cfg) {
    const r = resolveCommand(cfg.antigravity.command);
    return 'hint' in r ? r.hint : null;
  },

  async ask(req: RouteRequest, cfg: BridgeConfig, signal: AbortSignal): Promise<RouteResult> {
    const resolved = resolveCommand(cfg.antigravity.command);
    if ('hint' in resolved) throw new RouteError('not_configured', resolved.hint);

    if (fs.existsSync(path.join(req.cwd, '.agents', 'hooks.json'))) {
      throw new RouteError(
        'unavailable',
        'the project defines agy hooks (.agents/hooks.json), which can run commands; not delegating to antigravity',
      );
    }

    let agent: ReadOnlyAgent;
    try {
      agent = ensureReadOnlyAgent(cfg.homeDir);
    } catch (err) {
      throw new RouteError('other', `could not write the read-only agy agent: ${(err as Error).message}`);
    }

    const prompt = stripKeys(projectPrompt(req), [cfg.gemini.apiKey, cfg.openrouter.apiKey]);
    if (prompt.length > MAX_PROMPT_CHARS) {
      throw new RouteError('other', `question too long for the agy command line (${prompt.length} > ${MAX_PROMPT_CHARS} characters)`);
    }
    if (signal.aborted) throw new RouteError('timeout', 'no response before the route timeout');

    const args = [...resolved.args, ...buildAgyArgs(prompt, agent, req.model)];
    return new Promise<RouteResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(resolved.exe, args, {
          cwd: req.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
          env: process.env,
        });
      } catch (err) {
        reject(new RouteError('unavailable', `could not start agy: ${(err as Error).message}`));
        return;
      }

      const out: Buffer[] = [];
      const errOut: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      let killedFor: RouteError | undefined;
      let graceTimer: NodeJS.Timeout | undefined;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer) clearTimeout(graceTimer);
        signal.removeEventListener('abort', onAbort);
        fn();
      };
      const stop = (why: RouteError) => {
        if (killedFor || settled) return;
        killedFor = why;
        killTree(child);
        // Normally the exit event settles the promise; this is the fallback if it never arrives.
        graceTimer = setTimeout(() => finish(() => reject(why)), KILL_GRACE_MS);
      };
      const onAbort = () => stop(new RouteError('timeout', 'no response before the route timeout'));
      const timer = setTimeout(
        () => stop(new RouteError('timeout', `agy gave no answer within ${cfg.antigravity.timeoutMs} ms`)),
        cfg.antigravity.timeoutMs,
      );
      signal.addEventListener('abort', onAbort, { once: true });

      const collect = (sink: Buffer[]) => (d: Buffer) => {
        bytes += d.length;
        if (bytes > MAX_OUTPUT_BYTES) {
          stop(new RouteError('other', 'agy produced more output than the bridge accepts'));
          return;
        }
        sink.push(d);
      };
      child.stdout?.on('data', collect(out));
      child.stderr?.on('data', collect(errOut));

      child.on('error', (err) => finish(() => reject(new RouteError('unavailable', `could not start agy: ${err.message}`))));
      // After a kill, settle on exit: a surviving grandchild could keep the pipes (and so 'close') open.
      child.on('exit', () => {
        if (killedFor) {
          const why = killedFor;
          finish(() => reject(why));
        }
      });
      child.on('close', (code) => {
        if (killedFor) {
          const why = killedFor;
          finish(() => reject(why));
          return;
        }
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(errOut).toString('utf8');
        const envelope = parseEnvelope(stdout);
        finish(() => {
          if (code === 0 && envelope?.status === 'SUCCESS') {
            const text = envelope.response ?? '';
            if (text.trim()) {
              resolve({ text, model: req.model ?? 'agy' });
              return;
            }
            const denied = (envelope.denied_actions ?? []).map((d) => d.action ?? d.display_name).filter(Boolean);
            reject(
              new RouteError('empty', `agy returned no text${denied.length ? ` (denied actions: ${[...new Set(denied)].join(', ')})` : ''}`),
            );
            return;
          }
          if (code === 0 && !envelope) {
            reject(new RouteError('other', `agy output was not the expected JSON: ${summarise(stdout) || '(no output)'}`));
            return;
          }
          reject(failure(code, envelope, stderr));
        });
      });
    });
  },
};
