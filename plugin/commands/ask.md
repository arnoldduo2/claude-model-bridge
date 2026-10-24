---
description: Force a handoff of a question to a free model through the model bridge
argument-hint: "[agy|gemini|openrouter] <question>"
---

Hand this question to the free-model bridge: $ARGUMENTS

1. If the first word of the arguments is `agy`, `gemini` or `openrouter`, it picks the route and the rest is the question. Map `agy` to route `antigravity`; use the other two as written. Otherwise use route `auto` and treat all the arguments as the question. If the requested route cannot be used (for example `agy` is not installed), the bridge falls back to the next route and the footer says so.
2. If the question is empty, ask the user for one and stop.
3. Call the `ask_model` tool from the `model-bridge` MCP server with `question` (make it self-contained and ask for a short answer with `path:line` citations), `route`, `task` set to the best fit of `explore`, `plan`, `review` or `ask`, and `cwd` set to the absolute path of the current project folder.
4. Relay the answer concisely and name the route that produced it (shown in the footer). If the footer says the requested route was not available or not configured, tell the user which route answered instead. If the tool returns an error, say so in one line and do the work yourself unless the user says otherwise.
