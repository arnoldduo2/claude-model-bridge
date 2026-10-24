// Bundles the MCP server into ONE file that runs with plain `node` and no node_modules.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The esbuild options for plugin/server/bridge.mjs. The bundle freshness test reuses them. */
export const buildOptions = {
  absWorkingDir: root,
  entryPoints: ['server/src/index.ts'],
  outfile: 'plugin/server/bridge.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  sourcemap: false,
  // Some bundled dependencies are CommonJS and call require().
  banner: { js: "import { createRequire as __cmbCreateRequire } from 'node:module';\nconst require = __cmbCreateRequire(import.meta.url);" },
  logLevel: 'info',
};

// Build only when run as a script, not when a test imports the options.
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const canon = (p) => {
      const real = path.normalize(fs.realpathSync(p));
      return process.platform === 'win32' ? real.toLowerCase() : real;
    };
    return canon(entry) === canon(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) await build(buildOptions);
