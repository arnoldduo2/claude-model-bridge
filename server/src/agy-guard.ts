import fs from 'node:fs';
import path from 'node:path';
import { isSecretDir, isSecretPath } from './context.js';

// PreToolUse guard for the bridge's read-only agy agent. agy runs it before every tool call (see
// docs/findings.md). It is the enforcement layer: the agent's `tools:` list is the first one, but the guard does not
// trust it. Facts it relies on, verified live with agy 1.4.7:
// - stdin is JSON with toolCall {name, args} and workspacePaths (the first entry is the agy cwd);
// - stdout `{"decision":"deny","reason":…}` hard-blocks the call; `{"decision":"allow"}` auto-allows it (agy's own
//   docs: "Automatically allow the tool execution"), which overrides the user's permissions.deny/ask rules for that
//   call. That is acceptable only because the guard allows nothing but view_file/list_dir/find_by_name on
//   non-secret, non-VCS paths inside the project;
// - `{}`, invalid JSON, a non-zero exit and a timeout all block the call, but EMPTY stdout with exit 0 lets it run.
//   So the guard always prints a decision, and every failure path prints a deny.

/** Tools the guard lets through. Everything else is denied, whatever the agent definition says. */
export const GUARD_TOOLS = ['view_file', 'list_dir', 'find_by_name'] as const;

/** The argument of each tool that names the file or folder it touches. */
const PATH_ARG: Record<(typeof GUARD_TOOLS)[number], string> = {
  view_file: 'AbsolutePath',
  list_dir: 'DirectoryPath',
  find_by_name: 'SearchDirectory',
};

/** Env var through which the route tells the guard which project folder this run may read. */
export const GUARD_PROJECT_ENV = 'CMB_AGY_PROJECT';

export interface GuardDecision {
  decision: 'allow' | 'deny';
  reason?: string;
}

// Version-control folders: .git/config can hold a remote URL with an embedded token, and the other two keep
// credentials and history the same way. Other heavy folders (node_modules, vendor, dist…) stay readable: they hold
// no secrets beyond what the secret rules already catch, and dependency code can matter for an answer.
const VCS_DIRS = new Set(['.git', '.svn', '.hg']);

function hasVcsSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((s) => VCS_DIRS.has(s.toLowerCase()));
}

const MAX_PAYLOAD_BYTES = 1_000_000;
const STDIN_TIMEOUT_MS = 5_000;

const win = process.platform === 'win32';
const norm = (p: string) => (win ? path.resolve(p).toLowerCase() : path.resolve(p));

function inside(parent: string, child: string): boolean {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function deny(reason: string): GuardDecision {
  return { decision: 'deny', reason: `Blocked by Claude Model Bridge: ${reason}` };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Why a tool path is refused, or null when it is a non-secret path inside the project. */
function pathProblem(raw: string, project: string, projectReal: string): string | null {
  if (!raw.trim()) return 'empty path';
  if (raw.includes('\0')) return 'invalid path';
  let rest = raw;
  if (win) {
    if (/^[\\/]{2}/.test(rest)) return 'UNC and device paths are not allowed';
    rest = rest.replace(/^[A-Za-z]:/, '');
    // `.env:$DATA` or `.env::$DATA` opens `.env` itself.
    if (rest.includes(':')) return 'paths with ":" are not allowed';
  }
  // Windows drops a trailing dot or space from a name, so `.env.` can open `.env`.
  if (rest.split(/[\\/]/).some((s) => s !== '.' && s !== '..' && /[. ]$/.test(s))) {
    return 'path segments ending in a dot or space are not allowed';
  }
  const abs = path.resolve(project, raw);
  if (!inside(project, abs)) return 'path is outside the project folder';
  if (hasVcsSegment(path.relative(project, abs))) return 'version-control folders (.git, .svn, .hg) are not readable';
  let real: string;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    return 'path does not exist';
  }
  if (!inside(projectReal, real)) return 'path resolves outside the project folder';
  const rel = path.relative(projectReal, real).split(path.sep).join('/');
  // The real name counts too: an 8.3 short name such as GIT~1 comes back from realpath as .git.
  if (hasVcsSegment(rel)) return 'version-control folders (.git, .svn, .hg) are not readable';
  if (rel && (isSecretPath(rel) || isSecretDir(rel))) return 'secret or credential file';
  return null;
}

/** The decision for one agy PreToolUse payload. Never throws. */
export function decideAgyToolCall(payload: unknown, project: string | undefined): GuardDecision {
  try {
    if (!project || !path.isAbsolute(project)) return deny('no project folder was given to the guard');
    let projectReal: string;
    try {
      projectReal = fs.realpathSync.native(project);
    } catch {
      return deny('the project folder does not exist');
    }
    if (!isRecord(payload)) return deny('unreadable tool call');
    const ws = payload.workspacePaths;
    if (!Array.isArray(ws) || !ws.some((w) => typeof w === 'string' && (norm(w) === norm(project) || norm(w) === norm(projectReal)))) {
      return deny("agy's workspace is not the bridge's project folder");
    }
    const call = payload.toolCall;
    if (!isRecord(call) || typeof call.name !== 'string') return deny('unreadable tool call');
    const name = call.name;
    if (!(GUARD_TOOLS as readonly string[]).includes(name)) return deny(`tool ${name} is not allowed (read-only)`);
    const args = call.args === undefined ? {} : call.args;
    if (!isRecord(args)) return deny('unreadable tool arguments');
    const required = PATH_ARG[name as (typeof GUARD_TOOLS)[number]];
    if (typeof args[required] !== 'string') return deny(`${name} needs ${required}`);
    for (const [key, value] of Object.entries(args)) {
      if (key !== required && !/path|dir|file|folder/i.test(key)) continue;
      if (typeof value !== 'string') {
        if (key === required) return deny(`${name} needs ${required}`);
        continue;
      }
      const problem = pathProblem(value, project, projectReal);
      if (problem) return deny(`${problem} (${key})`);
    }
    return { decision: 'allow' };
  } catch {
    return deny('guard error');
  }
}

function readStdin(stdin: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => reject(new Error('stdin timeout')), timeoutMs);
    stdin.on('data', (d: Buffer | string) => {
      const b = typeof d === 'string' ? Buffer.from(d) : d;
      size += b.length;
      if (size > MAX_PAYLOAD_BYTES) {
        clearTimeout(timer);
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(b);
    });
    stdin.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Entry point of the hook process: reads the payload, always writes exactly one decision. True if it was written. */
export async function runAgyGuard(
  io: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<boolean> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const env = io.env ?? process.env;
  let decision: GuardDecision;
  try {
    const raw = await readStdin(stdin, io.timeoutMs ?? STDIN_TIMEOUT_MS);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = undefined;
    }
    decision = decideAgyToolCall(payload, env[GUARD_PROJECT_ENV]);
  } catch {
    decision = deny('guard could not read the tool call');
  }
  // Resolves true only when the decision was fully written; the shim sets exit code 0 only then.
  return new Promise<boolean>((resolve) => {
    try {
      stdout.write(JSON.stringify(decision), (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}
