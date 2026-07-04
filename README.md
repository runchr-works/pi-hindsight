# pi-hindsight 🧠

Self-learning extension for [Pi coding agent](https://github.com/badlogic/pi-mono).

Inspired by Hermes Agent's self-improvement loop. After each session, forks
Pi in the background to review what happened and save patterns. Injects relevant
patterns before each task so Pi gets better the more you use it.

## How it works

```
You: pi "Refactor the auth module"
  ->
  +-- [before_agent_start] Hindsight injects relevant patterns from MEMORY.md + USER.md
  +-- Agent works on task, can call learn_pattern / recall tools
  +-- [agent_end] Forked Pi reviews session in background (user sees nothing)
        -> Calls learn_pattern if it finds something worth remembering
        -> Patterns saved to ~/.pi/agent/extensions/hindsight/MEMORY.md
        -> User preferences saved to USER.md
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

Two-tier memory matching Hermes Agent:

| File | Purpose | Managed by |
|------|---------|-----------|
| `MEMORY.md` | LLM-learned patterns (confidence varies) | Auto-reflection, learn_pattern tool |
| `USER.md` | User-stated preferences (confidence 1.0, permanent) | /hindsight prefer command |

Files are plain markdown with § (paragraph-mark) delimited entries, editable with any editor:

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

## Tools (agent-callable)

| Tool | Description |
|------|-------------|
| `learn_pattern` | Save a pattern the agent discovered during work. Use type=preference for user preferences |
| `recall` | Query past patterns relevant to current task |

## Commands

| Command | Description |
|---------|-------------|
| `/hindsight` | List all patterns (USER.md entries shown with [USER] badge) |
| `/hindsight stats` | Pattern statistics by type + file counts |
| `/hindsight path` | Show MEMORY.md and USER.md locations |
| `/hindsight clear` | Clear MEMORY.md only (USER.md left intact) |
| `/hindsight prefer <text>` | Save a user preference to USER.md |
| `/hindsight config` | Show current reflection config |
| `/hindsight config set-provider <name>` | Set provider for reflection (e.g. openai) |
| `/hindsight config set-model <model>` | Set model for reflection (e.g. gpt-4o-mini) |
| `/hindsight config toggle` | Enable/disable auto-reflection |
| `/forget <id-or-number>` | Remove a specific pattern from either file |

## Architecture vs Hermes Agent

```
Hermes Agent                    pi-hindsight
===============                 =====================
background_review.py     ->     pi.exec("pi -p reflection --no-builtin-tools")
(fork agent + daemon)           (fork Pi in non-interactive mode)
MEMORY.md + USER.md      ->     MEMORY.md + USER.md (markdown)
learn_prompt.py          ->     learn_pattern tool (agent-initiated)
build_system_prompt()    ->     before_agent_start systemPrompt injection
```

## Key differences from v0.1

- JSON storage -> Markdown MEMORY.md + USER.md (human-readable, git-friendly)
- Heuristic if/else learning -> LLM-powered reflection via forked Pi
- Visible sendUserMessage -> Invisible pi.exec() background fork
- No tool support -> learn_pattern / recall tools for agent
- No config -> Configurable provider/model for reflection

## License

MIT
