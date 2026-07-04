import type {
  ExtensionAPI, AgentMessage,
  BeforeAgentStartEvent, BeforeAgentStartEventResult,
  AgentEndEvent, TurnEndEvent,
} from "./pi-api.js";
import {
  loadAll, saveAll, addEntry, queryRelevant,
  formatAsPrompt, getStats,
} from "./memory.js";
import { loadConfig, saveConfig, buildProviderArgs } from "./config.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sessionMessages: string[] = [];
let config: Awaited<ReturnType<typeof loadConfig>> | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeMessages(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "Tool";
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}] ${c.slice(0, 500)}`;
    })
    .join("\n\n");
}

function buildReflectionPrompt(summary: string): string {
  return `You are a self-improvement reviewer. Analyze the following conversation turn.

${summary}

Review criteria:
- Was there an effective strategy or workflow worth remembering?
- Was there a mistake or anti-pattern to avoid?
- Is there a user preference to record?
- Was there a recurring error pattern?

If you find something worth remembering, call the \`learn_pattern\` tool to save it.
Be selective \u2014 only save high-value, reusable patterns.
If nothing is worth remembering, do nothing.`;
}

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

export function setupHandlers(pi: ExtensionAPI): void {
  // Load config
  loadConfig().then((c) => { config = c; });

  // ─── Skip flag: if PI_HINDSIGHT_SKIP is set, don't register handlers ───
  const skipEnv = process.env.PI_HINDSIGHT_SKIP_REFLECTION;
  if (skipEnv === "1" || skipEnv === "true") {
    return;
  }

  // ─── Session start ───
  pi.on("session_start", async () => {
    sessionMessages = [];
  });

  // ─── Before agent start: inject hindsight context ───
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | undefined> => {
    if (!config?.autoReflect) return undefined;
    sessionMessages = [];
    const relevant = await queryRelevant(event.prompt.slice(0, 300), config?.minConfidence ?? 0.3);
    if (relevant.length === 0) return undefined;
    return { systemPrompt: event.systemPrompt + formatAsPrompt(relevant) };
  });

  // ─── Turn end: accumulate ───
  pi.on("turn_end", async (event: TurnEndEvent) => {
    const c = typeof event.message.content === "string"
      ? event.message.content
      : JSON.stringify(event.message.content);
    sessionMessages.push(`[${event.message.role}] ${c.slice(0, 1000)}`);
  });

  // ─── Agent end: background reflection via forked Pi ───
  pi.on("agent_end", async (event: AgentEndEvent) => {
    if (!config?.autoReflect) return;
    if (sessionMessages.length === 0) {
      sessionMessages = [summarizeMessages(event.messages)];
    }

    const reflectionPrompt = buildReflectionPrompt(sessionMessages.join("\n---\n"));

    // Fork Pi in non-interactive mode (invisible to user)
    const piArgs = [
      "-p", reflectionPrompt,
      "--no-tools", // prevent any side effects except learn_pattern
    ];

    // Add user-configured provider/model
    if (config) {
      piArgs.push(...buildProviderArgs(config));
    }

    try {
      const env = {
        ...process.env as Record<string, string>,
        PI_HINDSIGHT_SKIP_REFLECTION: "1",
      };

      const result = await pi.exec("pi", piArgs, { env });

      if (result.exitCode === 0 && result.stdout.trim()) {
        // Forked Pi may have called learn_pattern -> MEMORY.md already updated
        // Or output contains a pattern we should parse
        const output = result.stdout.trim();
        if (output.length > 10 && !output.includes("learn_pattern")) {
          // Try to parse as direct learning signal
          try {
            const parsed = JSON.parse(output);
            if (parsed.pattern) {
              await addEntry({
                id: `hint_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                type: parsed.pattern.type ?? "effective-strategy",
                summary: parsed.pattern.summary?.slice(0, 120) ?? output.slice(0, 120),
                body: parsed.pattern.detail ?? output,
                tags: parsed.pattern.tags ?? [],
                confidence: 0.6,
                successCount: 1, failCount: 0, context: "",
                createdAt: new Date().toISOString(), lastApplied: null,
                source: "auto-reflection",
              });
            }
          } catch {
            // Not JSON - pattern was likely saved via learn_pattern tool
          }
        }
      }
    } catch {
      // Reflection failed silently - not critical
    }
  });

  // ─── Register /hindsight commands ───
  pi.registerCommand("hindsight", {
    description: "Manage hindsight: /hindsight [list|stats|clear|path|config]",
    handler: async (ctx) => {
      const args = (ctx.args ?? "").trim().split(/\s+/);
      const cmd = args[0] ?? "list";

      if (cmd === "stats") {
        const stats = await getStats();
        const lines = Object.entries(stats.byType).map(([t, c]) => `  ${t}: ${c}`).join("\n");
        pi.sendMessage({
          customType: "hindsight",
          content: `MEMORY.md Stats\nEntries: ${stats.total}\nAvg confidence: ${(stats.avgConfidence * 100).toFixed(0)}%\n\n${lines}`,
          display: "stats",
        });
      } else if (cmd === "clear") {
        await saveAll([]);
        pi.sendMessage({ customType: "hindsight", content: "MEMORY.md cleared.", display: "clear" });
      } else if (cmd === "path") {
        const { homedir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
        pi.sendMessage({ customType: "hindsight", content: `${dir}/extensions/hindsight/MEMORY.md`, display: "path" });
      } else if (cmd === "config") {
        const sub = args[1];
        if (sub === "set-provider" && args[2]) {
          if (!config) config = await loadConfig();
          config.provider = args[2];
          await saveConfig(config);
          pi.sendMessage({ customType: "hindsight", content: `Reflection provider set to: ${args[2]}`, display: "config" });
        } else if (sub === "set-model" && args[2]) {
          if (!config) config = await loadConfig();
          config.model = args[2];
          await saveConfig(config);
          pi.sendMessage({ customType: "hindsight", content: `Reflection model set to: ${args[2]}`, display: "config" });
        } else if (sub === "toggle") {
          if (!config) config = await loadConfig();
          config.autoReflect = !config.autoReflect;
          await saveConfig(config);
          pi.sendMessage({ customType: "hindsight", content: `Auto-reflection: ${config.autoReflect ? "ON" : "OFF"}`, display: "config" });
        } else {
          if (!config) config = await loadConfig();
          const prov = config.provider ?? "(Pi default)";
          const mod = config.model ?? "(Pi default)";
          pi.sendMessage({
            customType: "hindsight",
            content: `Hindsight Config\nProvider: ${prov}\nModel: ${mod}\nAuto-reflect: ${config.autoReflect}\n\nCommands:\n  /hindsight config set-provider <name>\n  /hindsight config set-model <model>\n  /hindsight config toggle`,
            display: "config",
          });
        }
      } else {
        // Default: list
        const entries = await loadAll();
        if (entries.length === 0) {
          pi.sendMessage({
            customType: "hindsight",
            content: "MEMORY.md is empty. Patterns are learned automatically via forked Pi reflection.\n\nCommands: /hindsight stats, /hindsight path, /hindsight config",
            display: "list",
          });
          return;
        }
        const lines = entries.slice(0, 15).map((e, i) =>
          `${i + 1}. [${(e.confidence * 100).toFixed(0)}%] ${e.type}: ${(e.body.split("\n")[0] ?? "").slice(0, 80)}`,
        );
        pi.sendMessage({
          customType: "hindsight",
          content: `MEMORY.md (${entries.length} total)\n\n${lines.join("\n")}\n\n/hindsight stats | /hindsight config | /hindsight path | /hindsight clear`,
          display: "list",
        });
      }
    },
  });

  // ─── Register /forget command ───
  pi.registerCommand("forget", {
    description: "Remove a pattern by ID or number. /forget <id|#>",
    handler: async (ctx) => {
      const target = (ctx.args ?? "").trim();
      if (!target) {
        pi.sendMessage({ customType: "hindsight", content: "Usage: /forget <id> or /forget <#>", display: "help" });
        return;
      }
      const entries = await loadAll();
      const byId = entries.find((e) => e.id === target);
      if (byId) {
        await saveAll(entries.filter((e) => e.id !== target));
        pi.sendMessage({ customType: "hindsight", content: `Forgotten: "${byId.summary.slice(0, 60)}"`, display: "forget" });
        return;
      }
      const num = parseInt(target, 10);
      if (!isNaN(num) && num > 0 && num <= entries.length) {
        const e = entries[num - 1]!;
        await saveAll(entries.filter((x) => x.id !== e.id));
        pi.sendMessage({ customType: "hindsight", content: `Forgotten: "${e.summary.slice(0, 60)}"`, display: "forget" });
        return;
      }
      pi.sendMessage({ customType: "hindsight", content: `Not found: "${target}"`, display: "error" });
    },
  });
}
