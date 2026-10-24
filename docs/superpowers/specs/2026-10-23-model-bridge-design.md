# Claude Model Bridge — Design

Date: 2026-10-23
Status: Draft; owner questions answered; awaiting approval
Location: `<repo-root>` (own repo, later hosted on GitHub)

---

## 1. Intent and why

The owner pays for a Claude subscription and a Google AI Pro subscription. The Claude plan runs out partway through the week, and work stalls until it resets. Much of what burns Claude's limit is token-heavy work that doesn't need Claude: reading large codebases, finding where something is handled, and drafting plans.

Handing that work to Gemini today means switching to Antigravity by hand. That is slow, breaks flow, and is hard to track.

The Bridge lets Claude **hand pieces of work to other models from inside a session**, as easily as choosing Opus or Sonnet. Only the short answer comes back into Claude's context, so Claude's limit pays for the answer, not for reading the whole codebase.

Success means Claude's weekly limit lasts noticeably longer, handoffs happen without the owner leaving the session, and the owner can see afterwards what was handed off, to which model, and whether it worked.

## 2. Goals

- **G1 — Delegation (mode A, the main mode).** Claude can send a question to another model and get an answer back as a tool result. Claude may decide to delegate on its own. The owner can also force it ("ask Gemini…", or `/ask`).
- **G2 — Three routes, in fallback order:**
  1. **Antigravity CLI (`agy`)**, using the owner's Google AI Pro subscription through Google's own official CLI.
  2. **Gemini API**, using a free Google AI Studio API key.
  3. **OpenRouter free models** (`:free` model IDs), using a free OpenRouter key. This route has a configurable base URL, so it can instead point at any OpenAI-compatible endpoint, such as a self-hosted FreeLLMAPI router (owner decision, 2026-10-23).
- **G3 — No babysitting.** If a route fails, times out, or is rate-limited, the Bridge moves to the next one. If every route fails, Claude does the work itself and says in one line why.
- **G4 — Traceable.** Every handoff is logged, and the owner can view recent handoffs from inside a session.
- **G5 — Any project.** Nothing is set up per project. It works in any folder and any language, with or without git, in old and new projects alike. It never writes into the project.
- **G6 — Every Claude surface.** Claude Code CLI, the Code tab of the Claude desktop app, Claude Desktop chat, and Cowork (see §7 for the Cowork caveat).
- **G7 — Easy install on every PC.** Install from a GitHub repo, or a plugin marketplace backed by it, with a short per-PC setup: keys plus the Antigravity sign-in.
- **G8 — Mode B, phase 2.** A way to run a whole Claude Code session on a non-Claude model when Claude's limit is exhausted. It is powered **only by API keys** (AI Studio or OpenRouter), never by the AI Pro sign-in (see anti-goals).

## 3. Non-goals

- Not a general chat UI or a replacement for Antigravity.
- Delegated models never edit files. Edits stay with Claude.
- No paid API usage. Free tiers and the existing AI Pro subscription only, unless the owner later opts in.
- No per-project configuration files.

## 4. Anti-goals (failure even if it "works")

- **Never reuse Google sign-in credentials outside Google's own CLI.** Gemini CLI/Antigravity terms say that using its OAuth sign-in from third-party software is a violation and "may be grounds for suspension or termination of your account." The Bridge only ever *runs the official `agy` binary*. It never reads `~/.gemini/oauth_creds.json` or similar, and never proxies them.
- **Never send secrets to an outside model.** The context gatherer must exclude `.env*`, key/cert files, credential configs, and anything matching common secret patterns.
- **Never stall silently.** A hung route is killed on a timeout, and the fallback happens.
- **Never become a tool to babysit.** No interactive prompts mid-session, and no manual restarts after a failure.
- **Never write into the owner's projects.** That covers logs, caches, and config.

## 5. Constraints and facts found during recon

