import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './redact.js';

export interface GatherOptions {
  cwd: string;
  question: string;
  /** Files, folders or simple globs (`*`, `**`, `?`) relative to cwd. Sent first, before any ranked file. */
  paths?: string[];
  budgetChars: number;
  maxFileBytes?: number; // default 200_000
  maxFilesScanned?: number; // default 20_000
}

export interface GatheredContext {
  text: string;
  files: string[];
  truncated: boolean;
  skippedSecrets: number;
  /** Secret-looking values replaced with [REDACTED] in the emitted file contents. */
  redactions: number;
}

const DEFAULT_MAX_FILE_BYTES = 200_000;
const DEFAULT_MAX_FILES_SCANNED = 20_000;
const SCORE_READ_BYTES = 64 * 1024;
const SCORE_CONCURRENCY = 64;
// Content scoring stops once this much time has passed since gatherContext started (keeps the whole gather < 5 s).
const SCORE_DEADLINE_MS = 2000;
// Line numbers for the tail of a large named file are counted only when the skipped middle is at most this big.
const MAX_LINE_COUNT_BYTES = 64 * 1024 * 1024;
const PRIVATE_KEY_RE = /-----BEGIN[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const SOURCE_EXTENSIONS = new Set([
  '.php', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.cs',
  '.c', '.h', '.cpp', '.hpp', '.swift', '.sql', '.vue', '.svelte', '.sh', '.ps1', '.lua', '.pl', '.scala',
]);
const DOC_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml', '.toml', '.ini', '.html', '.css', '.xml', '.txt']);
const MIN_PARTIAL_FILE_CHARS = 200;

const HEAVY_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
  'coverage',
]);

// Directories whose whole contents are credentials (at any depth). The walk never enters them.
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.claude-model-bridge', '.kube', '.azure', '.terraform.d']);
// Credential stores that live under a shared parent such as ~/.config.
const SECRET_SUBDIRS: Array<[string, string]> = [
  ['.config', 'gh'],
  ['.config', 'gcloud'],
];

const SECRET_BASENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.pgpass',
  '.git-credentials',
  'credentials',
  'credentials.json',
  'credentials.yaml',
  'credentials.yml',
  'creds.json',
  'service-account.json',
  'service_account.json',
  '.htpasswd',
  '.dockercfg',
  'wp-config.php',
  '.credentials.json',
  'application_default_credentials.json',
  'auth.json',
  '.vault-token',
  '.s3cfg',
  '.boto',
  '.my.cnf',
]);

const SECRET_EXTENSIONS = [
  '.pem', '.key', '.pfx', '.p12', '.jks', '.keystore', '.ppk', '.p8', '.kdbx', '.gpg', '.asc', '.secret',
  '.crt', '.cer', '.der', '.tfvars', '.tfvars.json', '.tfstate', '.tfstate.backup',
];

function pathSegments(relPath: string): string[] {
  return relPath.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
}

function hasSecretDir(dirSegments: string[]): boolean {
  if (dirSegments.some((s) => SECRET_DIRS.has(s))) return true;
  return SECRET_SUBDIRS.some(([parent, child]) => dirSegments.some((s, i) => s === parent && dirSegments[i + 1] === child));
}

/** True when a cwd-relative directory is, or is inside, a credential store. Case-insensitive; / or \ separators. */
export function isSecretDir(relDir: string): boolean {
  return hasSecretDir(pathSegments(relDir));
}

