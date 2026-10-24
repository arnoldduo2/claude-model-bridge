# Antigravity CLI (`agy`) headless findings

Spike for spec §7 items 1–3, run on Windows 11 on 2026-10-24, then extended after a security review the same day. All runs happened in throwaway folders (`<scratch>\…`, and one folder outside the user profile that was deleted afterwards), never in a real project.

**Decision: agy route: enabled.** Read-only access comes from three layers:

1. a custom agent with a restricted tool list;
2. a PreToolUse guard hook that hard-denies everything else;
3. a refusal to run in projects that bring their own agy hooks, plugins or MCP servers.

## Version

- `agy --version` → `1.4.7`.
- Installed by Google's installer at `%LOCALAPPDATA%\agy\bin\agy.exe`, which it puts on `PATH`. It is a native `.exe`, not a `.cmd` shim.
- The route accepts only versions it was tested on: major `1`, minor `4` or later. `configured()` runs `agy --version` once per server process. Any other version, or output it cannot read, gives `not_configured` with a hint.

## Headless on Windows (issue #318)

- `agy -p` does **not** hang on 1.4.7 when spawned from Node with no TTY and piped stdout/stderr. Every run returned and exited on its own.
- Changelog entries since 1.0.6 fix exactly this:
  - non-TTY output on Windows is no longer discarded;
  - stdin is no longer read when the prompt comes from a flag;
  - `FD_CLOEXEC` is set on the inherited pipes.
- Workarounds (a)–(c) from the plan were not needed, and there is no PTY or native dependency.

### Working spawn recipe

```js
spawn(agyExe, args, {
  cwd: projectFolder,          // the validated project folder; agy treats it as the workspace
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,                // agy is a real .exe; no shell, so the prompt is never shell-parsed
  windowsHide: true,
  env,                         // see below
});
```

`args`:

```
-p <prompt> --output-format json --disable-slash-commands
--agent <read-only agent name> --add-dir <bridge agent workspace>
[--model <id>]
```

`env` is a copy of the server's environment with these changes:

- **Removed:**
  - `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `OPENROUTER_API_KEY`;
  - any variable whose value contains a configured key;
  - any inherited `CMB_AGY_PROJECT`.
- **Added:**
  - `CMB_AGY_PROJECT=<project folder>`, which the guard reads;
  - node's folder, first on `PATH`.

Hooks inherit agy's environment (verified), so the guard sees the project folder and no API key reaches any hook.

Other details:

- **Run time.** About 10–45 s for a small question.
- **Timeouts.** agy has no default print timeout (`--print-timeout` defaults to `0s`). The bridge kills the whole process tree on timeout (`taskkill /PID <pid> /T /F` on Windows).
- **Command-line limit.** Windows caps a command line at 32 767 characters. The route measures the quoted command line (libuv quoting) and refuses anything over 32 000 characters.
- **Git Bash gotcha (testing only).** MSYS rewrites a leading-slash argument such as `/usage` into a path. Use `MSYS_NO_PATHCONV=1` when testing slash commands from Git Bash.

## Answer JSON

`--output-format json` prints one object on stdout:

```json
{"conversation_id":"…","status":"SUCCESS","response":"<answer text>","duration_seconds":21.3,"num_turns":1,
 "usage":{"input_tokens":…,"output_tokens":…,"thinking_tokens":…,"cache_read_tokens":…,"total_tokens":…},
 "denied_actions":[{"action":"read_file","display_name":"ListDir"}]}
```

- The answer text is in **`response`**.
- `status` is one of `SUCCESS`, `ERROR`, `CANCELED`, `INTERRUPTED`, `INVALID`, `WAITING` or `RUNNING`.
- `error` holds a message on failure.
- `denied_actions` is present only when a tool was soft-denied.
- An invalid `--output-format` value (e.g. `xml`) is silently ignored and plain text is printed. The bridge always passes `json`.

## Read-only enforcement

### The default agent is NOT read-only in print mode

- Baseline run with no `--agent`: "create x.txt … then run `node --version`".
- agy called `write_file` and `run_command`. **`x.txt` was created**, and the command ran because it matched an existing user allow rule.
- Headless mode auto-allows reads *and writes* inside the workspace. It also runs any shell command that matches a `permissions.allow` rule in the user's global settings.

### No CLI flag denies writes per run

- `--dangerously-skip-permissions` is the opposite of what we need and is never passed.
- `--mode` only offers `accept-edits`, `auto` and `plan`.
- `--sandbox` still runs commands.
- Deny rules live in the user's global `settings.json`. The bridge never changes the user's agy settings.

### Layer 1: a custom agent with a restricted tool list

- agy custom agents are Markdown files with YAML frontmatter. Only the tools listed in `tools:` are registered.
- The bridge writes its agent into its own folder, `~/.claude-model-bridge/agy-workspace/.agents/agents/<name>.md`, and passes that folder with `--add-dir`.
  - `--agent` only takes a name, not a path.
  - Agents in an `--add-dir` folder are found while `cwd` stays the project.

```markdown
---
name: cmb-readonly-<random hex>
description: Read-only code analysis agent used by Claude Model Bridge.
tools:
  - view_file
  - list_dir
  - find_by_name
