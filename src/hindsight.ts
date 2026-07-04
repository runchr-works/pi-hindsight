import { randomUUID } from "node:crypto";
import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult, AgentEndEvent, TurnEndEvent, AgentMessage, ToolResultMessage, ExtensionCommandContext } from "./pi-api.js";
import type { HindsightPattern, HindsightConfig } from "./patterns.js";
import { loadStore, saveStore, addPattern, getRelevantPatterns, formatPatternsAsPrompt } from "./store.js";

// ---------------------------------------------------------------------------
// In-memory session tracking
// ---------------------------------------------------------------------------

interface SessionInfo {
  startTime: number;
  taskDescription: string;
  turnCount: number;
  errors: string[];
}

let currentSession: SessionInfo | null = null;
let config: HindsightConfig = { maxPatterns: 100, minConfidence: 0.3, autoInject: true };

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

function extractContext(messages: AgentMessage[]): string {
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      const extMatch = text.match(/\.(\w+)\b/g);
      if (extMatch) return extMatch.slice(0, 5).join(", ");
    }
  }
  return "";
}

function classifyTurn(toolResults: ToolResultMessage[], context: string): HindsightPattern | null {
  const errors = toolResults.filter((r) => r.isError);
  let summary = "";
  let type: HindsightPattern["type"] = "effective-strategy";
  let confidence = 0.5;

  if (errors.length > 0) {
    type = "common-error";
    summary = `Turn had ${errors.length} error(s)`;
    confidence = 0.6;
  } else if (toolResults.length > 0 && toolResults.length < 5) {
    summary = "Completed task efficiently with minimal tool calls";
    type = "effective-strategy";
    confidence = 0.5;
  }

  if (!summary) return null;

  return {
    id: `hint_${randomUUID().slice(0, 12)}`,
    type, summary,
    detail: `${toolResults.length} tool calls, ${errors.length} errors`,
    tags: type === "common-error" ? ["error"] : ["strategy"],
    confidence,
    successCount: errors.length === 0 ? 1 : 0,
    failCount: errors.length > 0 ? 1 : 0,
    context,
    createdAt: new Date().toISOString(),
    lastApplied: null,
    sourceSession: currentSession?.taskDescription ?? "unknown",
  };
}

// ---------------------------------------------------------------------------
// Event Handlers
// ---------------------------------------------------------------------------

export function setupHandlers(pi: ExtensionAPI): void {
  // Inject learned patterns into system prompt
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | undefined> => {
    if (!config.autoInject) return undefined;
    currentSession = { startTime: Date.now(), taskDescription: event.prompt.slice(0, 100), turnCount: 0, errors: [] };
    const relevant = await getRelevantPatterns(event.prompt.slice(0, 200), config.minConfidence);
    if (relevant.length === 0) return undefined;
    return { systemPrompt: event.systemPrompt + formatPatternsAsPrompt(relevant) };
  });

  // Per-turn learning
  pi.on("turn_end", async (event: TurnEndEvent) => {
    if (!currentSession) return;
    currentSession.turnCount++;
    for (const r of event.toolResults) {
      if (r.isError) currentSession.errors.push(String(r.content ?? ""));
    }
    const pattern = classifyTurn(event.toolResults, extractContext([event.message]));
    if (pattern) await addPattern(pattern);
  });

  // Session-level learning
  pi.on("agent_end", async (event: AgentEndEvent) => {
    if (!currentSession) return;
    if (currentSession.turnCount > 3 && currentSession.errors.length === 0) {
      await addPattern({
        id: `hint_${randomUUID().slice(0, 12)}`,
        type: "workflow",
        summary: `Completed ${currentSession.turnCount}-turn task without errors`,
        detail: "Reliable multi-turn workflow pattern",
        tags: ["workflow", "reliable"],
        confidence: Math.min(0.7, 0.3 + currentSession.turnCount * 0.1),
        successCount: 1, failCount: 0,
        context: extractContext(event.messages),
        createdAt: new Date().toISOString(),
        lastApplied: null,
        sourceSession: currentSession.taskDescription,
      });
    }
    currentSession = null;
  });

  // /hindsight command
  pi.registerCommand("hindsight", {
    description: "Show learned patterns. Usage: /hindsight [list|stats|clear]",
    handler: async (cmdCtx: ExtensionCommandContext) => {
      const args = (cmdCtx.args ?? "").trim();
      if (args === "stats") {
        const store = await loadStore();
        const byType: Record<string, number> = {};
        for (const p of store.patterns) byType[p.type] = (byType[p.type] ?? 0) + 1;
        const lines = Object.entries(byType).map(([t, c]) => `  ${t}: ${c}`).join("\n");
        const avg = store.patterns.length ? (store.patterns.reduce((s, p) => s + p.confidence, 0) / store.patterns.length * 100).toFixed(0) : "0";
        pi.sendMessage({ customType: "hindsight", content: `Stats\nPatterns: ${store.patterns.length}\nAvg confidence: ${avg}%\n\n${lines}`, display: "stats" });
      } else if (args === "clear") {
        const store = await loadStore();
        store.patterns = [];
        await saveStore(store);
        pi.sendMessage({ customType: "hindsight", content: "All patterns cleared.", display: "clear" });
      } else {
        const store = await loadStore();
        if (store.patterns.length === 0) {
          pi.sendMessage({ customType: "hindsight", content: "No patterns yet.", display: "list" });
          return;
        }
        const lines = store.patterns.slice(0, 20).map((p, i) => `${i + 1}. [${(p.confidence * 100).toFixed(0)}%] ${p.type}: ${p.summary}`);
        pi.sendMessage({ customType: "hindsight", content: `Patterns (${store.patterns.length} total)\n\n${lines.join("\n")}`, display: "list" });
      }
    },
  });

  // /forget command
  pi.registerCommand("forget", {
    description: "Remove a pattern by ID or number. Usage: /forget <id|#>",
    handler: async (cmdCtx: ExtensionCommandContext) => {
      const target = (cmdCtx.args ?? "").trim();
      if (!target) {
        pi.sendMessage({ customType: "hindsight", content: "Usage: /forget <pattern-id> or /forget <number>", display: "help" });
        return;
      }
      const store = await loadStore();
      const byId = store.patterns.find((p) => p.id === target);
      if (byId) {
        store.patterns = store.patterns.filter((p) => p.id !== target);
        await saveStore(store);
        pi.sendMessage({ customType: "hindsight", content: `Forgotten: "${byId.summary}"`, display: "forget" });
        return;
      }
      const num = parseInt(target, 10);
      if (!isNaN(num) && num > 0 && num <= store.patterns.length) {
        const pattern = store.patterns[num - 1]!;
        store.patterns = store.patterns.filter((p) => p.id !== pattern.id);
        await saveStore(store);
        pi.sendMessage({ customType: "hindsight", content: `Forgotten: "${pattern.summary}"`, display: "forget" });
        return;
      }
      pi.sendMessage({ customType: "hindsight", content: `Pattern not found: "${target}"`, display: "error" });
    },
  });
}
