import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { ConfigError, defaultHomeDir, loadConfig, type BridgeConfig } from './config.js';
import { appendLog, readLog } from './log.js';
import { askWithFallback, formatFooter } from './router.js';
import { defaultRoutes } from './routes/index.js';
import type { Route } from './routes/types.js';
import { formatLog, formatStatus } from './status.js';

const ASK_DESCRIPTION = [
  'Delegate a question to a free model (Antigravity/Gemini, Gemini API or OpenRouter) to save Claude usage.',
  'Use it for broad codebase reading, locating where something is handled, summarising large files or logs, and first-draft plans.',
  'Answers cite file:line; spot-check those references before editing anything based on them.',
  'Never use it for making edits or for anything involving secrets: the question and the files it reads leave this machine.',
  'Pass `cwd` explicitly when the session has no project folder.',
].join(' ');

function reply(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) };
}

/** loadConfig, but a broken config.json is returned instead of thrown so the server still starts. */
export function loadConfigOrError(): BridgeConfig | Error {
  try {
    return loadConfig();
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function configFailure(err: Error) {
  const file = err instanceof ConfigError ? err.file : path.join(defaultHomeDir(), 'config.json');
  return reply(
    [
      `The model bridge cannot load its config file: ${err.message}`,
      `Config file: ${file}`,
      'Fix the field named above (see config.example.json) or remove the file, then restart Claude.',
      'Until then, do this task yourself and tell the user the bridge is not configured correctly.',
    ].join('\n'),
    true,
  );
}

function sameOrInside(child: string, parent: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Why a folder must not be gathered from (it holds credential stores or the bridge's own files), or null. */
function refusedCwd(project: string, cfg: BridgeConfig): string | null {
  if (path.parse(project).root === project) return 'is a drive or filesystem root';
  const home = os.homedir();
  if (home && sameOrInside(home, project)) return 'is your home folder or contains it';
  if (sameOrInside(project, cfg.homeDir) || sameOrInside(cfg.homeDir, project)) {
    return "is or contains the bridge's own config folder";
  }
  return null;
}

export function createServer(cfg: BridgeConfig | Error = loadConfigOrError(), routes: Route[] = defaultRoutes()): McpServer {
  const server = new McpServer({ name: 'claude-model-bridge', version: '0.2.0' });

  server.registerTool(
    'ask_model',
    {
      description: ASK_DESCRIPTION,
      inputSchema: z.object({
        question: z.string().describe('The question or task, self-contained.'),
        task: z.enum(['explore', 'plan', 'review', 'ask']).default('ask').describe('Kind of work; shapes the prompt.'),
        paths: z
          .array(z.string())
          .optional()
          .describe('Files, folders or globs (*, **, ?) relative to cwd. Sent first, ahead of any other file.'),
        route: z
          .enum(['auto', 'antigravity', 'gemini', 'openrouter'])
          .default('auto')
          .describe('Force a route first; auto follows the configured order.'),
        model: z.string().optional().describe('Override the model for this call.'),
        cwd: z.string().optional().describe('Project folder. Defaults to the session project folder.'),
      }),
    },
    async ({ question, task, paths, route, model, cwd }) => {
      if (cfg instanceof Error) return configFailure(cfg);
      const rawCwd = cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
      if (!path.isAbsolute(rawCwd)) {
        return reply(`cwd must be an absolute path, got: ${rawCwd}. Pass cwd explicitly.`, true);
      }
      const project = path.resolve(rawCwd);
      try {
        if (!fs.statSync(project).isDirectory()) throw new Error('not a directory');
      } catch {
        return reply(`cwd does not exist or is not a folder: ${project}. Pass cwd explicitly.`, true);
      }
      const refused = refusedCwd(project, cfg);
      if (refused) {
        return reply(
          `cwd ${project} ${refused}, so its files are not sent anywhere. Pass cwd as the absolute path of a specific project folder.`,
          true,
        );
      }
      try {
        const answer = await askWithFallback({ question, task, paths, route, model, cwd: project }, routes, cfg);
        appendLog(cfg, {
          ts: new Date().toISOString(),
          project,
          task,
          question,
          attempts: answer.attempts,
          ok: answer.ok,
          inChars: question.length,
          outChars: answer.text.length,
          ms: answer.ms,
          ...(cfg.log.fullText ? { fullQuestion: question, fullAnswer: answer.text } : {}),
        });
        return reply(`${answer.text}\n\n${formatFooter(answer)}`, !answer.ok);
      } catch (err) {
        return reply(`The model bridge failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`, true);
      }
    },
  );

  server.registerTool(
    'bridge_status',
    {
      description:
        'Show which model bridge routes are configured, any cooldowns, and how many handoffs each route took today.',
      inputSchema: z.object({}),
    },
    async () => (cfg instanceof Error ? configFailure(cfg) : reply(formatStatus(cfg, routes))),
  );

  server.registerTool(
    'bridge_log',
    {
      description: 'List recent model bridge handoffs (time, route, outcome, question). Metadata only.',
      inputSchema: z.object({
        n: z.number().int().positive().max(200).default(10).describe('How many entries.'),
        project: z.string().optional().describe('Only entries for this project folder.'),
      }),
    },
    async ({ n, project }) =>
      cfg instanceof Error
        ? configFailure(cfg)
        : reply(formatLog(readLog(cfg, n, project === undefined ? undefined : path.resolve(project)))),
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

/** True when this file is the process entry point (source or bundle), not when a test imports it. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const canon = (p: string) => {
      const real = path.normalize(fs.realpathSync(p));
      // Windows paths are case-insensitive but realpath does not canonicalize case.
      return process.platform === 'win32' ? real.toLowerCase() : real;
    };
    return canon(entry) === canon(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((err) => {
    // stdout is the protocol channel; diagnostics go to stderr.
    process.stderr.write(`claude-model-bridge: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
