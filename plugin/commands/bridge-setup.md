---
description: Check what is missing for the model bridge on this PC and print exact next steps
---

Set up the model bridge. Never ask the user to paste a key or token into this chat; keys are only ever set in their own terminal or config file. Do not run these commands yourself, and never read or print config.json contents.

1. Call the `bridge_status` tool from the `model-bridge` MCP server and show the result. If it reports a config file problem, tell the user which field to fix in the named file (or to remove the file) and stop there.
2. For each route that is not configured, print the matching steps below. Skip routes that are already configured.

**antigravity** (uses your Google AI Pro subscription via Google's official CLI, which reads the project folder itself, read-only):
- Install on Windows (PowerShell): `irm https://antigravity.google/cli/install.ps1 | iex`
- Run `agy` once in a terminal and sign in with your Google account.
- If `agy` is installed outside `PATH` (and, on Windows, outside `%LOCALAPPDATA%\agy\bin`), set `antigravity.command` in `~/.claude-model-bridge/config.json` to the full path of `agy.exe`.
- If an answer fails with `auth`, run `agy` in a terminal and sign in again. If it fails because the read-only agent was not loaded, open `agy` once in that project folder and trust it when asked.

**gemini** (Gemini API key):
- Create a key at https://aistudio.google.com/apikey
- Windows: run `setx GEMINI_API_KEY "<your key>"` in a terminal. macOS/Linux: add `export GEMINI_API_KEY="<your key>"` to your shell profile.

**openrouter** (OpenRouter, or any OpenAI-compatible endpoint such as a self-hosted router):
- Create a key at https://openrouter.ai/keys
- Windows: run `setx OPENROUTER_API_KEY "<your key>"`. macOS/Linux: `export OPENROUTER_API_KEY="<your key>"`.
- To use a different endpoint, set `openrouter.baseUrl` in `~/.claude-model-bridge/config.json` (see `config.example.json` in the plugin repo). A key is optional for endpoints that do not require one.

Keys can alternatively go in `~/.claude-model-bridge/config.json`, which lives outside every repo. Never commit it.

3. Tell the user to fully restart Claude after setting environment variables, then run `/model-bridge:bridge-status` to confirm each route shows as configured.