// Case-insensitive; accepts / or \ separators. Matches on the basename and on secret directories.
export function isSecretPath(relPath: string): boolean {
  const segments = pathSegments(relPath);
  if (segments.length === 0) return false;
  if (hasSecretDir(segments.slice(0, -1))) return true;
  const base = segments[segments.length - 1];
  const parent = segments.length > 1 ? segments[segments.length - 2] : '';
  if (parent === '.docker' && base === 'config.json') return true;
  if (parent === '.cargo' && base.startsWith('credentials')) return true;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (SECRET_BASENAMES.has(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(base)) return true;
  if (SECRET_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
  if (/^secrets?\./.test(base)) return true; // secrets.yaml, secrets.production.json
  if (/(^|[._-])creds?\.(json|ya?ml)$/.test(base)) return true; // oauth_creds.json
  return false;
}

interface IgnoreRule {
  re: RegExp;
  dirOnly: boolean;
}

function globToRegexSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

// Minimal .gitignore: directory names, `*`/`**`/`?` globs, leading `/` anchoring, trailing `/` dir-only.
// Negation (`!`) is not supported and such lines are ignored.
function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    if (!line) continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const src = globToRegexSource(line);
    rules.push({ re: new RegExp(anchored ? `^${src}$` : `^(?:.*/)?${src}$`), dirOnly });
  }
  return rules;
}

function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  return rules.some((r) => (!r.dirOnly || isDir) && r.re.test(rel));
}

interface Candidate {
  rel: string;
  abs: string;
  size: number;
  score: number;
  /** Index of the `paths` entry that selected this file; undefined for ranked files. */
  focus?: number;
  /** A named file larger than maxFileBytes: only its head and tail are sent. */
  oversize?: boolean;
}

interface WalkResult {
  candidates: Candidate[];
  skippedSecrets: number;
  scanLimited: boolean;
}

interface WalkOptions {
  /** cwd-relative directory to start from ('' = cwd). */
  startRel: string;
  rules: IgnoreRule[];
  maxFileBytes: number;
  maxFilesScanned: number;
  /** Keep only files whose cwd-relative path matches. */
  match?: RegExp;
}

async function walk(cwd: string, o: WalkOptions): Promise<WalkResult> {
  const candidates: Candidate[] = [];
  let skippedSecrets = 0;
  let scanned = 0;
  let scanLimited = false;
  const stack: string[] = [o.startRel];

  while (stack.length > 0 && !scanLimited) {
    const relDir = stack.pop() as string;
    const absDir = relDir ? path.join(cwd, ...relDir.split('/')) : cwd;
    const entries: fs.Dirent[] = [];
    try {
      const dir = await fs.promises.opendir(absDir);
      for await (const entry of dir) entries.push(entry);
    } catch {
      continue; // unreadable directory: skip it
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const subdirs: string[] = [];
    const fileEntries: Array<{ rel: string; abs: string }> = [];
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (HEAVY_DIRS.has(entry.name) || isIgnored(o.rules, rel, true)) continue;
        if (isSecretDir(rel)) {
          skippedSecrets++; // credential store: never entered
          continue;
        }
        subdirs.push(rel);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks and special files are never followed
      if (scanned >= o.maxFilesScanned) {
        scanLimited = true;
        break;
      }
      scanned++;
      if (isIgnored(o.rules, rel, false)) continue;
      if (o.match && !o.match.test(rel)) continue;
      if (isSecretPath(rel)) {
        skippedSecrets++;
        continue;
      }
      fileEntries.push({ rel, abs: path.join(absDir, entry.name) });
    }
    const sizes = await Promise.all(
      fileEntries.map((f) =>
        fs.promises.stat(f.abs).then(
          (st) => st.size,
          () => -1,
        ),
      ),
    );
    fileEntries.forEach((f, i) => {
      if (sizes[i] >= 0 && sizes[i] <= o.maxFileBytes) candidates.push({ ...f, size: sizes[i], score: 0 });
    });
    // Reverse so the alphabetically first directory is popped first.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
  return { candidates, skippedSecrets, scanLimited };
}

function questionTerms(question: string): string[] {
  const terms = question.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length >= 3);
  return [...new Set(terms)];
}

