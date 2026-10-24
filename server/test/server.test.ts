import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { loadConfig, type BridgeConfig, type RouteName } from '../src/config.js';
import { readLog } from '../src/log.js';
import { RouteError, type Route } from '../src/routes/types.js';
import { geminiRoute } from '../src/routes/gemini.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/index.js';

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function cfg(): BridgeConfig {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-server-'));
  dirs.push(d);
  return loadConfig({ homeDir: d, env: {} });
}

function projectDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-proj-'));
  dirs.push(d);
  return d;
}

function fake(name: RouteName, result: { text: string; model: string } | Error, hint: string | null = null): Route {
  return {
    name,
    configured: () => hint,
    ask: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** Minimal JSON-RPC client over the SDK's in-memory transport (the SDK client package is not installed). */
async function connect(c: BridgeConfig | Error, routes: Route[]) {
  const server = createServer(c, routes);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const pending = new Map<number, (m: JSONRPCMessage) => void>();
  clientT.onmessage = (m) => {
    const id = (m as { id?: number }).id;
    if (id !== undefined) pending.get(id)?.(m);
  };
  await clientT.start();
  let nextId = 1;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (m) => {
        const msg = m as { result?: unknown; error?: { message: string } };
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      void clientT.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    });
  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  await clientT.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  closers.push(async () => {
    await clientT.close();
    await server.close();
  });
  return {
    listTools: () => request('tools/list') as Promise<{ tools: Array<{ name: string; description?: string }> }>,
    call: (name: string, args: Record<string, unknown>) =>
      request('tools/call', { name, arguments: args }) as Promise<ToolResult>,
  };
}

describe('MCP server', () => {
  it('lists three tools', async () => {
    const client = await connect(cfg(), []);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['ask_model', 'bridge_log', 'bridge_status']);
    const ask = tools.find((t) => t.name === 'ask_model');
    expect(ask?.description).toMatch(/spot-check/i);
  });

  it('ask_model happy path', async () => {
    const client = await connect(cfg(), [fake('antigravity', { text: 'It is handled in src/a.ts:12', model: 'agy' })]);
    const res = await client.call('ask_model', { question: 'where is X handled?', cwd: projectDir() });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('It is handled in src/a.ts:12');
    expect(res.content[0].text).toContain('via antigravity');
  });

  it('ask_model all-fail', async () => {
    const client = await connect(cfg(), [fake('antigravity', new RouteError('timeout', 'slow'))]);
    const res = await client.call('ask_model', { question: 'q', cwd: projectDir() });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Do this task yourself');
  });

  it('ask_model logs one entry', async () => {
    const c = cfg();
    const client = await connect(c, [fake('antigravity', { text: 'answer', model: 'agy' })]);
    const proj = projectDir();
    await client.call('ask_model', { question: 'where is X?', task: 'explore', cwd: proj });
    const entries = readLog(c, 5);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      project: path.resolve(proj),
      task: 'explore',
      question: 'where is X?',
      ok: true,
      inChars: 'where is X?'.length,
      outChars: 'answer'.length,
    });
  });

  it('bridge_status shows not-configured hint for gemini without key', async () => {
    const c = cfg();
    const client = await connect(c, [geminiRoute]);
    const res = await client.call('bridge_status', {});
    const text = res.content[0].text;
    expect(text).toMatch(/gemini/);
    expect(text).toMatch(/GEMINI_API_KEY|api key/i);
    expect(text).toContain(path.join(c.homeDir, 'config.json'));
  });

  it('bridge_status shows cooldown and handoffs today', async () => {
    const c = cfg();
    const client = await connect(c, [fake('antigravity', { text: 'a', model: 'agy' })]);
    await client.call('ask_model', { question: 'q', cwd: projectDir() });
    fs.writeFileSync(path.join(c.homeDir, 'state.json'), JSON.stringify({ antigravity: Date.now() + 30_000 }));
    const text = (await client.call('bridge_status', {})).content[0].text;
    expect(text).toMatch(/antigravity[^\n]*cooldown \d+s/);
    expect(text).toMatch(/antigravity[^\n]*1 handoff/);
  });

  it('bridge_log lists recent entries', async () => {
    const c = cfg();
    const client = await connect(c, [fake('antigravity', { text: 'a', model: 'agy' })]);
    await client.call('ask_model', { question: 'find the thing', cwd: projectDir() });
    const text = (await client.call('bridge_log', { n: 5 })).content[0].text;
    expect(text).toContain('antigravity');
    expect(text).toContain('find the thing');
  });

  it('ask_model rejects a non-existent cwd without calling a route or logging', async () => {
    const c = cfg();
    let called = false;
    const route: Route = {
      name: 'antigravity',
      configured: () => null,
      ask: async () => {
        called = true;
        return { text: 'x', model: 'm' };
      },
    };
    const client = await connect(c, [route]);
    const missing = path.join(os.tmpdir(), 'cmb-does-not-exist-' + Date.now());
    const res = await client.call('ask_model', { question: 'q', cwd: missing });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('cwd does not exist or is not a folder');
    expect(res.content[0].text).toContain(missing);
    expect(res.content[0].text).toContain('Pass cwd explicitly.');
    expect(called).toBe(false);
    expect(readLog(c, 5)).toHaveLength(0);
  });

  it('ask_model rejects a cwd that is a file', async () => {
    const c = cfg();
    const client = await connect(c, [fake('antigravity', { text: 'a', model: 'm' })]);
    const file = path.join(projectDir(), 'f.txt');
    fs.writeFileSync(file, 'x');
    const res = await client.call('ask_model', { question: 'q', cwd: file });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not a folder');
  });

  describe('ask_model refuses folders that hold credential stores', () => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    async function refused(c: BridgeConfig, cwd: string) {
      let called = false;
      const route: Route = {
        name: 'gemini',
        configured: () => null,
        ask: async () => {
          called = true;
          return { text: 'x', model: 'm' };
        },
      };
      const client = await connect(c, [route]);
      const res = await client.call('ask_model', { question: 'q', cwd });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('Pass cwd as the absolute path of a specific project folder');
      expect(called).toBe(false);
      expect(readLog(c, 5)).toHaveLength(0);
      return res.content[0].text;
    }

    it('the home folder, or a folder containing it', async () => {
      const fakeHome = path.join(projectDir(), 'home');
      fs.mkdirSync(fakeHome);
      process.env.HOME = fakeHome;
      process.env.USERPROFILE = fakeHome;
      expect(os.homedir()).toBe(fakeHome);
      expect(await refused(cfg(), fakeHome)).toContain('home folder');
      expect(await refused(cfg(), path.dirname(fakeHome))).toContain('home folder');
      const upper = process.platform === 'win32' ? fakeHome.toUpperCase() : fakeHome;
      if (upper !== fakeHome) expect(await refused(cfg(), upper)).toContain('home folder');
    });

    it('a drive or filesystem root', async () => {
      expect(await refused(cfg(), path.parse(os.tmpdir()).root)).toContain('root');
    });

    it("the bridge's own config folder, inside it, or above it", async () => {
      const c = cfg();
      fs.mkdirSync(path.join(c.homeDir, 'logs'), { recursive: true });
      expect(await refused(c, c.homeDir)).toContain('config folder');
      expect(await refused(c, path.join(c.homeDir, 'logs'))).toContain('config folder');
      const nested = cfg();
      nested.homeDir = path.join(projectDir(), 'inner', '.claude-model-bridge');
      fs.mkdirSync(nested.homeDir, { recursive: true });
      expect(await refused(nested, path.dirname(path.dirname(nested.homeDir)))).toContain('config folder');
    });

    it('a normal project folder next to them is accepted', async () => {
      const client = await connect(cfg(), [fake('gemini', { text: 'fine', model: 'm' })]);
      const res = await client.call('ask_model', { question: 'q', cwd: projectDir() });
      expect(res.isError).toBeFalsy();
    });
  });

  it('a broken config.json makes every tool report it instead of killing the server', async () => {
    const home = projectDir();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ gemini: { timeoutMs: 'soon' } }));
    let err: unknown;
    try {
      loadConfig({ homeDir: home, env: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const client = await connect(err as Error, [fake('gemini', { text: 'a', model: 'm' })]);
    expect((await client.listTools()).tools).toHaveLength(3);
    for (const [tool, args] of [
      ['ask_model', { question: 'q', cwd: projectDir() }],
      ['bridge_status', {}],
      ['bridge_log', {}],
    ] as const) {
      const res = await client.call(tool, args);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('gemini.timeoutMs must be a positive number');
      expect(res.content[0].text).toContain(`Config file: ${path.join(home, 'config.json')}`);
    }
  });

  it('logs and lists the model that answered', async () => {
    const c = cfg();
    const client = await connect(c, [fake('gemini', { text: 'a', model: 'gemini-4-flash' })]);
    await client.call('ask_model', { question: 'which model?', cwd: projectDir() });
    expect(readLog(c, 1)[0].attempts.at(-1)).toMatchObject({ route: 'gemini', outcome: 'ok', model: 'gemini-4-flash' });
    const text = (await client.call('bridge_log', { n: 5 })).content[0].text;
    expect(text).toContain('gemini (gemini-4-flash) | ok | which model?');
  });

  it('ask_model rejects a relative cwd', async () => {
    const c = cfg();
    const client = await connect(c, [fake('antigravity', { text: 'a', model: 'm' })]);
    const res = await client.call('ask_model', { question: 'q', cwd: 'some/relative' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('absolute path');
    expect(readLog(c, 5)).toHaveLength(0);
  });
});

describe('bundle entry point', () => {
  const bundle = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../plugin/server/bridge.mjs');

  it('starts and answers initialize from a path with a space and different drive-letter case', async () => {
    expect(fs.existsSync(bundle)).toBe(true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb dir '));
    dirs.push(dir);
    fs.copyFileSync(bundle, path.join(dir, 'bridge.mjs'));
    let script = path.join(dir, 'bridge.mjs');
    if (process.platform === 'win32') {
      const first = script[0];
      script = (first === first.toLowerCase() ? first.toUpperCase() : first.toLowerCase()) + script.slice(1);
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-home-'));
    dirs.push(home);
    const child = spawn(process.execPath, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, USERPROFILE: home, HOME: home },
    });
    try {
      const first = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no initialize response within 10s')), 10_000);
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d;
          const nl = buf.indexOf('\n');
          if (nl >= 0) {
            clearTimeout(timer);
            resolve(buf.slice(0, nl));
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error('bundle exited early with code ' + code));
        });
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
          }) + '\n',
        );
      });
      expect(JSON.parse(first).result.serverInfo.name).toBe('claude-model-bridge');
    } finally {
      child.kill();
    }
  }, 20_000);

  it('starts with a broken config.json and bridge_status reports the problem', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-home-'));
    dirs.push(home);
    fs.mkdirSync(path.join(home, '.claude-model-bridge'));
    const configFile = path.join(home, '.claude-model-bridge', 'config.json');
    fs.writeFileSync(configFile, '{"gemini": null}');
    const child = spawn(process.execPath, [bundle], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, USERPROFILE: home, HOME: home },
    });
    try {
      const responses = new Map<number, any>();
      let buf = '';
      const waitFor = (id: number) =>
        new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`no response ${id} within 10s`)), 10_000);
          const check = () => {
            if (responses.has(id)) {
              clearTimeout(timer);
              resolve(responses.get(id));
            } else setTimeout(check, 20);
          };
          check();
        });
      child.stdout.on('data', (d) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          if (msg.id !== undefined) responses.set(msg.id, msg);
        }
      });
      const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      });
      await waitFor(1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bridge_status', arguments: {} } });
      const res = (await waitFor(2)).result;
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('gemini must be an object');
      expect(res.content[0].text).toContain(configFile);
    } finally {
      child.kill();
    }
  }, 20_000);
});