mainAgent: true
subagent: false
inheritMcp: false
commandExecutionPolicy: off
---
```

- **`inheritMcp: false`** is required. Without it, the agent inherits the user's MCP servers through `call_mcp_tool`, and some of those can write.
- **`grep_search` is not offered** (changed after review). A folder-wide content search returns matching lines from any file, `.env` and credential files included, and its results cannot be filtered. The agent finds files by name and lists folders instead, then views them.
- **The random name suffix** is created once per install, so a repository cannot predict the name and shadow the agent.
- **`excludeDefaultComponents: true` was tried and dropped.** It also removes the prompt section that tells the model its workspace path.

Proof, with a neutral system prompt ("Do exactly what the user asks"):

- The restricted agent answered "I cannot create x.txt or run node --version because no file-writing or shell-execution tools are available". No `x.txt` appeared.
- The default agent with the same prompt created `x.txt` and ran the command.

### Layer 2: the PreToolUse guard hook

**Correction to the first version of this file.** It said that paths outside the workspace default to Ask and are soft-denied. That is not reliable: a user's agy settings can allow non-workspace file access (for example `nonWorkspaceFileAccessPolicy: AGENT_SETTING_POLICY_ALLOW`), and then `view_file` reads any path, such as the bridge's own `config.json`, `~/.ssh` or agy's own credential store. A prompt rule alone was shown not to stop `view_file` or `grep_search` from returning a credentials file's content.

The bridge therefore installs a guard hook next to its agent: `~/.claude-model-bridge/agy-workspace/.agents/hooks.json`. agy loads hooks from the `--add-dir` workspace, and they run for every tool call:

```json
{ "claude-model-bridge-guard": { "PreToolUse": [ { "matcher": "*",
  "hooks": [ { "type": "command", "command": "node cmb-guard.mjs", "timeout": 20 } ] } ] } }
