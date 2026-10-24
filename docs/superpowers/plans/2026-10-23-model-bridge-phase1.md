# Claude Model Bridge — Phase 1 (Delegation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship mode A of the design. A local MCP server, packaged as a Claude Code plugin, a Desktop extension, and a GitHub-hosted marketplace, lets Claude hand questions to Antigravity CLI, the Gemini API, or OpenRouter free models, with automatic fallback and a handoff log.

**Architecture:**
- **Core:** one TypeScript MCP server (stdio), bundled by esbuild into a single committed `.mjs` file, so no per-PC `npm install` is needed.
- **Routes:** each route implements one `Route` interface. A router tries them in order, applies cooldowns on rate limits, and writes one JSONL log line per handoff.
- **Wrappers:** thin wrappers (plugin, `.mcpb`, marketplace) all point at the same bundle.

**Tech Stack:**
- Node ≥ 20 (dev machine has 24) and TypeScript 5
- `@modelcontextprotocol/server` (MCP TS SDK v2) and `zod/v4`
- esbuild for bundling and vitest for tests
- `@anthropic-ai/mcpb` CLI for the Desktop extension

**Spec:** `docs/superpowers/specs/2026-10-23-model-bridge-design.md`

**Mode B (spec §6.11):** out of scope. It gets its own design and plan after this ships.

## Global Constraints

- Repo root: `<repo-root>`. The repo is **public**, so no keys, no personal absolute paths, and no real project content in fixtures or docs.
- Default route order: `antigravity` → `gemini` → `openrouter`, configurable.
- Keys:
  - Read from env `GEMINI_API_KEY` and `OPENROUTER_API_KEY`, else from `~/.claude-model-bridge/config.json`.
  - Never read in chat, never logged.
- The user dir `~/.claude-model-bridge/` holds `config.json`, `state.json` (cooldowns), and `logs/YYYY-MM.jsonl`. Nothing is ever written inside the project being asked about.
- **Never** read or touch `~/.gemini/oauth_creds.json` or any Google credential file. Antigravity is reached only by running the official `agy` binary.
- **Never** pass `--dangerously-skip-permissions` to `agy`. Delegated models are read-only.
- Secret files are never sent to any route. The patterns are in Task 2.
- Logs store metadata only by default (`log.fullText: false`).
- Gemini and OpenRouter model names are never hard-coded as the only option. They come from config, else from discovery.
- Every route call has a hard timeout. A hang is a failure, and the router falls back.
- The plugin uses `${CLAUDE_PLUGIN_ROOT}` for every intra-plugin path.

## Review Focus

1. **Project paths with spaces and backslashes** (e.g. `D:\Work\Example Project`). Gathering and `agy` spawning must work unchanged. Tests in Task 2 and Task 4.
2. **Huge repos** (100k+ files, missing `.gitignore`, multi-GB SQL dumps). Gathering must finish in under 5 s, skip heavy directories and files over the size cap, and stay within budget. Test in Task 2.
3. **`agy` problems:** missing, not signed in, or blocked waiting on an interactive prompt. Each must end in a timeout or "unavailable" result and fall back, never hang the session. Test in Task 4.
4. **Missing keys:** the route is reported "not configured" with a setup hint, and it is skipped silently in the fallback chain rather than counted as an error. Test in Task 5.
5. **Every route fails:** the tool returns `isError: true` with one line per route saying why, so Claude can do the work itself. Test in Task 5.

---

### Task 0: Antigravity CLI spike (verification, no product code)

Resolves spec §7 items 1–3. The outcome decides how Task 4 invokes `agy`.

**Files:**
- Create: `docs/findings.md`

