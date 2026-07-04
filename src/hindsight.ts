import type {
  ExtensionAPI, AgentMessage,
  BeforeAgentStartEvent, BeforeAgentStartEventResult,
  AgentEndEvent, TurnEndEvent,
} from "./pi-api.js";
import {
  loadAll, saveMemoryEntry, queryRelevant,
  formatAsPrompt, getStats,
  getUserPath, deleteEntry, MemoryEntry,
} from "./memory.js";
import { loadConfig, saveConfig, buildProviderArgs } from "./config.js";

let sessionMessages: string[] = [];
let config: Awaited<ReturnType<typeof loadConfig>> | null = null;

function summarizeMessages(messages: AgentMessage[]): string {
  return messages
    .map((m) => {
      const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "Tool";
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}] ${c.slice(0, 500)}`;
    })
    .join("\n\n");
}

export function setupHandlers(pi: ExtensionAPI): void {
  loadConfig().then((c) => { config = c; });

  if (process.env.PI_HINDSIGHT_SKIP_REFLECTION === "1") return;

  pi.on("session_start", async () => { sessionMessages = []; });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | undefined> => {
    if (config?.autoReflect === false) return undefined;
    sessionMessages = [];
    const relevant = await queryRelevant(event.prompt.slice(0, 300), config?.minConfidence ?? 0.3);
    if (relevant.length === 0) return undefined;
    return { systemPrompt: event.systemPrompt + formatAsPrompt(relevant) };
  });

  pi.on("turn_end", async (event: TurnEndEvent) => {
    const c = typeof event.message.content === "string" ? event.message.content : JSON.stringify(event.message.content);
    sessionMessages.push(`[${event.message.role}] ${c.slice(0, 1000)}`);
  });

  pi.on("agent_end", async (event: AgentEndEvent) => {
    if (config?.autoReflect === false) return;
    if (sessionMessages.length === 0) sessionMessages = [summarizeMessages(event.messages)];

    const reflectionPrompt = `You are a self-improvement reviewer. Analyze the following conversation turn.\n\n${sessionMessages.join("\n---\n")}\n\nReview criteria:\n- Effective strategy or workflow worth remembering? -> call learn_pattern\n- Mistake or anti-pattern to avoid? -> call learn_pattern\n- User stated a clear preference? -> call learn_pattern with type=preference\n- Nothing notable? -> do nothing\n\nBe selective. Only save high-value, reusable patterns.`;

    const piArgs = ["-p", reflectionPrompt, "--no-builtin-tools"];
    if (config) piArgs.push(...buildProviderArgs(config));

    try {
      await pi.exec("pi", piArgs, {
        env: { ...process.env as any, PI_HINDSIGHT_SKIP_REFLECTION: "1" },
      });
    } catch {
      // reflection failed silently
    }
  });

  // ─── Register learn_pattern tool ───
  pi.registerTool({
    name: "learn_pattern",
    description: "Save a reusable pattern learned from this session",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One-line summary (max 120 chars)" },
        type: { type: "string", enum: ["effective-strategy", "anti-pattern", "preference", "common-error", "workflow"], description: "Category" },
        detail: { type: "string", description: "Detailed description" },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
      },
      required: ["summary", "type", "detail"],
    },
    execute: async (input: any) => {
      await saveMemoryEntry({
        id: `hint_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: input.type ?? "effective-strategy",
        summary: (input.summary ?? "").slice(0, 120),
        body: `${input.summary ?? ""}\n\n${input.detail ?? ""}`,
        tags: input.tags ?? [],
        confidence: input.type === "preference" ? 1.0 : 0.6,
        successCount: 1, failCount: 0, context: "",
        createdAt: new Date().toISOString(),
        lastApplied: new Date().toISOString(),
        source: "agent",
        userStated: input.type === "preference",
      });
      return `Learned: ${(input.summary ?? "").slice(0, 60)}`;
    },
  });

  // ─── Register recall tool ───
  pi.registerTool({
    name: "recall",
    description: "Query past learned patterns relevant to current task",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for" },
        maxResults: { type: "number", description: "Max results (default 3)" },
      },
      required: ["query"],
    },
    execute: async (input: any) => {
      const relevant = await queryRelevant(input.query ?? "");
      if (relevant.length === 0) return "No relevant patterns found.";
      return relevant.slice(0, input.maxResults ?? 3).map((e, i) => {
        const badge = e.userStated ? "[USER]" : `[${(e.confidence * 100).toFixed(0)}%]`;
        const first = e.body.split("\n")[0] ?? "";
        return `${i + 1}. ${badge} ${first}`;
      }).join("\n");
    },
  });

  // ─── /hindsight commands ───
  pi.registerCommand("hindsight", {
    description: "Manage hindsight: /hindsight [list|stats|clear|path|config|prefer]",
    handler: async (ctx) => {
      const args = (ctx.args ?? "").trim().split(/\s+/);
      const cmd = args[0] ?? "list";

      if (cmd === "stats") {
        const s = await getStats();
        const lines = Object.entries(s.byType).map(([t, c]) => `  ${t}: ${c}`).join("\n");
        pi.sendMessage({
          customType: "hindsight",
          content: `Hindsight Stats\nMEMORY.md: ${s.memoryCount} entries\nUSER.md: ${s.userCount} entries\nTotal: ${s.total}\nAvg confidence: ${(s.avgConfidence * 100).toFixed(0)}%\n\n${lines}`,
          display: "stats",
        });
      } else if (cmd === "clear") {
        const { memory, user } = await loadAll();
        if (memory.length > 0) {
          const { getMemoryPath } = await import("./memory.js");
          const { writeFile } = await import("node:fs/promises");
          await writeFile(getMemoryPath(), "", "utf-8");
        }
        pi.sendMessage({ customType: "hindsight", content: "MEMORY.md cleared. USER.md left intact.", display: "clear" });
      } else if (cmd === "path") {
        const mpath = getUserPath().replace(/USER\.md$/, "MEMORY.md");
        pi.sendMessage({ customType: "hindsight", content: `MEMORY.md: ${mpath}\nUSER.md: ${getUserPath()}`, display: "path" });
      } else if (cmd === "prefer") {
        const rest = args.slice(1).join(" ").trim();
        if (!rest) {
          pi.sendMessage({ customType: "hindsight", content: "Usage: /hindsight prefer <your preference>\nExample: /hindsight prefer Always use nvm use 20 before npm install", display: "prefer" });
          return;
        }
        const { addUserPreference } = await import("./memory.js");
        await addUserPreference(rest, ["user-preference"]);
        pi.sendMessage({ customType: "hindsight", content: `Saved to USER.md: "${rest.slice(0, 120)}"`, display: "prefer" });
      } else if (cmd === "config") {
        const sub = args[1];
        if (!config) config = await loadConfig();
        if (sub === "set-provider" && args[2]) {
          config.provider = args[2];
          await saveConfig(config);
          pi.sendMessage({ customType: "hindsight", content: `Reflection provider: ${args[2]}`, display: "config" });
        } else if (sub === "set-model" && args[2]) {
          config.model = args[2];
          await saveConfig(config);
          pi.sendMessage({ customType: "hindsight", content: `Reflection model: ${args[2]}`, display: "config" });
        } else if (sub === "toggle") {
          config.autoReflect = !config.autoReflect;
          await saveConfig(config);
          pi.sendMessage({ customType: "hindsight", content: `Auto-reflection: ${config.autoReflect ? "ON" : "OFF"}`, display: "config" });
        } else {
          const prov = config.provider ?? "(Pi default)";
          const mod = config.model ?? "(Pi default)";
          pi.sendMessage({
            customType: "hindsight",
            content: `Hindsight Config\nProvider: ${prov}\nModel: ${mod}\nAuto-reflect: ${config.autoReflect}\n\n/hindsight config set-provider <name>\n/hindsight config set-model <model>\n/hindsight config toggle`,
            display: "config",
          });
        }
      } else {
        // list
        const { all } = await loadAll();
        if (all.length === 0) {
          pi.sendMessage({
            customType: "hindsight",
            content: "MEMORY.md / USER.md are empty.\n\nCommands: /hindsight stats, /hindsight path, /hindsight config, /hindsight prefer <text>",
            display: "list",
          });
          return;
        }
        const lines = all.slice(0, 15).map((e, i) => {
          const badge = e.userStated ? "[USER]" : `[${(e.confidence * 100).toFixed(0)}%]`;
          const first = (e.body.split("\n")[0] ?? "").slice(0, 70);
          return `${i + 1}. ${badge} ${first}`;
        });
        pi.sendMessage({
          customType: "hindsight",
          content: `Hindsight (${all.length} total: ${all.filter((e) => e.userStated).length} user, ${all.filter((e) => !e.userStated).length} learned)\n\n${lines.join("\n")}`,
          display: "list",
        });
      }
    },
  });

  // ─── /forget command ───
  pi.registerCommand("forget", {
    description: "Remove a pattern by ID or number: /forget <id|#>",
    handler: async (ctx) => {
      const target = (ctx.args ?? "").trim();
      if (!target) {
        pi.sendMessage({ customType: "hindsight", content: "Usage: /forget <id> or /forget <#>", display: "help" });
        return;
      }
      const { all } = await loadAll();
      const byId = all.find((e) => e.id === target);
      if (byId) {
        await deleteEntry(target);
        pi.sendMessage({ customType: "hindsight", content: `Forgotten: "${byId.summary.slice(0, 60)}"`, display: "forget" });
        return;
      }
      const num = parseInt(target, 10);
      if (!isNaN(num) && num > 0 && num <= all.length) {
        const e = all[num - 1]!;
        await deleteEntry(e.id);
        pi.sendMessage({ customType: "hindsight", content: `Forgotten: "${e.summary.slice(0, 60)}"`, display: "forget" });
        return;
      }
      pi.sendMessage({ customType: "hindsight", content: `Not found: "${target}"`, display: "error" });
    },
  });
}
