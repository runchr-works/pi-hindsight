import type {
  ExtensionAPI, AgentMessage,
  BeforeAgentStartEvent, BeforeAgentStartEventResult,
  AgentEndEvent, TurnEndEvent,
} from "./pi-api.js";
import {
  loadAll, saveMemoryEntry, queryRelevant,
  formatAsPrompt, getStats, getUserPath, getMemoryPath,
  deleteEntry,
  COMBINED_REVIEW_PROMPT, summarizeReviewActions,
} from "./memory.js";
import { loadConfig, saveConfig, buildProviderArgs } from "./config.js";

let sessionMessages: AgentMessage[] = [];
let sessionSystemPrompt = "";
let config: Awaited<ReturnType<typeof loadConfig>> | null = null;

function formatMessages(msgs: AgentMessage[]): string {
  return msgs.map((m) => {
    const role = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "Tool";
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `<${role}>\n${c}`;
  }).join("\n\n");
}

// Skip reflection on trivial turns to save cost
function isTrivialTurn(msg: AgentMessage): boolean {
  const c = typeof msg.content === "string" ? msg.content.trim() : "";
  if (!c || c.length < 10) return true;
  const trivial = ["ok", "got it", "done", "yes", "no", "sure", "👍", "✅"];
  return trivial.some((t) => c.toLowerCase() === t || c.toLowerCase().startsWith(t));
}

// Warm cache: build reflection prompt using the same system prefix
function buildReviewPrompt(conversationText: string): string {
  return `${sessionSystemPrompt}\n\n---\n\n${COMBINED_REVIEW_PROMPT}\n\n---\n\n${conversationText}`;
}

async function fireReflection(pi: ExtensionAPI, prompt: string): Promise<void> {
  const piArgs = ["-p", prompt, "--no-builtin-tools"];
  if (config) piArgs.push(...buildProviderArgs(config));
  try {
    const result = await pi.exec("pi", piArgs, {
      env: { ...process.env as any, PI_HINDSIGHT_SKIP_REFLECTION: "1" },
    });
    if (result.exitCode === 0 && result.stdout.trim()) {
      const actions = summarizeReviewActions(result.stdout.trim());
      if (actions.length > 0) {
        pi.sendMessage({
          customType: "hindsight",
          content: `\ud83d\udcbe Self-improvement review: ${actions.map((a) => a.summary).join(" \u00b7 ")}`,
          display: "review",
        });
      }
    }
  } catch {
    // reflection failed silently
  }
}

