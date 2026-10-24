// Removes secret-looking values from text before it is sent to an outside model.
// The file itself is kept; only the values are replaced with REDACTED.

export const REDACTED = '[REDACTED]';

// Key shapes. The first three mirror scripts/check-secrets.mjs. Specific prefixes come before the generic `sk-`.
// Every pattern runs in linear time: a fixed prefix followed by one character class either matches (and
// consumes what it scanned) or fails within its minimum length. The JWT pattern has three parts, so it needs
// a left boundary to keep a long run of `eyJ` from being retried at every occurrence.
const TOKEN_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{35}/g, // Google API key
  /AQ\.[0-9A-Za-z_-]{30,}/g, // Google API key (newer format)
  /sk-or-[0-9A-Za-z-]{20,}/g, // OpenRouter
  /sk-ant-[0-9A-Za-z_-]{20,}/g, // Anthropic
  /sk-proj-[0-9A-Za-z_-]{20,}/g, // OpenAI project key
  /sk-[A-Za-z0-9]{20,}/g, // generic OpenAI-style key
  /github_pat_[0-9A-Za-z_]{20,}/g,
  /gh[pousr]_[0-9A-Za-z]{20,}/g, // GitHub tokens (ghp_, gho_, ...)
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[abposr]-[0-9A-Za-z-]{10,}/g, // Slack
  /(?<![0-9A-Za-z_-])eyJ[0-9A-Za-z_-]{10,}\.eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/g, // JWT
];

// A key name that suggests the assigned value is a secret.
const SECRET_NAME_RE =
  /(secret|passw(or)?d|pwd|(^|[_.$-])pass$|api[_-]?key|token|private[_-]?key|client[_-]?secret|access[_-]?key)/i;

// The key and separator of `name = value`, `"name": value`, `$name => value`, `name := value` or
// `--name=value`, followed by the start of a value. Group 1: quote, 2: key name.
// Linear time: the key must not follow a key character and is at most 130 characters, so a long run of
// letters or hex digits is tried once, not once per character. Only the key and separator are matched, so
// the value of a key that is not secret (`env: PASSWORD=x`) is still scanned for assignments of its own.
const ASSIGNMENT_KEY_RE =
  /(?<![\w$.-])(["']?)(-{0,2}[A-Za-z_$][\w$.-]{0,127})\1[ \t]*(?:=>|:=|=|:)[ \t]*(?=["'`]|[^\s,;#'"`=>])/g;
// The value after a secret key: a quoted string (to its closing quote or the end of the line), or a bare value.
const ASSIGNMENT_VALUE_RE = /"[^"\r\n]*"?|'[^'\r\n]*'?|`[^`\r\n]*`?|[^\s,;#'"`=>][^\s,;#'"`]*/y;
// Assignment redaction is skipped on longer lines (minified code, data blobs); key shapes are still redacted.
const MAX_ASSIGNMENT_LINE = 4096;

// Bare values that are code, types or placeholders rather than literal secrets.
const BARE_KEEP = new Set([
  'true', 'false', 'null', 'none', 'nil', 'undefined', 'string', 'str', 'number', 'int', 'integer', 'bool',
  'boolean', 'any', 'unknown', 'bytes', 'object', 'optional',
]);
const DOTTED_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/;
const SHORT_NUMBER_RE = /^\d{1,7}(\.\d+)?$/;
// A variable reference such as `$input`. A single bare word (`postgres`, `letmein`) may be the secret
// itself, so only `$name` and dotted references are kept.
const VARIABLE_REF_RE = /^\$[A-Za-z_]\w*$/;

function keepBareValue(value: string): boolean {
  if (BARE_KEEP.has(value.toLowerCase())) return true;
  if (VARIABLE_REF_RE.test(value)) return true; // $pw = $input
  if (/[()[\]{}<>]/.test(value)) return true; // calls, generics, templates such as ${VAR}
  if (DOTTED_IDENTIFIER_RE.test(value)) return true; // cfg.apiKey, process.env.TOKEN, self.token
  if (SHORT_NUMBER_RE.test(value)) return true; // maxTokens: 4096
  return false;
}

/** The replacement for a value assigned to a secret-named key, or null to keep it. */
function redactedValue(value: string): string | null {
  const quote = value[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    const closed = value.length > 1 && value.endsWith(quote);
    const inner = closed ? value.slice(1, -1) : value.slice(1);
    if (!inner || inner === REDACTED) return null;
    return closed ? `${quote}${REDACTED}${quote}` : `${quote}${REDACTED}`;
  }
  if (value === REDACTED || keepBareValue(value)) return null;
  return REDACTED;
}

function redactAssignments(line: string): { text: string; count: number } {
  let count = 0;
  let out = '';
  let copied = 0;
  ASSIGNMENT_KEY_RE.lastIndex = 0;
  for (let m = ASSIGNMENT_KEY_RE.exec(line); m; m = ASSIGNMENT_KEY_RE.exec(line)) {
    if (!SECRET_NAME_RE.test(m[2])) continue; // scanning resumes right after the separator
    const valueAt = m.index + m[0].length;
    ASSIGNMENT_VALUE_RE.lastIndex = valueAt;
    const value = ASSIGNMENT_VALUE_RE.exec(line)?.[0];
    if (!value) continue;
    const valueEnd = valueAt + value.length;
    ASSIGNMENT_KEY_RE.lastIndex = valueEnd; // a secret key's value is read once, which keeps this linear
    const replacement = redactedValue(value);
    if (replacement === null) continue;
    out += line.slice(copied, valueAt) + replacement;
    copied = valueEnd;
    count++;
  }
  return { text: copied === 0 ? line : out + line.slice(copied), count };
}

/** Replaces key-shaped tokens and values assigned to secret-named keys. Returns the new text and the count replaced. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return REDACTED;
    });
  }
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_ASSIGNMENT_LINE || !/[:=]/.test(line)) continue;
    const r = redactAssignments(line);
    lines[i] = r.text;
    count += r.count;
  }
  return { text: lines.join('\n'), count };
}

// Shorter values are not real keys, and stripping them would mangle the prompt.
const MIN_STRIP_LENGTH = 8;

/** Removes every occurrence of the given key values (e.g. the configured API keys) from text. */
export function stripKeys(text: string, keys: Array<string | undefined>): string {
  let out = text;
  for (const key of keys) {
    if (!key || key.length < MIN_STRIP_LENGTH) continue;
    out = out.split(key).join(REDACTED);
  }
  return out;
}
