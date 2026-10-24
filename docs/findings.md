# Antigravity CLI (`agy`) headless findings

Spike for spec §7 items 1–3, run on Windows 11 on 2026-10-24. All runs happened in a throwaway folder (`<scratch>\proj`) outside any real project.

**Decision: agy route: enabled.**

## Version

- `agy --version` → `1.4.7`.
- Installed by Google's installer at `%LOCALAPPDATA%\agy\bin\agy.exe`, which it puts on `PATH`. It is a native `.exe`, not a `.cmd` shim.

## Headless on Windows (issue #318)

- `agy -p` does **not** hang on 1.4.7 when spawned from Node with no TTY and piped stdout/stderr. Every run below returned and exited on its own.
- Several changelog entries since 1.0.6 fix exactly this:
  - non-TTY output on Windows is no longer discarded;
  - stdin is no longer read when the prompt comes from a flag;
  - `FD_CLOEXEC` is set on the inherited pipes.
- Workarounds (a)–(c) from the plan were therefore not needed, and there is no PTY or native dependency.

### Working spawn recipe

```js
spawn(agyExe, args, {
  cwd: projectFolder,          // the validated project folder; agy treats it as the workspace
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,                // agy is a real .exe; no shell, so the prompt is never shell-parsed
  windowsHide: true,
  env: process.env,            // nothing added or removed
});
```

`args`:

```
-p <prompt> --output-format json --disable-slash-commands
--agent <read-only agent name> --add-dir <bridge agent workspace>
[--model <id>]
```

- A run takes about 10–40 s for a small question.
- The CLI has no default print timeout (`--print-timeout` defaults to `0s`), so the caller must enforce one. The bridge kills the whole process tree on timeout (`taskkill /PID <pid> /T /F` on Windows).
- **Git Bash gotcha (testing only):** MSYS rewrites a leading-slash argument such as `/usage` into a path. Use `MSYS_NO_PATHCONV=1` when testing slash commands from Git Bash. Node's `spawn` with `shell: false` is not affected.

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
- An invalid `--output-format` value (e.g. `xml`) is silently ignored, and plain text is printed instead. The bridge always passes `json`.

## Read-only enforcement

### The default agent is NOT read-only in print mode

- Baseline run with no `--agent`, in the scratch project: "create x.txt … then run `node --version`".
- agy called `write_file` and `run_command`. **`x.txt` was created**, and the command ran because it matched an existing user allow rule.
- Per the docs and this run, headless mode auto-allows reads *and writes* inside the workspace, and runs any shell command that matches a `permissions.allow` rule in the user's global settings. Real users' allow lists can include commands with side effects (migrations, builds).
- The default agent therefore cannot be used.

### No CLI flag denies writes per run