export function setupHandlers(pi: ExtensionAPI): void {
  loadConfig().then((c) => { config = c; });
  if (process.env.PI_HINDSIGHT_SKIP_REFLECTION === "1") return;

  pi.on("session_start", async () => {
    sessionMessages = [];
    sessionSystemPrompt = "";
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | undefined> => {
    if (config?.autoReflect === false) return undefined;
    sessionMessages = [];
    // Store system prompt for warm cache in review forks
    sessionSystemPrompt = event.systemPrompt;
    const relevant = await queryRelevant(event.prompt.slice(0, 300), config?.minConfidence ?? 0.3);
    if (relevant.length === 0) return undefined;
    return { systemPrompt: event.systemPrompt + formatAsPrompt(relevant) };
  });

  // ─── Per-turn review (Hermes-style) ───
  pi.on("turn_end", async (event: TurnEndEvent) => {
    if (config?.autoReflect === false) return;
    sessionMessages.push(event.message);

    // Skip trivial turns to save cost
    if (isTrivialTurn(event.message)) return;

    // Full conversation context — no truncation
    const conversationText = formatMessages(sessionMessages);
    const prompt = buildReviewPrompt(conversationText);

    // Fire-and-forget (non-blocking)
    fireReflection(pi, prompt);
  });

  // ─── Session-end review (catch anything missed) ───
  pi.on("agent_end", async (event: AgentEndEvent) => {
    if (config?.autoReflect === false) return;
    if (sessionMessages.length === 0 && event.messages.length > 0) {
      sessionMessages = event.messages;
    }
    const conversationText = formatMessages(sessionMessages);
    const prompt = buildReviewPrompt(conversationText);
    fireReflection(pi, prompt);
  });

  // ─── learn_pattern tool ───
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
        tags: { type: "array", items: { type: "string" }, description: "Tags" },
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

  // ─── recall tool ───
  pi.registerTool({
    name: "recall",
    description: "Query past learned patterns",
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
    description: "/hindsight [list|stats|clear|path|config|prefer]",
    handler: async (ctx) => {
      const args = (ctx.args ?? "").trim().split(/\s+/);
      const cmd = args[0] ?? "list";

      if (cmd === "stats") {
        const s = await getStats();
        const lines = Object.entries(s.byType).map(([t, c]) => `  ${t}: ${c}`).join("\n");
        pi.sendMessage({ customType: "hindsight", content: `MEMORY.md: ${s.memoryCount}\nUSER.md: ${s.userCount}\nAvg conf: ${(s.avgConfidence * 100).toFixed(0)}%\n\n${lines}`, display: "stats" });
      } else if (cmd === "clear") {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(getMemoryPath(), "", "utf-8");
        pi.sendMessage({ customType: "hindsight", content: "MEMORY.md cleared. USER.md intact.", display: "clear" });
      } else if (cmd === "path") {
        pi.sendMessage({ customType: "hindsight", content: `MEMORY.md: ${getMemoryPath()}\nUSER.md: ${getUserPath()}`, display: "path" });
      } else if (cmd === "prefer") {
        const rest = args.slice(1).join(" ").trim();
        if (!rest) { pi.sendMessage({ customType: "hindsight", content: "Usage: /hindsight prefer <text>", display: "help" }); return; }
        const { addUserPreference } = await import("./memory.js");
        await addUserPreference(rest, ["user-preference"]);
        pi.sendMessage({ customType: "hindsight", content: `Saved to USER.md: "${rest.slice(0, 120)}"`, display: "prefer" });
      } else if (cmd === "config") {
        if (!config) config = await loadConfig();
        const sub = args[1];
        if (sub === "set-provider" && args[2]) { config.provider = args[2]; await saveConfig(config); pi.sendMessage({ customType: "hindsight", content: `Provider: ${args[2]}`, display: "config" }); }
        else if (sub === "set-model" && args[2]) { config.model = args[2]; await saveConfig(config); pi.sendMessage({ customType: "hindsight", content: `Model: ${args[2]}`, display: "config" }); }
        else if (sub === "toggle") { config.autoReflect = !config.autoReflect; await saveConfig(config); pi.sendMessage({ customType: "hindsight", content: `Auto-reflection: ${config.autoReflect ? "ON" : "OFF"}`, display: "config" }); }
        else { pi.sendMessage({ customType: "hindsight", content: `Provider: ${config.provider ?? "(default)"}\nModel: ${config.model ?? "(default)"}\nAuto-reflect: ${config.autoReflect}`, display: "config" }); }
      } else {
        const { all } = await loadAll();
        if (all.length === 0) { pi.sendMessage({ customType: "hindsight", content: "Empty. /hindsight prefer <text> to add.", display: "list" }); return; }
        const lines = all.slice(0, 15).map((e, i) => {
          const badge = e.userStated ? "[USER]" : `[${(e.confidence * 100).toFixed(0)}%]`;
          return `${i + 1}. ${badge} ${(e.body.split("\n")[0] ?? "").slice(0, 70)}`;
        });
        pi.sendMessage({ customType: "hindsight", content: `${all.length} total (${all.filter((e) => e.userStated).length} user)\n\n${lines.join("\n")}`, display: "list" });
      }
    },
  });

  pi.registerCommand("forget", {
    description: "/forget <id|#>",
    handler: async (ctx) => {
      const target = (ctx.args ?? "").trim();
      if (!target) { pi.sendMessage({ customType: "hindsight", content: "Usage: /forget <id> or /forget <#>", display: "help" }); return; }
      const { all } = await loadAll();
      const byId = all.find((e) => e.id === target);
      if (byId) { await deleteEntry(target); pi.sendMessage({ customType: "hindsight", content: `Forgotten: "${byId.summary.slice(0, 60)}"`, display: "forget" }); return; }
      const num = parseInt(target, 10);
      if (!isNaN(num) && num > 0 && num <= all.length) {
        const e = all[num - 1]!; await deleteEntry(e.id);
        pi.sendMessage({ customType: "hindsight", content: `Forgotten: "${e.summary.slice(0, 60)}"`, display: "forget" });
        return;
      }
      pi.sendMessage({ customType: "hindsight", content: `Not found: "${target}"`, display: "error" });
    },
  });
}
