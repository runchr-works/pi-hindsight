# pi-hindsight \ud83e\udde0

Self-learning extension for [Pi coding agent](https://github.com/badlogic/pi-mono).

**Inspired by Hermes Agent's self-improvement loop.** After each session, forks
Pi in the background to review what happened and save patterns. Injects relevant
patterns before each task so Pi gets better the more you use it.

## How it works

```
You: pi \"Refactor the auth module\"
  \u2192
  \u251c [before_agent_start] Hindsight injects relevant patterns from MEMORY.md
  \u251c Agent works on task, can call learn_pattern / recall tools
  \u2514 [agent_end] Forked Pi reviews session in background (user sees nothing)
        \u2192 Calls learn_pattern if it finds something worth remembering
        \u2192 Patterns saved to ~/.pi/agent/extensions/hindsight/MEMORY.md
```

The background fork uses Pi's own provider and model configuration. You can
set a specific provider/model for reflection (cheaper model recommended):

```
/hindsight config set-provider openai
/hindsight config set-model gpt-4o-mini
```

## Installation

```bash
cd pi-hindsight
npm install && npm run build
pi install /path/to/pi-hindsight
```

## Storage

Patterns stored in **markdown format** at:
```
~/.pi/agent/extensions/hindsight/MEMORY.md
```

Each entry is a \u00a7-delimited chunk. Editable with any text editor:
```
\u00a7 hint_abc123
type: effective-strategy
confidence: 0.8
tags: [refactoring, testing]
created: 2026-07-05T00:30:00Z
source: Refactored auth module
---
Run tests first, then refactor, then verify with tests again.
```

## Tools (agent-callable)

| Tool | Description |
|------|-------------|
| \`learn_pattern\` | Save a pattern the agent discovered during work |
| \`recall\` | Query past patterns relevant to current task |

## Commands

| Command | Description |
|---------|-------------|
| \`/hindsight\` | List all patterns |
| \`/hindsight stats\` | Pattern statistics by type |
| \`/hindsight path\` | Show MEMORY.md location |
| \`/hindsight clear\` | Delete all patterns |
| \`/hindsight config\` | Show reflection config |
| \`/hindsight config set-provider <name>\` | Set provider for reflection (e.g. \`openai\`) |
| \`/hindsight config set-model <model>\` | Set model for reflection (e.g. \`gpt-4o-mini\`) |
| \`/hindsight config toggle\` | Enable/disable auto-reflection |
| \`/forget <id|#>\` | Remove a specific pattern |

## Architecture vs Hermes Agent

```
Hermes Agent                    pi-hindsight
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550              \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
background_review.py     \u2192      pi.exec(\"pi -p reflection --no-builtin-tools\")
(fork agent + daemon thread)    (fork Pi in non-interactive mode)
learning_graph.py        \u2192      MEMORY.md (\u00a7-delimited markdown)
learn_prompt.py          \u2192      learn_pattern tool
MEMORY.md / USER.md      \u2192      ~/.pi/agent/extensions/hindsight/MEMORY.md
build_system_prompt()    \u2192      before_agent_start systemPrompt injection
MemoryProvider plugin    \u2192      memory.ts (markdown CRUD)
```

## Key difference from v0.1

- \u274c JSON storage \u2192 \u2705 Markdown MEMORY.md (human-readable, git-friendly)
- \u274c Heuristic if/else learning \u2192 \u2705 LLM-powered reflection via forked Pi
- \u274c Visible sendUserMessage \u2192 \u2705 Invisible pi.exec() background fork
- \u274c No tool support \u2192 \u2705 learn_pattern / recall tools for agent
- \u274c No config \u2192 \u2705 Configurable provider/model for reflection

## License

MIT
