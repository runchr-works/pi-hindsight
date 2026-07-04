# pi-hindsight 🧠

Self-learning extension for [Pi coding agent](https://github.com/badlogic/pi-mono).

Learns from past sessions and injects relevant lessons into future prompts — so Pi gets better the more you use it.

## How it works

```
You: pi "Refactor this module"

  → Hindsight loads past patterns from ~/.pi/agent/extensions/hindsight/patterns.json
  → Injects relevant lessons into the system prompt before each agent run
  → After each turn, analyzes results and learns what worked/didn't
  → Patterns accumulate over time → Pi improves without any manual tuning
```

## Installation

```bash
# From local checkout
cd pi-hindsight
npm install && npm run build
pi install /path/to/pi-hindsight

# Or from npm (once published)
pi install npm:pi-hindsight
```

## What it learns

| Pattern Type | Example |
|-------------|---------|
| ✅ effective-strategy | "Completed task efficiently with minimal tool calls" |
| ❌ common-error | "Caught recurring error pattern" |
| 🔄 workflow | "Completed 5-turn task without errors — reliable pattern" |

## Commands

| Command | Description |
|---------|-------------|
| `/hindsight` | List top 20 learned patterns |
| `/hindsight stats` | Show pattern statistics by type |
| `/hindsight clear` | Delete all patterns |
| `/forget <id>` | Remove a specific pattern by ID or number |

## Storage

Patterns are stored as JSON at `~/.pi/agent/extensions/hindsight/patterns.json`.
Plain text, no database, easy to inspect or delete.

## Configuration

To disable automatic injection without uninstalling:

```json
// ~/.pi/agent/settings.json
{
  "extensions": {
    "hindsight": {
      "autoInject": false
    }
  }
}
```

## License

MIT
