# pi-hindsight 🧠

Self-learning extension for [Pi coding agent](https://github.com/badlogic/pi-mono).

**Inspired by Hermes Agent's self-improvement loop.** Learns from past sessions,
injects relevant lessons into future prompts, and lets the agent explicitly save
and recall knowledge during a session.

## How it works

```
You: pi "Refactor the auth module"

  → [before_agent_start] Hindsight injects relevant past patterns
     into the system prompt from MEMORY.md

  → Agent works on the task, can call:
     • learn_pattern — explicitly save what it learned
     • recall       — query past patterns during a session

  → [agent_end] Auto-reflection: agent reviews the session
     and saves any additional patterns it discovers

  → All patterns stored in ~/.pi/agent/extensions/hindsight/MEMORY.md
    (plain markdown, readable & editable with any text editor)
```

## Installation

```bash
cd pi-hindsight
npm install && npm run build
pi install /path/to/pi-hindsight
```

## Storage

Patterns are stored in **markdown format** at:
```
~/.pi/agent/extensions/hindsight/MEMORY.md
```

Each entry is a §-delimited chunk:

```
§ hint_abc123
type: effective-strategy
confidence: 0.8
tags: [refactoring, testing]
created: 2026-07-05T00:30:00Z
source: Refactored auth module
---
Run tests first, then refactor, then verify with tests again.
```

You can edit this file directly with any text editor. Changes take effect
on the next `before_agent_start` injection.

## Tools (agent-callable)

| Tool | Description |
|------|-------------|
| `learn_pattern` | Agent saves a pattern it discovered during work |
| `recall` | Agent queries past patterns relevant to current task |

## Commands

| Command | Description |
|---------|-------------|
| `/hindsight` | List all patterns |
| `/hindsight stats` | Pattern statistics by type |
| `/hindsight path` | Show MEMORY.md location |
| `/hindsight clear` | Delete all patterns |
| `/forget <id|#>` | Remove a specific pattern |

## Architecture

```
Hermes Agent                    pi-hindsight
══════════════════              ══════════════════
background_review.py     →      agent_end + sendUserMessage(reflection)
learning_graph.py        →      MEMORY.md (§-delimited markdown)
learn_prompt.py          →      learn_pattern tool
MEMORY.md / USER.md      →      ~/.pi/agent/extensions/hindsight/MEMORY.md
build_system_prompt()    →      before_agent_start → systemPrompt injection
```

## License

MIT

