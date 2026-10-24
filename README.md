# Claude Model Bridge

A Claude plugin and MCP server that lets Claude hand broad, token-hungry work to free models and get back a short answer.
Use it for reading many files, locating where something is handled, summarising large files or logs, and first-draft plans.
Claude keeps doing the edits; the free model only reads and reports, citing `path:line`.

## Routes

The bridge tries routes in order and moves on after a timeout, a failure, an empty answer or a 429 (which starts a cooldown).

| Route | What it uses | Status in v0.2.0 |
|---|---|---|
| `antigravity` | Google's official Antigravity CLI (`agy`) with a Google AI Pro subscription | Available (tested with `agy` 1.4.7 on Windows). agy reads the project folder itself, read-only. |
| `gemini` | Gemini API with a free AI Studio key (`GEMINI_API_KEY`) | Available |
| `openrouter` | OpenRouter `:free` models (`OPENROUTER_API_KEY`), or any OpenAI-compatible endpoint set with `openrouter.baseUrl` | Available |

For a self-hosted option, point `openrouter.baseUrl` at a router such as [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi). The key is optional for hosts that do not need one. If `OPENROUTER_API_KEY` is set, it is sent to whatever `baseUrl` is configured.

## Install

**Claude Code (CLI and desktop Code tab):**

```
/plugin marketplace add arnoldduo2/claude-model-bridge
/plugin install model-bridge@claude-model-bridge
```

From a local clone instead: `/plugin marketplace add <path-to-clone>`.

Commands: `/model-bridge:ask`, `/model-bridge:bridge-status`, `/model-bridge:bridge-log`, `/model-bridge:bridge-setup`. Claude also uses the `ask_model` tool on its own, guided by the bundled `model-bridge` skill.

**Claude Desktop chat.** Install the `.mcpb` extension and upload the skill zip, both from GitHub Releases. Steps are in [desktop/README.md](desktop/README.md). Chat has no project folder, so the skill tells Claude to pass `cwd` explicitly.

**Cowork.** Should work via the same plugin; verification is pending.

Requires Node 20 or newer available as `node`.

## Setup (per PC)

Run `/model-bridge:bridge-setup`. It calls `bridge_status` and prints the exact steps for each route that is not configured.

- Antigravity: install `agy` (Windows PowerShell: `irm https://antigravity.google/cli/install.ps1 | iex`), run `agy` once in a terminal and sign in with your Google account. The bridge finds `agy` on `PATH` (on Windows also in `%LOCALAPPDATA%\agy\bin`); set `antigravity.command` to its full path if it lives elsewhere.
- Gemini: create a key at https://aistudio.google.com/apikey.
- OpenRouter: create a key at https://openrouter.ai/keys.
- Windows: `setx GEMINI_API_KEY "<your key>"` (or `OPENROUTER_API_KEY`) in a terminal, then fully restart Claude. macOS/Linux: `export GEMINI_API_KEY="<your key>"` in your shell profile.
- Or put keys in `~/.claude-model-bridge/config.json` (outside every repo; never commit it).

Never paste keys into the chat. Run `/model-bridge:bridge-status` afterwards to confirm each route.

## Usage

- Just work normally. Claude delegates reading-heavy questions through `ask_model` and spot-checks the cited lines before relying on them.
- Force a handoff: `/model-bridge:ask [agy|gemini|openrouter] <question>`. A forced route that cannot be used (for example `agy` when it is not installed) falls back to the next route, and the footer says `requested antigravity: not configured`.
- Route health, cooldowns and today's handoff counts: `/model-bridge:bridge-status`.
- Recent handoffs (metadata only): `/model-bridge:bridge-log [count]`.

`ask_model` takes `question`, `task` (`explore`, `plan`, `review`, `ask`), `paths`, `route` (`auto` or a route name), `model` and `cwd`. Every answer ends with a footer naming the route and model that produced it.

- `paths` entries are files, folders or simple globs (`*`, `**`, `?`) relative to `cwd`. They are sent first, in the order given, before any file the bridge picks itself. A named file larger than 200 KB is sent as its head and tail with a `[… N bytes omitted …]` marker.
- `model` applies only to the forced route (or the first route tried); fallback routes use their own models.
- `cwd` must be a project folder: the bridge refuses a drive root, your home folder (or a folder containing it) and its own `~/.claude-model-bridge` folder.

## Configuration reference

Optional file: `~/.claude-model-bridge/config.json`. Start from [config.example.json](config.example.json); anything you omit uses the default. Environment variables `GEMINI_API_KEY` and `OPENROUTER_API_KEY` override the file. If the file has a mistake (bad JSON or a field of the wrong type), the server still starts and every tool reports the problem with the file path until you fix it.

