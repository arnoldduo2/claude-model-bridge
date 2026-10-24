// Builds the Claude Desktop artifacts:
//   desktop/dist/model-bridge.mcpb       (extension: manifest + bundled server)
//   desktop/dist/model-bridge-skill.zip  (skill folder, uploaded in Desktop settings)
// Run `npm run build` first if plugin/server/bridge.mjs is out of date.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'desktop', 'dist');
const stage = path.join(dist, 'stage');
const bundle = path.join(root, 'plugin', 'server', 'bridge.mjs');
const skillDir = path.join(root, 'plugin', 'skills', 'model-bridge');

for (const p of [bundle, path.join(skillDir, 'SKILL.md')]) {
  if (!fs.existsSync(p)) throw new Error(`Missing ${path.relative(root, p)}. Run "npm run build" first.`);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'server'), { recursive: true });

// Keep one version number: the plugin manifest is the source of truth.
const pluginVersion = JSON.parse(
  fs.readFileSync(path.join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'),
).version;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'manifest.json'), 'utf8'));
manifest.version = pluginVersion;
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.copyFileSync(bundle, path.join(stage, 'server', 'bridge.mjs'));

// Pinned CLI from devDependencies (no global install, no network).
const mcpbCli = path.join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
if (!fs.existsSync(mcpbCli)) throw new Error('@anthropic-ai/mcpb is not installed. Run "npm install".');
const mcpbOut = path.join(dist, 'model-bridge.mcpb');
execFileSync(process.execPath, [mcpbCli, 'pack', stage, mcpbOut], { stdio: 'inherit' });

// Skill zip: a store-only (uncompressed) writer, Node built-ins only.
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const dosTime = 0;
  const dosDate = (1 << 5) | 1; // 1980-01-01, keeps the output reproducible
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function listFiles(dir, prefix) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) =>
    e.isDirectory()
      ? listFiles(path.join(dir, e.name), `${prefix}/${e.name}`)
      : [{ name: `${prefix}/${e.name}`, data: fs.readFileSync(path.join(dir, e.name)) }],
  );
}

const skillOut = path.join(dist, 'model-bridge-skill.zip');
fs.writeFileSync(skillOut, zipStore(listFiles(skillDir, 'model-bridge')));

fs.rmSync(stage, { recursive: true, force: true });
console.log(`\nBuilt:\n  ${path.relative(root, mcpbOut)}\n  ${path.relative(root, skillOut)}`);
