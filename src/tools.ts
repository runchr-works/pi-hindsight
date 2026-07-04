/**
 * Tool definitions for pi-hindsight.
 *
 * Registers two tools the agent can call:
 * - learn_pattern: Save a pattern from this session
 * - recall: Query past learned patterns
 */

import type { MemoryEntry, PatternType } from "./memory.js";
import { addEntry, queryRelevant } from "./memory.js";

// ---------------------------------------------------------------------------
// Tool handler helpers
// ---------------------------------------------------------------------------

export function buildLearnPatternTool() {
  return {
    name: "learn_pattern",
    description: "Save a reusable pattern learned from this session for future reference",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "One-line summary of what was learned (max 120 chars)",
        },
        type: {
          type: "string",
          enum: ["effective-strategy", "anti-pattern", "preference", "common-error", "workflow"],
          description: "Category of pattern",
        },
        detail: {
          type: "string",
          description: "Detailed description of the pattern, what happened, and why it matters",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization (e.g. react, testing, deployment)",
        },
      },
      required: ["summary", "type", "detail"],
    },
    execute: async (input: { summary: string; type: PatternType; detail: string; tags?: string[] }) => {
      const entry: MemoryEntry = {
        id: `hint_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        type: input.type,
        summary: input.summary.slice(0, 120),
        body: `${input.summary}\n\n${input.detail}`,
        tags: input.tags ?? [],
        confidence: 0.6,
        successCount: 1,
        failCount: 0,
        context: "",
        createdAt: new Date().toISOString(),
        lastApplied: new Date().toISOString(),
        source: "agent-learned",
      };
      await addEntry(entry);
      return `Learned pattern "${input.summary.slice(0, 60)}..."`;
    },
  };
}

export function buildRecallTool() {
  return {
    name: "recall",
    description: "Query past learned patterns relevant to your current task",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for (e.g. 'refactoring', 'react component', 'testing')",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of patterns to return (default 3)",
        },
      },
      required: ["query"],
    },
    execute: async (input: { query: string; maxResults?: number }) => {
      const relevant = await queryRelevant(input.query);
      if (relevant.length === 0) return "No relevant patterns found.";
      return relevant.slice(0, input.maxResults ?? 3).map((e, i) =>
        `${i + 1}. [${(e.confidence * 100).toFixed(0)}%] ${e.type}: ${e.body.split("\n")[0]}`,
      ).join("\n");
    },
  };
}
