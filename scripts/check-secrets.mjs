#!/usr/bin/env node
// Blocks commits that contain API keys, private keys or personal home-folder paths.
// Default mode scans the staged content of `git diff --cached`; `--files` reads
// newline-separated paths from stdin and scans them from disk (used by tests).
// Output lists `path:line: pattern-name` only; matched values are never printed.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// A user name in a path; placeholders such as <you>, %USERNAME%, $USER, {name} or :id are allowed.
const USER = String.raw`[^\\/\s<>%$\{\}:"'\x60][^\\/\s"'\x60]*`;

const PATTERNS = [
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'google-api-key-new', re: /AQ\.[0-9A-Za-z_-]{30,}/ },
  { name: 'openrouter-api-key', re: /sk-or-[0-9a-zA-Z-]{20,}/ },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/ },
  // <drive>:<sep>Users<sep><name>: any drive letter, \ or / separators, JSON-escaped \\ too
  { name: 'windows-user-path', re: new RegExp(String.raw`[A-Za-z]:(?:\\{1,2}|/)Users(?:\\{1,2}|/)${USER}`, 'i') },
  // POSIX home folders under the home and Users roots; a slash right after a host or word (a URL path) does not count
  { name: 'posix-home-path', re: new RegExp(String.raw`(?<![\w.~:-])/home/${USER}/`, 'i') },
  { name: 'mac-user-path', re: new RegExp(String.raw`(?<![\w.~:-])/Users/${USER}/`, 'i') },
];

function scanText(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of PATTERNS) {
      if (re.test(lines[i])) hits.push({ line: i + 1, name });
    }
  }
  return hits;
}

function looksBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function listStaged() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

function readStaged(file) {
  return execFileSync('git', ['show', `:${file}`], { maxBuffer: 64 * 1024 * 1024 });
}

function readDisk(file) {
  return fs.readFileSync(file);
}

function main() {
  const fromStdin = process.argv.includes('--files');
  const files = fromStdin
    ? readStdin().split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : listStaged();
  const read = fromStdin ? readDisk : readStaged;

  const findings = [];
  for (const file of files) {
    let buf;
    try {
      buf = read(file);
    } catch {
      continue; // unreadable or missing path: nothing to scan
    }
    if (looksBinary(buf)) continue;
    for (const { line, name } of scanText(buf.toString('utf8'))) {
      findings.push(`${file}:${line}: ${name}`);
    }
  }

  if (findings.length > 0) {
    console.error('check-secrets: possible secrets or personal paths found:');
    for (const f of findings) console.error(`  ${f}`);
    console.error('Remove them (or unstage the file) and try again.');
    process.exit(1);
  }
}

main();