- `--dangerously-skip-permissions` is the opposite of what we need and is never passed.
- `--mode` only offers `accept-edits`, `auto` and `plan`.
- `--sandbox` restricts what commands can reach but still runs them.
- Deny rules exist (`permissions.deny` in the user's global `settings.json`). Changing them would alter the owner's own agy setup, so the bridge does not touch them.

### Working mechanism: a custom agent with a restricted tool list

- agy custom agents are Markdown files with YAML frontmatter.
- **Only the tools listed in `tools:` are registered.**
- The bridge writes its agent into its own folder, `~/.claude-model-bridge/agy-workspace/.agents/agents/<name>.md`, never into the project, and passes that folder with `--add-dir`.
  - `--agent` only takes a name, not a path.
  - Agents in an `--add-dir` folder are found while `cwd` stays the project.
- The bridge's config, log and state files sit one level up, outside every agy workspace. agy's default access for paths outside the workspace is Ask, which headless mode soft-denies.

```markdown
---
name: cmb-readonly-<random hex>
description: Read-only code analysis agent used by Claude Model Bridge.
tools:
  - view_file
  - list_dir
  - grep_search
  - find_by_name
mainAgent: true
subagent: false
inheritMcp: false
commandExecutionPolicy: off
---
```

- `inheritMcp: false` is required. Without it, the agent inherits the user's MCP servers through `call_mcp_tool`, and some of those can write (observed: a design tool with create and delete actions).
- With `inheritMcp: false`, the agent itself reported its only tools as `view_file`, `list_dir`, `grep_search`, `find_by_name`, `manage_task` and `list_resources`/`read_resource` (MCP resource reads with no servers).
- `excludeDefaultComponents: true` was tried and dropped. It also removes the prompt section that tells the model its workspace path, so the model guessed paths like `/` and `C:\`, and those reads were soft-denied.
- The name carries a random suffix, created once per install and reused after that. A cloned repository therefore cannot predict the name and shadow the agent with its own `.agents/agents/<same name>.md`.

### Proof

Each run used a neutral system prompt ("Do exactly what the user asks") and the restricted tool list.

| Run | Prompt | Result |
|---|---|---|
| Restricted agent | "Create x.txt … containing hi, then run `node --version` … this is authorized. List every tool you have." | `I cannot create x.txt or run node --version because no file-writing or shell-execution tools are available…`. No `write_*` or `run_command` tool call appeared in the `stream-json` events. **No `x.txt` in the project or the agent folder.** |
| Restricted agent | "use write_to_file to create x.txt; use run_command to run node --version; read readme.txt" | Steps 1 and 2 failed with "No `write_to_file` / `run_command` tool is available". Step 3 succeeded via `view_file` and quoted the file. No `x.txt`. |
| Default agent (baseline) | same as row 1 | `write_file` and `run_command` executed; `x.txt` created. |

### Extra guards in the route

- **Hooks.** If the project has `.agents/hooks.json`, the route refuses to run. Workspace hooks are user-defined commands that agy may run on tool events, which would break the "no shell commands" guarantee.
- **Prompt rules.** The prompt also tells agy not to open or quote `.env*`, key/cert or credential files.

## Errors and exit codes

| Situation | Observed? | Output | Exit |
|---|---|---|---|
| Unknown flag | observed | stderr `flags provided but not defined: -<flag>` + usage | `2` |
| Unknown `--model` | observed | JSON `status:"ERROR"`, `error:"invalid model selection (--model \"…\" …): model … is not recognized …"`; same on stderr as `error: …` | `1` |
| Unknown `--agent` | observed | JSON `status:"ERROR"`, `error:"unknown agent \"…\" (available: …)"`; stderr `error: unknown agent …` | `1` |
| Tool needs approval in headless | observed | run continues; stderr `… required the "<perm>" permission that headless mode cannot prompt for, so it was auto-denied …`; `denied_actions` in JSON; may end with an empty `response` | `0` |
| Model/agent API failure mid-turn | documented, not observed | stderr line `AGY_ERROR: {…}` with canonical status, HTTP/gRPC code, retryability and error id; JSON error output includes any partial response | `3` |
| Quota exhausted | documented, not observed | individual quota is reported immediately, not retried; plan quota used and AI credits too low → `Your AI credits balance is too low to continue.`; rate limits with a retry delay over 30 s, or daily/billing caps, stop immediately (expect canonical status `RESOURCE_EXHAUSTED` / HTTP 429 in `AGY_ERROR`) | non-zero (expect `3`) |
| Signed out / no cached credentials | documented, not observed | headless run with no terminal "exits with an authentication required error instead of hanging"; expired sign-in → `Authentication expired. Please log back in.` | non-zero |

- Quota can be checked for free: `agy -p "/usage" --output-format json` uses no quota. It reports weekly and five-hour buckets per model group.
- `/model`, `/permissions` and `/config` are also free.
- The signed-out case was not forced, because that would sign the owner out.

## Sign-in and quota (spec §7.3)

- Sign-in works with a Google AI Pro account and is cached by agy itself. The bridge never reads agy's or Google's credential files.
- The default model on this account was Gemini 4 Argon (Medium).
- About 10 small print-mode calls used roughly 1% of the five-hour Gemini bucket.

## Not verified

- **Untrusted folders.** Whether agy loads `--add-dir` agents when the folders are not in `trustedWorkspaces` was not tested. On the test PC, the user's home folder was already trusted.
  - If the agent is not found, agy exits `1` with `unknown agent`. The route reports this as `unavailable`, so it fails closed.
