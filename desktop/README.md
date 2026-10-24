# Claude Desktop package

Two artifacts for Claude Desktop (chat has no project folder, so the skill tells Claude to pass `cwd` explicitly):

- `model-bridge.mcpb`: the extension (bundled MCP server plus a settings form for the API keys)
- `model-bridge-skill.zip`: the delegation skill (`model-bridge/SKILL.md`)

## Build

```bash
npm install          # once; installs the pinned @anthropic-ai/mcpb CLI
npm run build        # only if server/src changed (refreshes plugin/server/bridge.mjs)
npm run build:desktop
```

Output goes to `desktop/dist/` (git-ignored). The version comes from `plugin/.claude-plugin/plugin.json`.

## Install in Claude Desktop

1. Open `model-bridge.mcpb` (double-click, or drag it into Settings > Extensions). Install it.
2. In the extension settings, paste a Gemini API key and/or an OpenRouter API key. Both are optional and stored as sensitive values. Leave both blank to use `~/.claude-model-bridge/config.json` instead.
3. Go to Settings > Capabilities (Skills) and upload `model-bridge-skill.zip`.
4. Start a chat and say: "ask Gemini what the file `<absolute path to some file>` does". Expect a short answer with a footer naming the route. Run `bridge_status` to check route health.

Requires Node 20 or newer available as `node` on the PC.
