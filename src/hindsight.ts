import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI, AgentMessage,
  BeforeAgentStartEvent, BeforeAgentStartEventResult,
  AgentEndEvent, TurnEndEvent,
} from "./pi-api.js";
import type { MemoryEntry } from "./memory.js";
import {
  loadAll, saveAll, addEntry, queryRelevant,
  formatAsPrompt, buildReflectionPrompt, getStats,
} from "./memory.js";
import { buildLearnPatternTool, buildRecallTool } from "./tools.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let reflectionEnabled = true;
let sessionTask = "";
let turnMessages: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractContext(messages: AgentMessage[]): string {
  for (const m of messages) {
    if (m.role === "user") {
      const t = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const ex = t.match(/\.(\w+)\b/g);
      if (ex) return ex.slice(0, 5).join(", ");
    }
  }
  return "";
}

function summarizeTurn(msg: AgentMessage): string {
  const c = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
  return c.slice(0, 1000);
}

function entryId(): string {
  return `hint_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

export function setupHandlers(pi: ExtensionAPI): void {
  // ─── Session start: load memory ───
  pi.on("session_start", async () => {
    turnMessages = [];
    sessionTask = "";
  });

  // ─── Before agent start: inject hindsight context ───
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | undefined> => {
    sessionTask = event.prompt.slice(0, 200);
    turnMessages = [];

    const relevant = await queryRelevant(event.prompt.slice(0, 300));
    if (relevant.length === 0) return undefined;

    return { systemPrompt: event.systemPrompt + formatAsPrompt(relevant) };
  });

  // ─── Turn end: accumulate messages ───
  pi.on("turn_end", async (event: TurnEndEvent) => {
    turnMessages.push(summarizeTurn(event.message));
  });

  // ─── Agent end: auto-reflection (Hermes-style) ───
  pi.on("agent_end", async (event: AgentEndEvent) => {
    if (!reflectionEnabled || turnMessages.length === 0) return;

    // Build reflection prompt and let the agent process it
    const context = extractContext(event.messages);
    const reflectionPrompt = buildReflectionPrompt(turnMessages.join("\n"));

    // Send as background reflection turn
    pi.sendUserMessage(reflectionPrompt, { deliverAs: "followUp" });

    // Also extract session-level insight
    const errors = event.messages.filter(m => m.role === "tool").length > 3;
    if (!errors && turnMessages.length > 3) {
      await addEntry({
        id: entryId(),
        type: "workflow",
        summary: `Completed ${turnMessages.length}-turn task successfully`,
        body: `Completed ${turnMessages.length} turns without critical errors. Session context: ${context || "general"}`,
        tags: ["workflow"],
        confidence: 0.5,
        successCount: 1, failCount: 0,
        context,
        createdAt: new Date().toISOString(),
        lastApplied: null,
        source: sessionTask.slice(0, 100),
      });
    }
  });

  // ─── Register learn_pattern tool (agent-initiated learning) ───
  pi.registerTool(buildLearnPatternTool());

  // ─── Register recall tool (agent-initiated recall) ───
  pi.registerTool(buildRecallTool());

  // ─── Register /hindsight command ───
  pi.registerCommand("hindsight", {
    description: "View learned patterns: /hindsight, /hindsight stats, /hindsight clear",
    handler: async (ctx) => {
      const args = (ctx.args ?? "").trim();

      if (args === "stats") {
        const stats = await getStats();
        const byType = Object.entries(stats.byType)
          .map(([t, c]) => `  ${t}: ${c}`).join("\n");
        pi.sendMessage({
          customType: "hindsight",
          content: `MEMORY.md Stats\nTotal entries: ${stats.total}\nAvg confidence: ${(stats.avgConfidence * 100).toFixed(0)}%\n\n${byType}`,
          display: "stats",
        });
      } else if (args === "clear") {
        await saveAll([]);
        pi.sendMessage({ customType: "hindsight", content: "MEMORY.md cleared.", display: "clear" });
      } else if (args === "path") {
        const { homedir } = await import("node:os");
        const { join } = await import("node:path");
        const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
        pi.sendMessage({ customType: "hindsight", content: `MEMORY.md: ${dir}/extensions/hindsight/MEMORY.md`, display: "path" });
      } else {
        const entries = await loadAll();
        if (entries.length === 0) {
          pi.sendMessage({
            customType: "hindsight",
            content: "MEMORY.md is empty. Patterns are learned automatically when you use pi. Try: /hindsight stats, /hindsight path",
            display: "list",
          });
          return;
        }
        const lines = entries.slice(0, 15).map((e, i) => {
          const first = e.body.split("\n")[0] ?? "";
          return `${i + 1}. [${(e.confidence * 100).toFixed(0)}%] ${e.type}: ${first.slice(0, 80)}`;
        });
        pi.sendMessage({
          customType: "hindsight",
          content: `MEMORY.md entries (${entries.length} total)\n\n${lines.join("\n")}\n\n/hindsight stats | /hindsight path | /hindsight clear`,
          display: "list",
        });
      }
    },
  });

  // ─── Register /forget command ───
  pi.registerCommand("forget", {
    description: "Remove a pattern by ID or number. Usage: /forget <id|#>",
    handler: async (ctx) => {
      const target = (ctx.args ?? "").trim();
      if (!target) {
        pi.sendMessage({ customType: "hindsight", content: "Usage: /forget <pattern-id> or /forget <number>", display: "help" });
        return;
      }
      const entries = await loadAll();
      const byId = entries.find(e => e.id === target);
      if (byId) {
        await addEntry({ ...byId, confidence: -1 } as any);
        // Actually delete:
        const updated = entries.filter(e => e.id !== target);
        await saveAll(updated);
        pi.sendMessage({ customType: "hindsight", content: `Forgotten: "${byId.summary.slice(0, 60)}"`, display: "forget" });
        return;
      }
      const num = parseInt(target, 10);
      if (!isNaN(num) && num > 0 && num <= entries.length) {
        const e = entries[num - 1]!;
        const updated = entries.filter(x => x.id !== e.id);
        await saveAll(updated);
        pi.sendMessage({ customType: "hindsight", content: `Forgotten: "${e.summary.slice(0, 60)}"`, display: "forget" });
        return;
      }
      pi.sendMessage({ customType: "hindsight", content: `Not found: "${target}"`, display: "error" });
    },
  });
}