| Field | Default | Meaning |
|---|---|---|
| `routeOrder` | `["antigravity", "gemini", "openrouter"]` | Order routes are tried in `auto` mode |
| `antigravity.command` | `agy` | Antigravity CLI binary: a name on `PATH` or a full path to `agy.exe` |
| `antigravity.timeoutMs` | `180000` | Kill the route after this long |
| `gemini.apiKey` | unset | Prefer the env var |
| `gemini.model` | unset | Override the Gemini model |
| `gemini.timeoutMs` | `120000` | Route timeout |
| `gemini.budgetChars` | `400000` | Max characters of file context sent |
| `openrouter.apiKey` | unset | Prefer the env var. Optional for non-OpenRouter hosts |
| `openrouter.baseUrl` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint |
| `openrouter.models` | `[]` | Models to try, in order |
| `openrouter.timeoutMs` | `120000` | Route timeout |
| `openrouter.budgetChars` | `100000` | Max characters of file context sent |
| `cooldownMs` | `60000` | Cooldown after a 429 when the server gives no retry time |
| `log.fullText` | `false` | Also log full questions and answers |

## Privacy and terms

- **Local files only.** Logs, state and config live in `~/.claude-model-bridge/`, as does the bridge's read-only agy agent (`agy-workspace/`). Nothing is written into your projects. Logs hold metadata only unless `log.fullText` is `true`.
- **Data use.** Free tiers (the Gemini API free tier, many OpenRouter free models, FreeLLMAPI's upstreams) may use submitted code to improve their products. Only delegate code you are comfortable sending, and never secrets: the question and the files read leave your machine.
- **Secret filtering.** The bridge never sends `.env*` files, key and certificate files, or credential stores (`.ssh`, `.aws`, `.kube`, `.azure`, `.config/gh`, `.config/gcloud`, `.docker/config.json` and similar). In the files it does send, key-shaped tokens and values assigned to names like `password`, `secret`, `token` or `api_key` are replaced with `[REDACTED]`, and your configured API keys are stripped from every prompt. This is a safety net, not a guarantee: still keep secrets out of delegated questions.
- **Antigravity reads files itself.** On the `antigravity` route the bridge sends only the question; agy opens project files with its own tools, and the files it reads are not redacted. A bridge guard hook checks every tool call before it runs. It blocks any file or folder outside the project (including `../` and link tricks) and anything matching the secret-file rules above (`.env*`, keys, certificates, credential stores). It also blocks version-control folders (`.git`, `.svn`, `.hg`), because `.git/config` can hold a token in a remote URL. Allowed reads are auto-approved for that call, overriding any agy `permissions.deny` rules you set for files inside the project. The model can only view files, list folders and find files by name. It has no content search, because those results could not be filtered.
- **Antigravity is read-only.** agy runs as a bridge-owned custom agent whose only tools are `view_file`, `list_dir` and `find_by_name`, with no MCP tools. The guard hook denies every other tool, so the agent cannot write files, run commands or call MCP servers. `--dangerously-skip-permissions` is never used, and API keys are removed from agy's environment.
- **Projects that bring their own agy code are refused.** This covers hooks, plugins, MCP servers, or agent and skill definitions that pull in outside code, in a `.agents`, `.agent`, `_agents` or `_agent` folder of the project or any parent folder except your home folder. The bridge never starts agy for such a project; it names the file and falls back to the next route. Details and the live proof are in [docs/findings.md](docs/findings.md).
- **What a handoff leaves behind in agy.** Each handoff is an ordinary agy conversation in your agy history and uses your AI Pro quota. agy also starts your own global MCP servers, plugins and global hooks for the session, as it does for any agy session. The bridge's agent cannot call those MCP servers.
- **Antigravity terms.** The bridge only ever runs Google's official `agy` binary. It never reads or reuses Google sign-in credentials, because Google's terms prohibit third-party use of Gemini CLI and Antigravity OAuth sign-in.

## Development

```bash
npm install
npm test                  # vitest
npm run build             # bundles server to plugin/server/bridge.mjs (committed)
npm run build:desktop     # .mcpb and skill zip into desktop/dist/
git config core.hooksPath .githooks   # secret-scan pre-commit check
```

`npm run check-secrets` scans for key-like strings; the pre-commit hook runs it.

## Roadmap

- Phase 2: run a whole Claude Code session on free models when Claude's limit is exhausted, likely via FreeLLMAPI's Anthropic-compatible endpoint. API keys only, never a Google sign-in.

## License

[MIT](LICENSE)