- [ ] **Step 1: Ask the owner to install `agy`.** The install script runs remote code, so the owner runs it. Command from the Antigravity docs (PowerShell): `irm https://antigravity.google/cli/install.ps1 | iex`. Then the owner runs `agy` once interactively and signs in with the AI Pro Google account.
- [ ] **Step 2: Record the version.** Run `agy --version` and record it.
- [ ] **Step 3: Test print mode from a TTY.** In a throwaway folder, run `agy -p "List the files in this folder" --output-format json` from a terminal. Record the JSON shape, meaning the field that holds the answer text.
- [ ] **Step 4: Test print mode without a TTY,** which is how the server will run it:
  `node -e "const c=require('child_process').spawn('agy',['-p','say hi','--output-format','json'],{stdio:['ignore','pipe','pipe'],shell:true});c.stdout.on('data',d=>process.stdout.write(d));setTimeout(()=>{console.log('TIMEOUT');c.kill()},60000)"`
  Record whether it returns or prints `TIMEOUT` (issue #318).
- [ ] **Step 5: If Step 4 hangs, try the workarounds in this order.** Stop at the first that works and record it:
  - (a) `stdio: ['pipe', ...]` with an immediate `stdin.end()`
  - (b) `--output-format stream-json`
  - (c) the `agy-headless-bridge` PTY approach
  - If only (c) works, Antigravity becomes an optional route that needs Python plus pywinpty on that PC. Record this.
- [ ] **Step 6: Find the read-only mechanism.** Check `agy --help` and the settings docs for an approval mode or sandbox that **denies** file writes and shell commands in print mode. Prove it: ask agy in print mode to "create a file named x.txt" and confirm no file appears. Record the exact flags.
- [ ] **Step 7: Record the quota/limit message.** Note the message agy prints when rate-limited or signed out, plus its exit codes. Task 4 classifies errors from these strings.
- [ ] **Step 8: Write and commit `docs/findings.md`.** It holds: version, the working spawn recipe, read-only flags, the answer JSON field, error strings with exit codes, and the decision "agy route: enabled | optional (needs PTY) | dropped".

```bash
git add docs/findings.md && git commit -m "docs: record Antigravity CLI headless findings"
```

---

### Task 1: Repo scaffold, config loader, secret pre-commit check

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `scripts/build.mjs`, `scripts/check-secrets.mjs`, `.githooks/pre-commit`, `config.example.json`
- Create: `server/src/config.ts`
- Test: `server/test/config.test.ts`

**Interfaces:**
- Produces:

```ts
export type RouteName = 'antigravity' | 'gemini' | 'openrouter';
export interface BridgeConfig {
  routeOrder: RouteName[];                 // default ['antigravity','gemini','openrouter']
  antigravity: { command: string; timeoutMs: number };          // 'agy', 180_000
  gemini: { apiKey?: string; model?: string; timeoutMs: number; budgetChars: number };     // 120_000, 400_000
  openrouter: { apiKey?: string; models: string[]; timeoutMs: number; budgetChars: number }; // [], 120_000, 100_000
  cooldownMs: number;                      // 60_000
  log: { fullText: boolean };              // false
  homeDir: string;                         // ~/.claude-model-bridge
}
export function loadConfig(opts?: { homeDir?: string; env?: NodeJS.ProcessEnv }): BridgeConfig;
```

- [ ] **Step 1: Initialise the repo.** `git init`. Write `package.json` (`"type":"module"`, scripts `test`, `build`, `check-secrets`, devDeps `typescript esbuild vitest @types/node`, deps `@modelcontextprotocol/server zod`), plus `tsconfig.json` and `vitest.config.ts`. Then `npm install`.
- [ ] **Step 2: Write the failing tests** in `server/test/config.test.ts`:
  - `defaults when no file`: `loadConfig({homeDir: tmp, env:{}})` gives `routeOrder` `['antigravity','gemini','openrouter']`, `antigravity.timeoutMs` `180000`, `log.fullText` `false`.
  - `env keys override file`: the file has `gemini.apiKey:'file'` and env has `GEMINI_API_KEY:'env'`, so the result is `gemini.apiKey === 'env'`.
  - `file merges deeply`: the file has `{gemini:{model:'m1'}}`, so `gemini.model==='m1'` and `gemini.timeoutMs===120000`.
  - `bad JSON throws with path`: a malformed `config.json` makes `loadConfig` throw an error message containing `config.json`.
- [ ] **Step 3: Run the tests.** `npx vitest run server/test/config.test.ts` should FAIL (module not found).
- [ ] **Step 4: Implement `loadConfig`** in `server/src/config.ts`. Use a deep merge of defaults ← file ← env keys. `homeDir` defaults to `path.join(os.homedir(), '.claude-model-bridge')`.
- [ ] **Step 5: Run the tests.** They should PASS.
- [ ] **Step 6: Write `scripts/check-secrets.mjs`.**
  - It scans `git diff --cached --name-only` files for these patterns:
    - Google keys: `AIza[0-9A-Za-z_-]{35}` and `AQ\.[0-9A-Za-z_-]{30,}`
    - OpenRouter keys: `sk-or-[0-9a-zA-Z-]{20,}`
    - `-----BEGIN [A-Z ]*PRIVATE KEY-----`
    - Home-folder paths: Windows `<drive>:\Users\<name>` (any drive letter, either slash style), `/home/<name>/` and `/Users/<name>/`
  - It exits 1 and lists hits.
  - `.githooks/pre-commit` runs it.
  - Run `git config core.hooksPath .githooks`.
- [ ] **Step 7: Verify the secret check.** Stage a temp file containing `AIza` followed by 35 `x` chars. `git commit` should be blocked. Then unstage and delete the file.
- [ ] **Step 8: Write the remaining files.**
  - `.gitignore`: `node_modules/`, `coverage/`, `*.local.json`, `.env*`.
  - `config.example.json`: all fields with `"apiKey": ""`.
- [ ] **Step 9: Commit.**

```bash
git add -A && git commit -m "chore: scaffold repo, config loader, secret pre-commit check"
```

---

### Task 2: Secret filter and context gatherer

**Files:**
- Create: `server/src/context.ts`
- Test: `server/test/context.test.ts`, fixtures created in a temp dir inside the tests (no committed fixture code from real projects)

**Interfaces:**
- Produces:

```ts
export function isSecretPath(relPath: string): boolean;
export interface GatherOptions { cwd: string; question: string; paths?: string[]; budgetChars: number; maxFileBytes?: number /* 200_000 */; maxFilesScanned?: number /* 20_000 */ }
export interface GatheredContext { text: string; files: string[]; truncated: boolean; skippedSecrets: number }
export async function gatherContext(o: GatherOptions): Promise<GatheredContext>;
```

- [ ] **Step 1: Write the failing tests:**
  - `isSecretPath` returns true for:
    - `.env`, `.env.local`, `config/.env.production`
    - `id_rsa`, `server.pem`, `cert.key`, `cert.pfx`
    - `credentials.json`, `oauth_creds.json`, `secrets.yaml`
    - `.npmrc`, `.git-credentials`
  - It returns false for `env.ts`, `src/keyboard.ts`, `README.md`.
  - `includes tree and line-numbered files`:
    - Setup: a temp project with `src/vat.php` containing `function vat() {}` on line 3, and the question "where is vat calculated".
    - Expect `text` to contain `src/vat.php` and `3| function vat() {}`.
  - `never includes .env`: the temp project has `.env` with `DB_PASS=x`. Expect `text` not to contain `DB_PASS` and `skippedSecrets >= 1`.
  - `skips heavy dirs`: files under `node_modules/`, `vendor/`, `.git/`, `dist/`, and `build/` never appear in `files`.
  - `respects .gitignore`: with `.gitignore` = `logs/`, files in `logs/` are absent.
  - `skips binary and oversized`: a file with a NUL byte and a 300 KB `dump.sql` are both absent from `files`.
  - `budget`: with `budgetChars: 2000` and ten 1 KB files, `text.length <= 2000` and `truncated === true`.
  - `paths focus`: `paths: ['src/vat.php']` gives `files` that start with `src/vat.php`.
  - `cwd with spaces`: the temp dir name contains a space (`'proj with space'`) and gathering works.
  - `huge tree is fast`: 25,000 tiny files take under 5000 ms, with `files.length > 0`.
- [ ] **Step 2: Run the tests.** `npx vitest run server/test/context.test.ts` should FAIL.
- [ ] **Step 3: Implement `context.ts`.**
  - Walk with `fs.promises.opendir`, stopping at `maxFilesScanned`.
  - Apply `.gitignore` with a minimal matcher: directory names, `*` globs, leading `/`. Full gitignore semantics aren't required.
  - Rank files:
    - Score +3 for a `paths` match.
    - Score +2 for each question term (length ≥ 3) in the path.
    - Score +1 for each term found in the first 64 KB of content.
  - Emit a tree section, then the files in rank order with `N| ` line prefixes, until the budget is reached.
- [ ] **Step 4: Run the tests.** They should PASS.
- [ ] **Step 5: Commit.**

```bash
git add server/src/context.ts server/test/context.test.ts && git commit -m "feat: context gatherer with secret and heavy-file exclusion"
```

---

### Task 3: Route interface and HTTP routes (Gemini, OpenRouter)

**Files:**
- Create: `server/src/routes/types.ts`, `server/src/routes/gemini.ts`, `server/src/routes/openrouter.ts`, `server/src/prompts.ts`
- Test: `server/test/routes-http.test.ts`

**Interfaces:**
- Consumes: `BridgeConfig` (Task 1), `gatherContext` (Task 2)
- Produces:

```ts
export type TaskKind = 'explore' | 'plan' | 'review' | 'ask';
export interface RouteRequest { question: string; task: TaskKind; cwd: string; paths?: string[]; model?: string }
export interface RouteResult { text: string; model: string }
export type FailureKind = 'not_configured' | 'rate_limit' | 'timeout' | 'auth' | 'unavailable' | 'empty' | 'other';
export class RouteError extends Error { constructor(public kind: FailureKind, message: string, public retryAfterMs?: number) }
export interface Route { name: RouteName; configured(cfg: BridgeConfig): string | null /* null = ok, else setup hint */; ask(req: RouteRequest, cfg: BridgeConfig, signal: AbortSignal): Promise<RouteResult> }
export function buildPrompt(req: RouteRequest, context?: string): string;   // prompts.ts
export const geminiRoute: Route; export const openrouterRoute: Route;
export async function resolveGeminiModel(cfg: BridgeConfig, fetchFn?: typeof fetch): Promise<string>;
```

- **Endpoints:**
  - Gemini: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, header `x-goog-api-key`, body `{contents:[{role:'user',parts:[{text}]}]}`. The answer is the joined `candidates[0].content.parts[].text`.
  - Model discovery: `GET .../v1beta/models`. Pick names containing `flash` whose `supportedGenerationMethods` includes `generateContent`, then take the highest version number.
- **OpenRouter:** `POST https://openrouter.ai/api/v1/chat/completions`, `Authorization: Bearer`, body `{model, messages:[{role:'user',content}]}`.
  - The answer is `choices[0].message.content`.
  - Try `cfg.openrouter.models` in order. If empty, discover via `GET https://openrouter.ai/api/v1/models` and filter IDs ending in `:free`.
- **Error mapping (both routes):**

| Condition | Kind |
|---|---|
| HTTP 429 | `rate_limit` (read `retry-after` seconds into `retryAfterMs`) |
| HTTP 401 or 403 | `auth` |
| HTTP 5xx or network error | `unavailable` |
| aborted | `timeout` |
| empty text | `empty` |

- [ ] **Step 1: Write the failing tests,** with `fetch` stubbed via `vi.stubGlobal`:
  - `gemini configured() returns hint without key`: the result contains `GEMINI_API_KEY`.
  - `gemini sends key header and parses parts`: the stub asserts header `x-goog-api-key === 'k'`, then returns two parts `'a'`, `'b'`. Expect `text === 'ab'`.
  - `gemini 429 → rate_limit with retryAfterMs 30000`: `retry-after: 30`.
  - `openrouter falls through models on 429`: models `['m1:free','m2:free']`. m1 returns 429 and m2 returns 200. Expect `model === 'm2:free'`.
  - `openrouter empty content → RouteError empty`
  - `abort → RouteError timeout`
  - `resolveGeminiModel picks highest flash with generateContent`: the list has `gemini-3.5-flash`, `gemini-4-flash`, `gemini-4-pro`, and `gemini-4-flash-tts` (no generateContent). Expect `'gemini-4-flash'`.
  - `buildPrompt` contains the question, says the reader must cite `file:line` and answer concisely, and for `task:'plan'` contains `implementation plan`.
- [ ] **Step 2: Run the tests.** `npx vitest run server/test/routes-http.test.ts` should FAIL.
- [ ] **Step 3: Implement** `types.ts`, `prompts.ts`, `gemini.ts`, and `openrouter.ts`. The API routes call `gatherContext` with their `budgetChars`.
- [ ] **Step 4: Run the tests.** They should PASS.
- [ ] **Step 5: Commit.**

```bash
git add server/src server/test && git commit -m "feat: Gemini API and OpenRouter routes"
```

---

### Task 4: Antigravity route

**Files:**
- Create: `server/src/routes/antigravity.ts`
- Test: `server/test/routes-agy.test.ts`, `server/test/fake-agy.mjs` (a test double driven by env `FAKE_AGY_MODE`)

**Interfaces:**
- Consumes: `Route`, `RouteError`, `buildPrompt` (Task 3), and the recipe from `docs/findings.md` (Task 0)
- Produces: `export const antigravityRoute: Route; export function buildAgyArgs(prompt: string, cwd: string): string[];`

If Task 0 decided **dropped**, implement `configured()` to return `"Antigravity CLI headless mode not supported on this machine (see docs/findings.md)"` and skip Steps 1–4 except that test.

- [ ] **Step 1: Write the failing tests.** In the tests, `cfg.antigravity.command` = `node <abs path to fake-agy.mjs>`.
  - `buildAgyArgs` includes `-p`, `--output-format`, and `json`, includes the read-only flags from `docs/findings.md`, and **never** includes `--dangerously-skip-permissions`.
  - `parses answer field`: `FAKE_AGY_MODE=ok` prints the JSON shape recorded in findings, so `text` equals the answer.
  - `waits on stdin → timeout`: `FAKE_AGY_MODE=hang` sleeps forever. With `timeoutMs: 1500`, expect `RouteError` `timeout` within 3000 ms and the child process gone.
  - `signed out → auth`: `FAKE_AGY_MODE=signedout` prints the sign-in message from findings and exits with its code. Expect `auth`.
  - `quota → rate_limit`: uses the quota string from findings.
  - `missing binary → not_configured`: `configured()` with `command: 'agy-does-not-exist'` returns a hint containing `install`.
  - `cwd with spaces`: the run passes a cwd containing a space, and the fake echoes its cwd back correctly.
- [ ] **Step 2: Run the tests.** `npx vitest run server/test/routes-agy.test.ts` should FAIL.
- [ ] **Step 3: Implement the route.**
  - Use `child_process.spawn` with the recipe from findings and `cwd: req.cwd`.
  - The prompt is `buildPrompt(req)` with no gathered context, since agy reads the folder itself.
  - On timeout, kill the process tree: `taskkill /PID <pid> /T /F` on win32, `process.kill(-pid)` elsewhere with `detached: true`.
  - `configured()` checks the binary exists by resolving it on PATH, with a cached result.
- [ ] **Step 4: Run the tests.** They should PASS.
- [ ] **Step 5: Live check (manual).** In `<your-project>` (an example client project with spaces in its path), run a scratch script that calls `antigravityRoute.ask({question:'Where are database migrations defined?', task:'explore', cwd})`. The answer should cite real files. Then run `git status` / `dir` and confirm no new files were created in the project.
- [ ] **Step 6: Commit.**

```bash
git add server/src/routes/antigravity.ts server/test && git commit -m "feat: Antigravity CLI route (read-only, timeout-safe)"
```

---

### Task 5: Router, cooldowns, handoff log

**Files:**
- Create: `server/src/router.ts`, `server/src/log.ts`
- Test: `server/test/router.test.ts`, `server/test/log.test.ts`

**Interfaces:**
- Consumes: `Route`, `RouteError`, `RouteRequest` (Task 3), `BridgeConfig` (Task 1)
- Produces:

```ts
export interface Attempt { route: RouteName; outcome: 'ok' | FailureKind | 'cooldown'; detail?: string; ms: number }
export interface BridgeAnswer { ok: boolean; text: string; route?: RouteName; model?: string; attempts: Attempt[]; ms: number }
export async function askWithFallback(req: RouteRequest & { route?: RouteName | 'auto' }, routes: Route[], cfg: BridgeConfig, now?: () => number): Promise<BridgeAnswer>;
export function formatFooter(a: BridgeAnswer): string;        // e.g. "— via gemini (gemini-4-flash) · fallbacks: antigravity: timeout · 12.4s"
export interface LogEntry { ts: string; project: string; task: TaskKind; question: string; attempts: Attempt[]; ok: boolean; inChars: number; outChars: number; ms: number; fullQuestion?: string; fullAnswer?: string }
export function appendLog(cfg: BridgeConfig, e: LogEntry): void;   // logs/YYYY-MM.jsonl, question truncated to 200 chars
export function readLog(cfg: BridgeConfig, n: number, project?: string): LogEntry[];
```

- **Cooldowns:** persisted in `state.json` as `{ [route]: untilEpochMs }`. A route in cooldown is recorded as `'cooldown'` and skipped.
- **Missing config:** `not_configured` routes are skipped, recorded in `attempts`, and do not trigger a cooldown.
- **Forced route:** a forced `route` tries only that route. On failure it then **does** fall back, and the footer says so.

- [ ] **Step 1: Write the failing tests** (`router.test.ts`, with fake routes):
  - `first ok wins`: A ok, so `route==='antigravity'` and `attempts.length===1`.
  - `timeout falls back`: A throws `timeout` and B ok, so `route==='gemini'` and `attempts[0].outcome==='timeout'`.
  - `not_configured skipped silently`: A not configured and B ok, so `ok` is true, with no cooldown written.
  - `429 sets cooldown and next call skips`:
    - First call: A throws `rate_limit` with `retryAfterMs` 30000, and B ok.
    - Second call at `now+1000`: `attempts[0].outcome==='cooldown'` and A.ask is not called.
  - `cooldown expires`: at `now+31000`, A is tried again.
  - `all fail`: `ok===false`, and `text` lists each route with its reason on its own line plus the line `Do this task yourself and tell the user the bridge was unavailable.`
  - `forced route then fallback`: `route:'openrouter'` fails, so the result comes from another route, with `attempts[0].route==='openrouter'`.
  - `formatFooter` matches `/via gemini \(m\).*antigravity: timeout/`.
- [ ] **Step 2: Write the failing tests** (`log.test.ts`, temp `homeDir`):
  - `appends jsonl to month file` (`logs/2026-10.jsonl`)
  - `truncates question to 200`
  - `omits full text unless log.fullText`
  - `readLog returns newest first, filtered by project`
  - `never writes inside project cwd`: after `appendLog` with `project: tmpProject`, `tmpProject` is still empty.
- [ ] **Step 3: Run the tests.** `npx vitest run server/test/router.test.ts server/test/log.test.ts` should FAIL.
- [ ] **Step 4: Implement** `router.ts` and `log.ts`. Each route call gets `AbortSignal.timeout(route timeoutMs)`.
- [ ] **Step 5: Run the tests.** They should PASS.
- [ ] **Step 6: Commit.**

```bash
git add server/src/router.ts server/src/log.ts server/test && git commit -m "feat: fallback router with cooldowns and handoff log"
```

---

### Task 6: MCP server and bundle

**Files:**
- Create: `server/src/index.ts`, `server/src/status.ts`
- Generated (committed): `plugin/server/bridge.mjs`
- Test: `server/test/server.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: MCP tools (names are final and are referenced by the skill and commands in Task 7):
  - `ask_model { question: string; task?: TaskKind = 'ask'; paths?: string[]; route?: 'auto'|RouteName = 'auto'; model?: string; cwd?: string }`. The result text is the answer plus `formatFooter`, with `isError: !ok`. `cwd` defaults to `process.env.CLAUDE_PROJECT_DIR ?? process.cwd()`.
  - `bridge_status {}`. The result is one line per route: configured / hint, cooldown remaining, and handoffs today. It ends with the config file path.
  - `bridge_log { n?: number = 10; project?: string }`. The result is a compact table: time, route, outcome, and the first 80 chars of the question.
- `export function createServer(cfg?: BridgeConfig, routes?: Route[]): McpServer;`

- [ ] **Step 1: Write the failing tests.** Use the SDK client against `createServer(cfg, fakeRoutes)` over an in-memory transport pair. If the SDK version lacks one, spawn `node plugin/server/bridge.mjs` and talk JSON-RPC over stdio instead.
  - `lists three tools`: `ask_model`, `bridge_status`, `bridge_log`.
  - `ask_model happy path`: the text contains the fake answer and `via antigravity`.
  - `ask_model all-fail`: `isError === true`.
  - `bridge_status shows not-configured hint for gemini without key`
  - `ask_model logs one entry`: after the call, `readLog(cfg, 1)` has length 1.
- [ ] **Step 2: Run the tests.** `npx vitest run server/test/server.test.ts` should FAIL.
- [ ] **Step 3: Implement** `index.ts` (`createServer`, plus `main()` with `StdioServerTransport` when run directly) and `status.ts`.
- [ ] **Step 4: Bundle.** `scripts/build.mjs` runs esbuild with `bundle`, `platform node`, `format esm`, `target node20`, `outfile plugin/server/bridge.mjs`, and a `banner` adding `createRequire` for CJS deps. Run `npm run build`.
- [ ] **Step 5: Run the full suite.** `npm test` should show all PASS.
- [ ] **Step 6: Smoke-test the bundle.** Run `node plugin/server/bridge.mjs` with stdin carrying an MCP `initialize` + `tools/list` request. Expect a response listing the three tools, from a folder that has **no** `node_modules`. Copy the bundle to a temp dir to prove this.
- [ ] **Step 7: Commit.**

```bash
git add server plugin/server/bridge.mjs scripts/build.mjs && git commit -m "feat: MCP server with ask_model, bridge_status, bridge_log; bundled"
```

---

### Task 7: Claude Code plugin, skill, commands, marketplace

**Files:**
- Create:
  - `plugin/.claude-plugin/plugin.json`
  - `plugin/.mcp.json`
  - `plugin/skills/model-bridge/SKILL.md`
  - `plugin/commands/ask.md`, `plugin/commands/bridge-status.md`, `plugin/commands/bridge-log.md`, `plugin/commands/bridge-setup.md`
  - `.claude-plugin/marketplace.json`
- Test: manual verification steps below. These are config and prose files.

**Interfaces:**
- Consumes: the tool names from Task 6
- Produces:
  - Plugin name `model-bridge` and marketplace name `claude-model-bridge`. Install command: `/plugin install model-bridge@claude-model-bridge`.
  - `.mcp.json`: `{"mcpServers":{"model-bridge":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server/bridge.mjs"]}}}`
  - `marketplace.json`: `$schema` `https://json.schemastore.org/claude-code-marketplace.json`, one plugin `{name:'model-bridge', source:'./plugin'}`.

- [ ] **Step 1: Write `plugin.json`** (name, version `0.1.0`, description, repository URL placeholder replaced in Task 9) and `.mcp.json`.
- [ ] **Step 2: Write `SKILL.md`.**
  - **Frontmatter `description`:** use when about to read many files, locate where something is handled, summarise large files or logs, or draft a plan, so the work goes to a free model via `ask_model` to save Claude usage.
  - **Body:**
    - when to delegate and when not, per spec §6.7
    - phrase questions to get short answers with `file:line` citations
    - spot-check cited lines before editing
    - if `ask_model` returns `isError`, do the work yourself and tell the user in one line
    - mention the route used when relaying an answer
    - respect the user's CLAUDE.md, `WORKFLOW.md`, and `.agents/`
- [ ] **Step 3: Write the commands.**
  - `ask.md`: argument hint `[agy|gemini|openrouter] <question>`. The first word picks the route if it matches. Call `ask_model` with `cwd` = current project.
  - `bridge-status.md` calls `bridge_status`, and `bridge-log.md` calls `bridge_log`.
  - `bridge-setup.md`:
    - Call `bridge_status`.
    - For each unconfigured route, print exact steps: install `agy` and sign in, create a key at aistudio.google.com, create a key at openrouter.ai, then set them with `setx GEMINI_API_KEY "<key>"` on Windows or `export` on Unix, and restart Claude.
    - **Never ask the user to paste a key into chat.**
- [ ] **Step 4: Write `.claude-plugin/marketplace.json`.**
- [ ] **Step 5: Validate.** Run `claude plugin validate .`. If that subcommand doesn't exist in the installed version, use `/plugin` UI errors as the check. Expect no errors.
- [ ] **Step 6: Install locally and verify.**
  - In a Claude Code session, run `/plugin marketplace add <repo-root>` and then `/plugin install model-bridge@claude-model-bridge`. Restart.
  - In `<your-project>`:
    - Run `/model-bridge:bridge-status`. Expect three route lines.
    - Run `/model-bridge:ask where are the database migrations?`. Expect an answer with a footer.
    - Ask Claude something broad ("give me an overview of how invoices are voided"). Expect Claude to call `ask_model` on its own.
  - Check `~/.claude-model-bridge/logs/` for entries and confirm no new files in the project.
- [ ] **Step 7: Verify in the desktop app's Code tab.** Repeat the `/bridge-status` check there.
- [ ] **Step 8: Commit.**

```bash
git add plugin .claude-plugin && git commit -m "feat: Claude Code plugin, skill, commands, marketplace"
```

---

### Task 8: Claude Desktop extension (.mcpb) and Desktop skill

**Files:**
- Create: `desktop/manifest.json`, `desktop/build.mjs`, `desktop/README.md`
- Generated: `desktop/dist/model-bridge.mcpb` (not committed; attached to GitHub Releases in Task 9), `desktop/dist/model-bridge-skill.zip`

**Interfaces:**
- Consumes: `plugin/server/bridge.mjs`, `plugin/skills/model-bridge/SKILL.md`
- Produces: `npm run build:desktop` → the two artifacts above

- [ ] **Step 1: Check the manifest format.** Look up the current `.mcpb` manifest schema (Context7 `@anthropic-ai/mcpb`, or its repo README). Write `desktop/manifest.json`:
  - `server.type: "node"`, entry point `server/bridge.mjs`
  - `user_config` entries for `gemini_api_key` and `openrouter_api_key` (`sensitive: true`), mapped to env `GEMINI_API_KEY` / `OPENROUTER_API_KEY`
- [ ] **Step 2: Write `desktop/build.mjs`.** It copies the bundle and manifest into a staging dir, runs `npx @anthropic-ai/mcpb pack`, and zips `SKILL.md` into `model-bridge-skill.zip`. Add an npm script `build:desktop`.
- [ ] **Step 3: Build.** Run `npm run build:desktop`. Expect both files in `desktop/dist/`.
- [ ] **Step 4: Manual install (the owner does this).** Open the `.mcpb` in Claude Desktop, enter keys in its settings form, and upload the skill zip in Settings → Capabilities/Skills. In a chat, say "ask Gemini what the file `<some path>` does". Expect an answer with a footer. Desktop chat has no session cwd, so the skill must tell Claude to pass `cwd` explicitly. Add that line to `SKILL.md` and rebuild.
- [ ] **Step 5: Commit.**

```bash
git add desktop plugin/skills package.json && git commit -m "feat: Claude Desktop extension and skill package"
```

---

### Task 9: Cowork check, README, publish

**Files:**
- Create: `README.md`, `LICENSE` (MIT)
- Modify: `docs/findings.md` (add a Cowork section), `plugin/.claude-plugin/plugin.json` (repository URL)

- [ ] **Step 1: Cowork verification** (spec §7.4). Install the plugin in a Cowork session from the local marketplace, then run `/bridge-status` and one `/ask` per route. Record which routes work and why the others fail in `docs/findings.md`. If `agy` is unreachable from Cowork, the router already skips it as `not_configured`. Confirm this in the footer.
- [ ] **Step 2: Write `README.md`.** It covers:
  - what it does (3 lines)
  - install per surface: CLI / Code tab, Desktop chat, Cowork
  - per-PC setup: the `/model-bridge:bridge-setup` flow
  - config reference
  - data-use note: free tiers may train on submitted code
  - the Antigravity ToS note: the Bridge only runs the official CLI
- [ ] **Step 3: Run the checks.** `npm test` and `npm run check-secrets` on all tracked files (`git ls-files | node scripts/check-secrets.mjs --files`). Expect 0 hits.
- [ ] **Step 4: Ask the owner before publishing** (outward-facing). Confirm the GitHub owner/name, then:

```bash
gh repo create claude-model-bridge --public --source . --push
```

  Set the repository URL in `plugin.json`, then commit and push.
- [ ] **Step 5: Release.** Run `gh release create v0.1.0 desktop/dist/model-bridge.mcpb desktop/dist/model-bridge-skill.zip --notes "Phase 1: delegation"`.
- [ ] **Step 6: Verify a clean install from GitHub.** On this PC, remove the local marketplace, then run `/plugin marketplace add <owner>/claude-model-bridge` and `/plugin install model-bridge@claude-model-bridge`. `/model-bridge:bridge-status` should work.
- [ ] **Step 7: Final commit.**

```bash
git add README.md LICENSE docs/findings.md plugin/.claude-plugin/plugin.json && git commit -m "docs: README, Cowork findings, publish metadata"
```
