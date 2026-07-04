# pi-hindsight 🧠

Self-learning extension for [Pi coding agent](https://github.com/badlogic/pi-mono).

**Inspired by Hermes Agent's self-improvement loop.** After every turn, forks Pi
in the background to review what happened and save patterns. Injects relevant
patterns before each task so Pi gets better the more you use it.

## Quick demo

```
$ pi "Refactor this React component to use hooks"
  -> Pi works on the task normally
     (after turn ends, forked Pi reviews in background)
  
$ pi "Refactor this other component too"
  -> [before_agent_start] Hindsight injects:
       "[80%] Completed refactoring task by running tests first"
     Pi sees past learnings and applies them automatically

$ /hindsight  (check what's been learned)
  -> Hindsight (3 total: 0 user, 3 learned)
     1. [80%] Completed refactoring task by running tests first
     2. [70%] Used useEffect cleanup to prevent memory leaks
     3. [60%] Caught error: TypeError: Cannot read property 'map'
```

## How it works

```
You: pi "Refactor the auth module"
  ->
  +-- [before_agent_start] Hindsight injects relevant patterns from MEMORY.md + USER.md
  +-- Agent works on task, can call learn_pattern / recall tools
  +-- [turn_end] Forked Pi reviews each turn in background (user sees nothing)
        -> Calls learn_pattern if it finds something worth remembering
        -> Patterns saved to ~/.pi/agent/extensions/hindsight/MEMORY.md
        -> User preferences saved to USER.md
  +-- [agent_end] Final review to catch anything missed
        -> Shows notification: "💾 Self-improvement review: Learned: ..."
```

## Installation

### Requirements
- Node.js 18+
- Pi coding agent v0.48+ (npm: `@earendil-works/pi-coding-agent`)

### Install

```bash
# From GitHub (recommended)
pi install git:github.com/runchr-works/pi-hindsight

# From local checkout
cd pi-hindsight
npm install && npm run build
pi install /path/to/pi-hindsight
```

### Verify

```bash
pi -e pi-hindsight --version  # should show no errors
/hindsight                      # should show "No patterns yet"
```

### Uninstall

```bash
pi remove pi-hindsight
# Or if installed from git:
pi remove git:github.com/runchr-works/pi-hindsight
```

## Storage

Two-tier memory matching Hermes Agent:

| File | Purpose | Managed by |
|------|---------|-----------|
| `MEMORY.md` | LLM-learned patterns (confidence varies) | Auto-reflection, learn_pattern tool |
| `USER.md` | User-stated preferences (confidence 1.0, permanent) | /hindsight prefer command |

Location: `~/.pi/agent/extensions/hindsight/`

Files are plain markdown with \u00a7 (paragraph-mark) delimited entries, editable with any editor:

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

These tools become available to Pi when hindsight is installed. The agent can
call them during a session to explicitly learn or recall patterns.

| Tool | Description |
|------|-------------|
| `learn_pattern` | Save a pattern the agent discovered during work. Use type=preference for user preferences (routes to USER.md) |
| `recall` | Query past patterns relevant to current task |

## Commands

| Command | Description |
|---------|-------------|
| `/hindsight` | List all patterns ([USER] badge for user preferences) |
| `/hindsight stats` | Pattern statistics by type + file counts |
| `/hindsight path` | Show MEMORY.md and USER.md file paths |
| `/hindsight clear` | Clear MEMORY.md only (USER.md left intact) |
| `/hindsight prefer <text>` | Save a direct user preference to USER.md |
| `/hindsight config` | Show current reflection config |
| `/hindsight config set-provider <name>` | Set provider for reflection |
| `/hindsight config set-model <model>` | Set model for reflection |
| `/hindsight config toggle` | Enable/disable auto-reflection |
| `/forget <id-or-number>` | Remove a specific pattern from either file |

## Configuration

### Reflection provider/model

By default, the background reflection uses the same provider/model as your
current Pi session. You can set a different (cheaper) model to reduce cost:

```
/hindsight config set-provider openai
/hindsight config set-model gpt-4o-mini
/hindsight config set-model anthropic/claude-3-haiku
```

Config is stored at `~/.pi/agent/extensions/hindsight/config.json`:

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "autoReflect": true,
  "minConfidence": 0.3
}
```

### Disable auto-reflection

If you want to use the tools (`learn_pattern`, `recall`) manually without
automatic background review:

```
/hindsight config toggle
```

## Cost considerations

Each turn triggers a background `pi.exec()` call for reflection. This means:
- One extra LLM call per turn (trivial turns like "ok" are skipped)
- The forked Pi uses `--no-builtin-tools` so only `learn_pattern`/`recall` are available
- Recommended: set a cheap model for reflection (`gpt-4o-mini`, `claude-3-haiku`)
- Reflection adds ~1-3 seconds per turn (fork + LLM call)

## Privacy

- All patterns are stored **locally** at `~/.pi/agent/extensions/hindsight/`
- No data is sent anywhere except to the LLM provider you already use for Pi
- The reflection fork uses your existing Pi provider and API key
- You can inspect and delete all patterns at any time

## Architecture vs Hermes Agent

```
Hermes Agent                    pi-hindsight
===============                 =====================
background_review.py     ->     pi.exec("pi -p reflection --no-builtin-tools")
(fork agent + daemon)           (fork Pi in non-interactive mode)
MEMORY.md + USER.md      ->     MEMORY.md + USER.md (\u00a7 markdown)
learn_prompt.py          ->     learn_pattern tool (agent-initiated)
build_system_prompt()    ->     before_agent_start systemPrompt injection
```

## Key differences from v0.1

- JSON storage -> Markdown MEMORY.md + USER.md (human-readable, git-friendly)
- Heuristic if/else learning -> LLM-powered reflection via forked Pi
- Session-end only review -> Per-turn review (Hermes-style)
- Truncated context -> Full conversation context
- Cold cache -> System prompt prefix reused for warm cache
- Visible sendUserMessage -> Invisible pi.exec() background fork
- No tool support -> learn_pattern / recall tools for agent
- No config -> Configurable provider/model for reflection

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Patterns not being learned | Check `/hindsight config` and verify autoReflect is ON |
| Reflection feels slow | Set a cheaper model with `/hindsight config set-model` |
| "Command not found" | Verify Pi version: `pi --version` (needs v0.48+) |
| MEMORY.md not found | First session will create it automatically |

## License

MIT