```

`cmb-guard.mjs` is a few lines that import the shipped bundle (`bridge.mjs`) and call its `runAgyGuard`. If the import or the call fails, it prints a deny.

The guard reads the payload (`{toolCall:{name,args}, workspacePaths, …}`) and denies unless **all** of these hold:

- the tool is `view_file`, `list_dir` or `find_by_name`. Every other tool is denied, even if a future agy ignored `tools:`.
- `CMB_AGY_PROJECT` is set and absolute, and agy's `workspacePaths` contains that folder.
- the path argument (`AbsolutePath`, `DirectoryPath` or `SearchDirectory`), plus any other string argument whose name mentions path, dir, file or folder, passes every check below:
  - non-empty;
  - no NUL;
  - on Windows, no UNC or device prefix and no `:` after the drive letter;
  - no segment ending in a dot or space;
  - lexically inside the project;
  - its real path (`realpath`, case-insensitive on Windows) is inside the project's real path;
  - not a secret file or secret folder under the server's existing rules (`isSecretPath` / `isSecretDir`).
- A permitted call gets `{"decision":"allow"}`.

**agy's handling of hook results**, verified live with agy 1.4.7 and a probe hook:

| Hook result | Effect on the tool call |
|---|---|
| `{"decision":"deny","reason":…}` | blocked: `tool call denied by pre-tool hook: <reason>` |
| `{}` (no decision) | **blocked** (`tool call denied by pre-tool hook:`) |
| invalid JSON on stdout | blocked (`failed to unmarshal result from hook …`) |
| exit status ≠ 0 | blocked (`JSON hook … failed: command failed: exit status N`) |
| hook slower than its `timeout` | blocked |
| **empty stdout, exit 0** | **allowed**: this is the one fail-open case, so the guard always prints a decision |
| `{"decision":"allow"}` | allowed under agy's normal policy (the docs: "delegating to the next hook or default policy") |

The guard answers permitted calls with `allow` because `{}` blocks. `allow` is the documented "no objection" answer, and it never upgrades a call agy itself would deny. Every failure path in the guard (bad payload, missing project, stdin timeout, exception, failed import) prints a deny.

**How agy runs hook commands.** It does **not** run them through `cmd /c`, and it does not honour quotes: `node "C:\…\probe.cjs"` reached node with the literal quotes, and the script was not found. The working directory is the folder holding `hooks.json`. So the command is `node cmb-guard.mjs`, a relative file name with no quotes and no spaces, and the route puts node's folder first on agy's `PATH`.

**Live proof** (the route's own args and environment, `stream-json`, a prompt with no secret rule in it):

| Call | Result |
|---|---|
| `view_file` `<proj>\src\app.js` | OK |
| `view_file` `<proj>\.env` | `Blocked by Claude Model Bridge: secret or credential file` |
| `view_file` `<proj>\src\..\..\outside\notes.txt` | `… path is outside the project folder` |
| `view_file` on an absolute path outside the project | `… path is outside the project folder` |
| `view_file` `<proj>\config\credentials.json` | `… secret or credential file` |
| `view_file` `<proj>\.env::$DATA` | `… paths with ":" are not allowed` |
| `list_dir` `<proj>` | OK (names only) |

No file was created in the project.

### Layer 3: projects that bring their own agy code are refused

agy loads customizations from `.agents`, `.agent`, `_agents` and `_agent` folders in the working folder and its parents up to the repository root. Hooks found there were proven to run during a bridge run, on `SessionStart`, `PreInvocation` and `PostToolUse`:

- `repo/_agents/hooks.json` (in a parent folder, underscore spelling);
- `repo/app/.agent/hooks.json` (singular);
- `repo/app/.agents/plugins/<name>/hooks.json`.

Plugins can also start MCP servers.

Before starting agy, the route checks every one of those four folders in the project and **in every parent folder up to the drive root**. The user's own home folder is skipped, because folders there are the user's own agy setup (the same as agy's global config). Checking past the repository root costs only a few `stat` calls and does not depend on agy's exact stopping rule.

The route refuses (`unavailable`, naming the file, without starting agy) when any of these exists:

- `hooks.json`, `plugins/`, `plugins.json` or `mcp_config.json`;
- a `skills.json` or `agents.json` containing `inherits` or `entries`, which can pull in definitions from anywhere;
- an agent definition (`agents/<name>.md` or `agents/<name>/agent.md`) whose frontmatter has `hooks:`, `plugins:` or `mcpServers:`;
- a folder it cannot read (fails closed).

Rules, skills and plain agent definitions are allowed. They can only steer the model, which has no write, shell or MCP tool.

### Prompt rule

The prompt still tells agy not to open `.env*`, key, cert or credential files. That is now only a courtesy: the guard enforces it.

## Folder trust

Tested in a folder **outside** the user profile, so not covered by `trustedWorkspaces`. Both the project and the bridge home were placed there, with spaces in both paths; the folder was deleted afterwards.

- agy ran headless **without prompting and without refusing**. The `--add-dir` agent and its guard hook both loaded: the guard denied `.env` and allowed a source file. The answer cited the right file and line.
- agy did **not** add the folder to `trustedWorkspaces`.
- So the bridge never needs a project folder to be trusted, and users should **not** trust project folders for the bridge. Trusting a folder only matters for the user's own interactive agy sessions.

## Side effects on the user's agy setup

- **History.** Each handoff is a normal agy conversation. It appears in the user's agy conversation history and uses their AI Pro quota.
- **Global MCP servers.** agy starts the user's global MCP servers and installed plugins for the session, as it does for any session; the review observed a plugin MCP server being started. The agent cannot call MCP tools (`inheritMcp: false`, and the guard denies `call_mcp_tool`), but those servers' own start-up code runs.
- **Global and plugin hooks.** Hooks from the user's global or plugin `hooks.json` also run, as they do in the user's own sessions. The bridge refuses only project-supplied ones.

## Errors and exit codes

| Situation | Observed? | Output | Exit |
|---|---|---|---|
| Unknown flag | observed | stderr `flags provided but not defined: -<flag>` + usage | `2` |
| Unknown `--model` | observed | JSON `status:"ERROR"`, `error:"invalid model selection (--model \"…\" …): model … is not recognized …"` | `1` |
| Unknown `--agent` | observed | JSON `status:"ERROR"`, `error:"unknown agent \"…\" (available: …)"` | `1` |
| Tool soft-denied in headless | observed | stderr `… required the "<perm>" permission that headless mode cannot prompt for, so it was auto-denied …`; `denied_actions` in JSON; may end with an empty `response` | `0` |
| Tool denied by the guard | observed | the tool step fails with `tool call denied by pre-tool hook: Blocked by Claude Model Bridge: …`; the model reports it and carries on | `0` |
| Model/agent API failure mid-turn | documented, not observed | stderr `AGY_ERROR: {…}` with canonical status, HTTP/gRPC code, retryability and error id | `3` |
| Quota exhausted | documented, not observed | `Your AI credits balance is too low to continue.`; daily/billing caps stop immediately (expect `RESOURCE_EXHAUSTED` / 429 in `AGY_ERROR`) | non-zero (expect `3`) |
| Signed out | documented, not observed | "authentication required" error instead of hanging; `Authentication expired. Please log back in.`; `You are not logged into …` | non-zero |

- `agy -p "/usage"`, `/model`, `/permissions` and `/config` with `--output-format json` use no quota.
- The signed-out case was not forced, because that would sign the owner out.

## Sign-in and quota (spec §7.3)

- Sign-in works with a Google AI Pro account and is cached by agy itself. The bridge never reads agy's or Google's credential files.
- The default model on this account was Gemini 4 Argon (Medium).
- About 15 small print-mode calls across spike and review used a few percent of the five-hour Gemini bucket.
