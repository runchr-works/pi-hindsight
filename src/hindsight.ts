import type {
  ExtensionAPI, AgentMessage,
  BeforeAgentStartEvent, BeforeAgentStartEventResult,
  AgentEndEvent, TurnEndEvent,
} from "./pi-api.js";
import {
  loadAll, saveMemoryEntry, queryRelevant,
  formatAsPrompt, getStats, getUserPath,
  deleteEntry, MemoryEntry, getMemoryPath,
  COMBINED_REVIEW_PROMPT, summarizeReviewActions,
} from "./memory.js";
import { loadConfig, saveConfig, buildProviderArgs } from "./config.js";

let sessionMessages: AgentMessage[] = [];
let config: Awaited<ReturnType<typeof loadConfig>> | null = null;

function messagesToText(msgs: AgentMessage[]): string {
  return msgs
    .map((m) => {
      const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "Tool";
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}] ${c.slice(0, 800)}`;
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
    sessionMessages.push(event.message);
  });

  // ─── Agent end: Hermes-style background review ───
  pi.on("agent_end", async (event: AgentEndEvent) => {
    if (config?.autoReflect === false) return;

    const allMsgs = sessionMessages.length > 0 ? sessionMessages : event.messages;
    const conversationText = messagesToText(allMsgs);

    // Use Hermes Agent's COMBINED_REVIEW_PROMPT
    const reflectionPrompt = `${COMBINED_REVIEW_PROMPT}\n\n---\n\n${conversationText}`;

    const piArgs = ["-p", reflectionPrompt, "--no-builtin-tools"];
    if (config) piArgs.push(...buildProviderArgs(config));

    try {
      const result = await pi.exec("pi", piArgs, {
        env: { ...process.env as any, PI_HINDSIGHT_SKIP_REFLECTION: "1" },
      });

      if (result.exitCode === 0 && result.stdout.trim()) {
        const output = result.stdout.trim();

        // Parse review actions from output
        const actions = summarizeReviewActions(output);
        if (actions.length > 0) {
          const summary = actions.map((a) => a.summary).join(" \u00b7 ");
          // Surface notification like Hermes does
          if (summary) {
            pi.sendMessage({
              customType: "hindsight",
              content: `\ud83d\udcbe Self-improvement review: ${summary}`,
              display: "review",
            });
          }
        }
      }
    } catch {
      // reflection failed silently - not critical
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
        type: {
          type: "string",
          enum: ["effective-strategy", "anti-pattern", "preference", "common-error", "workflow"],
          description: "Category. Use 'preference' for user-stated preferences.",
        },
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
        return `${i + 1}. ${badge} ${e.body.split("\n")[0] ?? ""}`;
      }).join("\n");
    },
  });

  // ─── Commands ───
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
          content: `Hindsight Stats\nMEMORY.md: ${s.memoryCount}\nUSER.md: ${s.userCount}\nTotal: ${s.total}\nAvg confidence: ${(s.avgConfidence * 100).toFixed(0)}%\n\n${lines}`,
          display: "stats",
        });
      } else if (cmd === "clear") {
        const { writeFile } = await import("node:fs/promises");
        const { getMemoryPath } = await import("./memory.js");
        await writeFile(getMemoryPath(), "", "utf-8");
        pi.sendMessage({ customType: "hindsight", content: "MEMORY.md cleared. USER.md left intact.", display: "clear" });
      } else if (cmd === "path") {
        pi.sendMessage({
          customType: "hindsight",
          content: `MEMORY.md: ${getMemoryPath()}\nUSER.md: ${getUserPath()}`,
          display: "path",
        });
      } else if (cmd === "prefer") {
        const rest = args.slice(1).join(" ").trim();
        if (!rest) {
          pi.sendMessage({
            customType: "hindsight",
            content: "Usage: /hindsight prefer <your preference>\nExample: /hindsight prefer Always use nvm use 20 before npm install",
            display: "help",
          });
          return;
        }
        const { addUserPreference } = await import("./memory.js");
        await addUserPreference(rest, ["user-preference"]);
        pi.sendMessage({ customType: "hindsight", content: `Saved to USER.md: "${rest.slice(0, 120)}"`, display: "prefer" });
      } else if (cmd === "config") {
        if (!config) config = await loadConfig();
        const sub = args[1];
        if (sub === "set-provider" && args[2]) {
          config.provider = args[2]; await saveConfig(config);
          pi.sendMessage({ customType: "hindsight", content: `Provider: ${args[2]}`, display: "config" });
        } else if (sub === "set-model" && args[2]) {
          config.model = args[2]; await saveConfig(config);
          pi.sendMessage({ customType: "hindsight", content: `Model: ${args[2]}`, display: "config" });
        } else if (sub === "toggle") {
          config.autoReflect = !config.autoReflect; await saveConfig(config);
          pi.sendMessage({ customType: "hindsight", content: `Auto-reflection: ${config.autoReflect ? "ON" : "OFF"}`, display: "config" });
        } else {
          pi.sendMessage({
            customType: "hindsight",
            content: `Config\nProvider: ${config.provider ?? "(default)"}\nModel: ${config.model ?? "(default)"}\nAuto-reflect: ${config.autoReflect}`,
            display: "config",
          });
        }
      } else {
        const { all } = await loadAll();
        if (all.length === 0) {
          pi.sendMessage({
            customType: "hindsight",
            content: "No patterns yet. Commands: /hindsight stats, /hindsight path, /hindsight config, /hindsight prefer <text>",
            display: "list",
          });
          return;
        }
        const lines = all.slice(0, 15).map((e, i) => {
          const badge = e.userStated ? "[USER]" : `[${(e.confidence * 100).toFixed(0)}%]`;
          return `${i + 1}. ${badge} ${(e.body.split("\n")[0] ?? "").slice(0, 70)}`;
        });
        pi.sendMessage({
          customType: "hindsight",
          content: `Hindsight (${all.length}: ${all.filter((e) => e.userStated).length} user, ${all.filter((e) => !e.userStated).length} learned)\n\n${lines.join("\n")}`,
          display: "list",
        });
      }
    },
  });

  pi.registerCommand("forget", {
    description: "Remove a pattern by ID or number: /forget <id|#>",
    handler: async (ctx) => {
      const target = (ctx.args ?? "").trim();
      if (!target) { pi.sendMessage({ customType: "hindsight", content: "Usage: /forget <id> or /forget <#>", display: "help" }); return; }
      const { all } = await loadAll();
      const byId = all.find((e) => e.id === target);
      if (byId) { await deleteEntry(target); pi.sendMessage({ customType: "hindsight", content: `Forgotten: "${byId.summary.slice(0, 60)}"`, display: "forget" }); return; }
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