// Resolves `paths` entries to cwd-relative forward-slash paths or globs; anything outside cwd is dropped.
function normalizeFocusPaths(cwd: string, paths: string[] | undefined): string[] {
  const out: string[] = [];
  for (const p of paths ?? []) {
    let rel = p.trim();
    if (!rel) continue;
    if (path.isAbsolute(rel)) rel = path.relative(cwd, rel);
    rel = path.posix.normalize(rel.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) continue;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

const GLOB_CHARS = /[*?]/;

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// A colon is never part of a project-relative path: on Windows `.env::$DATA` or `.env:$DATA` opens `.env`
// itself. Windows also drops a trailing dot or space from a name, so `.env.` can open `.env`.
const UNSAFE_FOCUS_SEGMENT = /[. ]$/;

function unsafeFocusEntry(entry: string): boolean {
  return entry.includes(':') || entry.split('/').some((s) => UNSAFE_FOCUS_SEGMENT.test(s));
}

interface RealTarget {
  st: fs.Stats;
  /** The real on-disk path. */
  real: string;
  /** The real path relative to cwd with forward slashes ('' = cwd). The secret rules are checked on this. */
  rel: string;
}

/**
 * Resolves abs when it exists, is not a symlink, and its real path stays inside cwd. The native realpath
 * returns the on-disk name, so Windows case variants, short (8.3) names, stream suffixes and links through
 * other folders all come back as the name the secret rules know.
 */
async function realInside(cwdReal: string, abs: string): Promise<RealTarget | null> {
  try {
    const st = await fs.promises.lstat(abs);
    if (st.isSymbolicLink()) return null;
    const real = await fs.promises.realpath(abs);
    if (!isInside(cwdReal, real)) return null;
    return { st, real, rel: path.relative(cwdReal, real).split(path.sep).join('/') };
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Each `paths` entry, in order: a file (sent even when larger than maxFileBytes, as a head and tail slice),
// a directory (walked), or a glob (walked from its fixed prefix). Secret rules always apply; the general scan
// cap does not (each directory or glob gets its own maxFilesScanned).
async function resolveFocus(
  cwd: string,
  entries: string[],
  rules: IgnoreRule[],
  maxFileBytes: number,
  maxFilesScanned: number,
): Promise<WalkResult> {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  let skippedSecrets = 0;
  let scanLimited = false;
  let cwdReal: string;
  try {
    cwdReal = await fs.promises.realpath(cwd);
  } catch {
    return { candidates: [], skippedSecrets: 0, scanLimited: false };
  }
  const add = (c: Candidate, focus: number) => {
    if (seen.has(c.rel)) return;
    seen.add(c.rel);
    out.push({ ...c, focus });
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (unsafeFocusEntry(entry)) {
      skippedSecrets++; // never opened: the name could reach a secret file under a name the rules miss
      continue;
    }
    const segments = entry.split('/');
    const globAt = segments.findIndex((s) => GLOB_CHARS.test(s));
    const dirRel = globAt >= 0 ? segments.slice(0, globAt).join('/') : entry;
    if (dirRel && isSecretDir(dirRel)) {
      skippedSecrets++;
      continue;
    }
    const abs = dirRel ? path.join(cwd, ...dirRel.split('/')) : cwd;
    const target = await realInside(cwdReal, abs);
    if (!target) continue;
    // From here on the real on-disk name is what counts, never the caller's string.
    const { st, rel: realRel } = target;
    if (realRel && isSecretDir(realRel)) {
      skippedSecrets++;
      continue;
    }

    if (globAt < 0 && st.isFile()) {
      if (isSecretPath(entry) || isSecretPath(realRel)) {
        skippedSecrets++;
        continue;
      }
      add({ rel: realRel, abs: target.real, size: st.size, score: 0, oversize: st.size > maxFileBytes }, i);
      continue;
    }
    if (!st.isDirectory()) continue;
    // The walk starts from the real directory, so every child and ancestor check sees real names too.
    const globRest = globAt >= 0 ? globToRegexSource(segments.slice(globAt).join('/')) : '';
    const walked = await walk(cwd, {
      startRel: realRel,
      rules,
      maxFileBytes,
      maxFilesScanned,
      match: globAt >= 0 ? new RegExp(`^${realRel ? `${escapeRegex(realRel)}/` : ''}${globRest}$`) : undefined,
    });
    skippedSecrets += walked.skippedSecrets;
    if (walked.scanLimited) scanLimited = true;
    for (const c of walked.candidates) add(c, i);
  }
  return { candidates: out, skippedSecrets, scanLimited };
}

async function readRange(abs: string, start: number, length: number): Promise<Buffer | null> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(abs, 'r');
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

function readHead(abs: string, maxBytes: number): Promise<Buffer | null> {
  return readRange(abs, 0, maxBytes);
}

function extRank(rel: string): number {
  const ext = path.posix.extname(rel).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext) ? 0 : DOC_EXTENSIONS.has(ext) ? 1 : 2;
}

function depthOf(rel: string): number {
  return rel.split('/').length;
}

function byRel(a: Candidate, b: Candidate): number {
  return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
}

// Path-scores every candidate, then content-scores (binary and private-key checks included) in an order of
// cheap plausibility (path score, source-code extension, shallow, small) until SCORE_DEADLINE_MS has passed.
// Unscored candidates are re-checked when emitted.
async function scoreCandidates(
  candidates: Candidate[],
  terms: string[],
  startedAt: number,
): Promise<{ readable: Candidate[]; secrets: number }> {
  for (const c of candidates) {
    const lower = c.rel.toLowerCase();
    for (const t of terms) if (lower.includes(t)) c.score += 2;
  }
  const order = [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      extRank(a.rel) - extRank(b.rel) ||
      depthOf(a.rel) - depthOf(b.rel) ||
      a.size - b.size ||
      byRel(a, b),
  );
  const dropped = new Set<Candidate>();
  let secrets = 0;
  for (let i = 0; i < order.length && Date.now() - startedAt < SCORE_DEADLINE_MS; i += SCORE_CONCURRENCY) {
    const batch = order.slice(i, i + SCORE_CONCURRENCY);
    const heads = await Promise.all(batch.map((c) => readHead(c.abs, Math.min(c.size, SCORE_READ_BYTES))));
    batch.forEach((c, j) => {
      const head = heads[j];
      if (!head || head.includes(0)) {
        dropped.add(c); // unreadable or binary
        return;
      }
      const text = head.toString('utf8');
      if (PRIVATE_KEY_RE.test(text)) {
        dropped.add(c);
        secrets++;
        return;
      }
      if (terms.length > 0) {
        const lower = text.toLowerCase();
        for (const t of terms) if (lower.includes(t)) c.score += 1;
      }
    });
  }
  return { readable: candidates.filter((c) => !dropped.has(c)), secrets };
}

function renderTree(rels: string[], maxChars: number): { text: string; truncated: boolean } {
  const sorted = [...rels].sort();
  const lines: string[] = [];
  const emittedDirs = new Set<string>();
  let used = 0;
  for (let i = 0; i < sorted.length; i++) {
    const parts = sorted[i].split('/');
    const add: string[] = [];
    for (let d = 1; d < parts.length; d++) {
      const dirPath = parts.slice(0, d).join('/');
      if (!emittedDirs.has(dirPath)) {
        emittedDirs.add(dirPath);
        add.push(`${'  '.repeat(d - 1)}${parts[d - 1]}/`);
      }
    }
    add.push(`${'  '.repeat(parts.length - 1)}${parts[parts.length - 1]}`);
    const cost = add.reduce((n, l) => n + l.length + 1, 0);
    if (used + cost > maxChars) {
      lines.push(`... (${sorted.length - i} more files not listed)`);
      return { text: lines.join('\n'), truncated: true };
    }
    lines.push(...add);
    used += cost;
  }
  return { text: lines.join('\n'), truncated: false };
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function numberLines(content: string): string {
  return splitLines(content)
    .map((l, i) => `${i + 1}| ${l}`)
    .join('\n');
}

async function countNewlines(abs: string, start: number, end: number): Promise<number | null> {
  if (end <= start) return 0;
  if (end - start > MAX_LINE_COUNT_BYTES) return null;
  let n = 0;
  try {
    for await (const chunk of fs.createReadStream(abs, { start, end: end - 1 })) {
      const buf = chunk as Buffer;
      let i = -1;
      while ((i = buf.indexOf(10, i + 1)) !== -1) n++;
    }
  } catch {
    return null;
  }
  return n;
}

type SliceResult =
  | { kind: 'ok'; body: string; redactions: number }
  | { kind: 'skip'; secret: boolean };

/**
 * Head and tail of a large named file, cut at line boundaries and fitted into `room` characters, with a
 * `[… N bytes omitted …]` marker between them. Tail lines keep their real line numbers when they can be counted.
 */
async function headTailSlice(c: Candidate, room: number, maxFileBytes: number): Promise<SliceResult> {
  const sliceBytes = Math.max(1, Math.floor(Math.min(maxFileBytes, room) / 2));
  let head = await readRange(c.abs, 0, sliceBytes);
  let tail = await readRange(c.abs, Math.max(0, c.size - sliceBytes), sliceBytes);
  if (!head || !tail) return { kind: 'skip', secret: false };
  if (head.includes(0) || tail.includes(0)) return { kind: 'skip', secret: false };
  const lastNl = head.lastIndexOf(10);
  if (lastNl >= 0) head = head.subarray(0, lastNl + 1);
  const firstNl = tail.indexOf(10);
  if (firstNl >= 0 && firstNl < tail.length - 1) tail = tail.subarray(firstNl + 1);
  const headText = head.toString('utf8');
  const tailText = tail.toString('utf8');
  if (PRIVATE_KEY_RE.test(headText) || PRIVATE_KEY_RE.test(tailText)) return { kind: 'skip', secret: true };

  const tailStart = c.size - tail.length;
  let headNewlines = 0;
  for (let i = head.indexOf(10); i !== -1; i = head.indexOf(10, i + 1)) headNewlines++;
  const middle = await countNewlines(c.abs, head.length, tailStart);
  const firstTailLine = middle === null ? null : headNewlines + middle + 1;

  const h = redactSecrets(headText);
  const t = redactSecrets(tailText);
  const headLines = splitLines(h.text);
  const tailLines = splitLines(t.text);

  // Keep head lines up to half the room, then as many tail lines (from the end) as still fit.
  const keptHead: string[] = [];
  let used = 0;
  let headBytes = 0;
  for (let i = 0; i < headLines.length; i++) {
    const line = `${i + 1}| ${headLines[i]}`;
    if (used + line.length + 1 > room / 2) break;
    keptHead.push(line);
    used += line.length + 1;
    headBytes += Buffer.byteLength(headLines[i], 'utf8') + 1;
  }
  const keptTail: string[] = [];
  let tailBytes = 0;
  const markerReserve = 64;
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const num = firstTailLine === null ? '?' : String(firstTailLine + i);
    const line = `${num}| ${tailLines[i]}`;
    if (used + line.length + 1 + markerReserve > room) break;
    keptTail.unshift(line);
    used += line.length + 1;
    tailBytes += Buffer.byteLength(tailLines[i], 'utf8') + 1;
  }
  const omitted = Math.max(0, c.size - headBytes - tailBytes);
  const parts = [...keptHead, `[… ${omitted} bytes omitted …]`, ...keptTail];
  return { kind: 'ok', body: parts.join('\n'), redactions: h.count + t.count };
}

export async function gatherContext(o: GatherOptions): Promise<GatheredContext> {
  const startedAt = Date.now();
  const maxFileBytes = o.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFilesScanned = o.maxFilesScanned ?? DEFAULT_MAX_FILES_SCANNED;
  const budget = Math.max(0, Math.floor(o.budgetChars));

  let rules: IgnoreRule[] = [];
  try {
    rules = parseGitignore(await fs.promises.readFile(path.join(o.cwd, '.gitignore'), 'utf8'));
  } catch {
    // no .gitignore
  }

  const terms = questionTerms(o.question);
  const focus = await resolveFocus(o.cwd, normalizeFocusPaths(o.cwd, o.paths), rules, maxFileBytes, maxFilesScanned);
  const walked = await walk(o.cwd, { startRel: '', rules, maxFileBytes, maxFilesScanned });
  const focusRels = new Set(focus.candidates.map((c) => c.rel));
  // Focus files are scored first so their binary and private-key checks run before the deadline.
  const scoredFocus = await scoreCandidates(focus.candidates, terms, startedAt);
  const scoredRest = await scoreCandidates(
    walked.candidates.filter((c) => !focusRels.has(c.rel)),
    terms,
    startedAt,
  );
  let skippedSecrets = focus.skippedSecrets + walked.skippedSecrets + scoredFocus.secrets + scoredRest.secrets;
  // Files under a secret directory named in `paths` are also counted by the general walk; that double count
  // only affects the statistic, never what is sent.

  const ordered = [
    ...[...scoredFocus.readable].sort((a, b) => (a.focus as number) - (b.focus as number) || b.score - a.score || byRel(a, b)),
    ...[...scoredRest.readable].sort((a, b) => b.score - a.score || byRel(a, b)),
  ];

  let truncated = walked.scanLimited || focus.scanLimited;
  let redactions = 0;
  const tree = renderTree(
    ordered.map((c) => c.rel),
    Math.floor(budget / 4),
  );
  if (tree.truncated) truncated = true;

  let text = `Project files:\n${tree.text}\n\nFile contents:\n`;
  if (text.length > budget) {
    return { text: text.slice(0, budget), files: [], truncated: true, skippedSecrets, redactions };
  }

  const files: string[] = [];
  for (const c of ordered) {
    const remaining = budget - text.length;
    if (remaining < MIN_PARTIAL_FILE_CHARS) {
      truncated = true;
      break;
    }

    if (c.oversize) {
      const header = `\n=== ${c.rel} (${c.size} bytes; head and tail only) ===\n`;
      const room = remaining - header.length - 1;
      if (room < MIN_PARTIAL_FILE_CHARS / 2) {
        truncated = true;
        continue;
      }
      const slice = await headTailSlice(c, room, maxFileBytes);
      if (slice.kind === 'skip') {
        if (slice.secret) skippedSecrets++;
        continue;
      }
      text += `${header}${slice.body}\n`;
      redactions += slice.redactions;
      files.push(c.rel);
      truncated = true;
      continue;
    }

    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(c.abs);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binary past the scoring window
    const raw = buf.toString('utf8');
    if (PRIVATE_KEY_RE.test(raw)) {
      skippedSecrets++; // private key in a file the scoring pass did not reach
      continue;
    }
    const redacted = redactSecrets(raw);
    const header = `\n=== ${c.rel} ===\n`;
    const body = numberLines(redacted.text);
    if (header.length + body.length + 1 <= remaining) {
      text += `${header}${body}\n`;
      files.push(c.rel);
      redactions += redacted.count;
      continue;
    }
    truncated = true;
    const marker = '\n... [truncated]\n';
    const room = remaining - header.length - marker.length;
    if (room >= MIN_PARTIAL_FILE_CHARS / 2) {
      text += `${header}${body.slice(0, room)}${marker}`;
      files.push(c.rel);
      redactions += redacted.count;
    }
  }

  return { text, files, truncated, skippedSecrets, redactions };
}