- **Machine:** Windows 11 with Node 24, npm 11 and git. Gemini CLI, Antigravity CLI and Ollama are not installed. Leave unrelated global packages on the owner's machine alone.
- `ANTHROPIC_BASE_URL` is set in the environment (to `https://api.anthropic.com`). Mode B must only override it for the child process it launches, never globally.
- **Antigravity CLI:**
  - On 2026-06-18 it replaced Gemini CLI for unpaid and Google One users.
  - It has a print mode (`-p` / `--prompt`) and `--output-format text|json|stream-json`.
  - **Known Windows bug:** `agy -p` reportedly hangs when stdout is redirected or there is no TTY (issue google-antigravity/antigravity-cli#318, reported on 1.0.6). A pseudo-terminal workaround exists (e.g. `node-pty`/ConPTY). The builder must test this first.
  - `--dangerously-skip-permissions` must **not** be used. Read-only behaviour must be enforced.
- **Gemini API free tier:**
  - Limits are per project, cover RPM, TPM, and RPD, and are viewable in AI Studio.
  - Pro-class models may not be in the free tier.
  - The builder must not hard-code model names. Discover them via the models list endpoint and keep them in config.
- **OpenRouter free models:** reportedly 20 RPM, and 50 requests/day (1,000/day after a one-time $5 purchase). These are unverified third-party figures. Free model IDs change often.
- **Data use (see §9 Q1):** free tiers may use submitted content to improve their products.

## 6. Design (decided)

### 6.1 Shape

One repo, one core, several thin wrappers:

```
claude-model-bridge/
  server/            ← the core: a local MCP server (stdio), Node
  plugin/            ← Claude Code plugin wrapper (also used for Cowork)
  desktop/           ← Claude Desktop extension wrapper (.mcpb)
  launcher/          ← phase 2: mode B launcher
  .claude-plugin/marketplace.json   ← makes the repo installable as a marketplace
  docs/
```

### 6.2 Core MCP server — tools exposed to Claude

- **`ask_model`**
  - **Inputs:**
    - `question`
    - `task`, one of:
      - `explore`: find where or how something is handled
      - `plan`: draft an implementation plan
      - `review`: second opinion
      - `ask`: general
    - optional `paths`: files, folders, or globs to focus on
    - optional `route`: `auto` | `antigravity` | `gemini` | `openrouter`
    - optional `model`
    - optional `cwd`: defaults to the session's working folder
  - **Returns:** the answer text plus a short footer. The footer names the route and model used, any fallbacks taken and why, and the elapsed time.
  - **Answer shape:** the delegated model is instructed to answer concisely and to cite `file:line` for every claim about code, so Claude can spot-check before acting.
- **`bridge_status`**: which routes are configured and reachable, current cooldowns, and today's handoff count per route.
- **`bridge_log`**: the last N handoffs, optionally filtered by project.

### 6.3 Routes

- **Antigravity:**
  - Runs the official `agy` in print mode with JSON output, with the project folder added as context. A system/prompt preamble says it must not modify files.
  - Read-only enforcement goes beyond the preamble. Use agy's permission or approval settings so file writes and shell commands are denied, not auto-approved.
  - Runs under a PTY if needed (Windows bug), with a hard timeout.
- **Gemini API:** a direct REST call (`fetch`; no SDK is needed). The Bridge gathers the context itself (§6.4).
- **OpenRouter:** a direct REST call to its OpenAI-compatible endpoint, using a configured ordered list of `:free` models. The Bridge gathers the context itself.

### 6.4 Context gathering (API routes only)

- Starts from `paths` if given. Otherwise it uses a file tree of `cwd` plus files picked by simple relevance: filename and path match, then a content grep for terms from the question.
- Respects `.gitignore` when present, and always skips `node_modules`, `vendor`, build outputs, binaries, lockfiles, and **secret files** (§4).
- Stays under a configurable size budget sized to the chosen model's context window. Each file is sent with its path, and line numbers allow `file:line` citations.

### 6.5 Fallback and rate limits

- **Default order:** antigravity → gemini → openrouter. Configurable.
- **Moving on:** on timeout, non-zero exit, 429/quota errors, or empty output, the Bridge moves to the next route. A 429 puts that route on a cooldown, and the cooldown is honoured across calls.
- **All routes failed:** the tool returns a clear "all routes failed: …" result. Claude's instructions tell it to do the work itself and say so in one line.

### 6.6 Log

- **Location:** `~/.claude-model-bridge/logs/YYYY-MM.jsonl` (user folder, never the project).
- **One line per handoff:** timestamp, project path, task, question (truncated), route/model chain tried, outcome, bytes in/out, duration.
- **Prompts and answers** are not stored in full by default. A config flag can turn that on.

### 6.7 Claude instructions (skill)

The skill tells Claude:
- **When to delegate:** broad codebase reading, "where is X handled", summarising large files or logs, and first-draft plans.
- **When not to delegate:** edits, small targeted reads, or anything secret.
- **How to phrase delegation questions** so answers stay short.
- **Spot-checking:** before editing, verify cited `file:line` locations.
- **Repo instructions:** respect the user's global CLAUDE.md role division and any `WORKFLOW.md`/`.agents/` notes.

### 6.8 Commands (Claude Code / Cowork plugin)

- `/ask <question>`: force a handoff. `/ask gemini …`, `/ask openrouter …`, and `/ask agy …` pick a route.
- `/bridge-status`: route health and usage.
- `/bridge-log`: recent handoffs.
- `/bridge-setup`: checks what's missing on this PC (`agy` installed and signed in, keys present, models reachable) and prints exact next steps. It never asks for keys in chat.

### 6.9 Configuration and secrets

- **Keys:** `GEMINI_API_KEY` and `OPENROUTER_API_KEY` from user environment variables. Alternatively they can go in `~/.claude-model-bridge/config.json`, which lives outside every repo.
- **Config file:** holds route order, model choices, timeouts, size budgets, and log options.
- **The repo** contains only `config.example.json`. Its `.gitignore` covers any local config.

### 6.10 Packaging per surface

- **Claude Code CLI and the desktop Code tab:** the `plugin/` folder is a Claude Code plugin. It bundles the MCP server, the skill, and the commands. It is user-scoped, so it is active in every project.
- **Claude Desktop chat:** `desktop/` builds a Desktop Extension (`.mcpb`) of the same server, attached to GitHub Releases. The skill is uploaded to Claude Desktop separately. Chat has no slash commands, so the owner says "ask Gemini…".
- **Cowork:** installed from the same plugin/marketplace. See §7 for what must be verified.
- **Install across PCs:**
  - The GitHub repo doubles as a plugin marketplace: `/plugin marketplace add <owner>/claude-model-bridge`, then `/plugin install`.
  - The server ships **pre-bundled** (single JS file committed to `dist/`), so no `npm install` is needed on each PC.
  - Per-PC steps are then: install `agy` and sign in, set the two keys, and run `/bridge-setup`.

### 6.11 Mode B (phase 2)

- **Launcher command:** `claude-free` (`.cmd`/`.ps1` plus `sh`). It starts a local translator that speaks Anthropic's Messages API on the front and calls the Gemini API or OpenRouter on the back, using API keys only. It then launches `claude` with `ANTHROPIC_BASE_URL` pointing at the translator, for that process only.
- **Expectation, stated to the owner:** these models are weaker than Claude at long multi-step agentic edits. Mode B is for continuing work when Claude is exhausted.
- **Detailed design:** done after phase 1 ships. Whether to build the translator or adopt an existing well-maintained one is left to that design.

## 7. Open technical verifications (builder must check before or while building)

1. **`agy` headless on Windows:** does `agy -p --output-format json` work when spawned from Node without a TTY on the current version? If not, does a PTY wrapper fix it?
2. **`agy` read-only:** which flags or settings deny file writes and shell commands in print mode?
3. **Antigravity sign-in:** does `agy` sign-in with the owner's AI Pro account work, and what quota applies?
4. **Cowork:**
   - Can a Cowork session run a plugin's local MCP server?
   - Can that server spawn `agy` on the host?
   - Can it make outbound HTTPS calls to Google and OpenRouter?
   - If `agy` is unreachable, Cowork uses only the API routes. Document the result.
5. **Current Claude Code plugin and marketplace format:** check the current docs (Context7 / official docs) for the plugin manifest, bundled MCP servers, skills, commands, and GitHub marketplace install, including private-repo install.
6. **Current Claude Desktop Extension (`.mcpb`) format,** and how a skill is added to Desktop chat.
7. **Current free Gemini models** (list endpoint) and current OpenRouter `:free` models.

## 8. Left to the builder

- Internal code structure, libraries (the MCP SDK is the obvious one), bundler choice, and test approach.
- Exact relevance heuristics and default size budgets.
- Exact wording of the skill and the delegation prompt templates.
- Default timeouts and cooldown lengths.

## 9. Questions for the owner (only these change what gets built)

- **Q1 — Code sent to free tiers.**
  - **The issue:** free tiers of the Gemini API and many OpenRouter free models may use what's sent to them to improve their products. Client code from the owner's projects (for example, an example client project) would leave your machine. The Antigravity/AI Pro route has different terms.
  - **Owner's answer:** accepted. Sending project code to the free tiers is fine. No per-project restriction is needed in phase 1.
- **Q2 — Public or private GitHub repo.** A private repo still works across your PCs, but each PC needs to be signed in to GitHub (`gh auth login`) to install it.
  - **Owner's answer:** public.
  - **Consequences:** marketplace install needs no GitHub sign-in. The repo must never contain keys, personal paths, or log samples with real project content, so a pre-commit secret check is recommended.

## 10. Calls made by Claude (not agreed by the owner, open to change)

- Node for the core, pre-bundled so no per-PC `npm install` is needed.
- Fallback order: antigravity → gemini → openrouter.
- Logs store metadata, not full prompts and answers, by default.
- Delegated models are always read-only.
- Secret-file exclusion is always on.
- Mode B uses API keys only, and comes after mode A ships.
