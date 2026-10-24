import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('committed bundle', () => {
  it('plugin/server/bridge.mjs matches a fresh build of server/src (run `npm run build`)', async () => {
    // A variable specifier keeps tsc from needing types for the .mjs script.
    const script = pathToFileURL(path.join(root, 'scripts', 'build.mjs')).href;
    const { buildOptions } = await import(script);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cmb-bundle-'));
    dirs.push(out);
    const outfile = path.join(out, 'bridge.mjs');
    await build({ ...buildOptions, outfile, logLevel: 'silent' });
    const fresh = fs.readFileSync(outfile);
    const committed = fs.readFileSync(path.join(root, 'plugin', 'server', 'bridge.mjs'));
    expect(committed.equals(fresh)).toBe(true);
  }, 60_000);
});
