/**
 * Markdown-based memory storage for pi-hindsight.
 *
 * Two-tier memory matching Hermes Agent:
 *   MEMORY.md  - LLM-learned patterns (confidence varies)
 *   USER.md    - User-stated preferences (confidence=1.0, permanent)
 *
 * Review prompts ported from Hermes Agent background_review.py (MIT license).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type PatternType =
  | "effective-strategy" | "anti-pattern"
  | "preference" | "common-error" | "workflow";

export interface MemoryEntry {
  id: string;
  type: PatternType;
  summary: string;
  body: string;
  tags: string[];
  confidence: number;
  successCount: number;
  failCount: number;
  context: string;
  createdAt: string;
  lastApplied: string | null;
  source: string;
  userStated: boolean;
}

export interface MemoryStats {
  total: number;
  memoryCount: number;
  userCount: number;
  byType: Record<string, number>;
  avgConfidence: number;
  highestConfidence: number;
}

// ---------------------------------------------------------------------------
// Hermes Agent Review Prompts (ported from background_review.py, MIT license)
// ---------------------------------------------------------------------------

export const MEMORY_REVIEW_PROMPT = `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves - their persona, desires, preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?

If something stands out, save it using the learn_pattern tool (use type=preference for user preferences).
If nothing is worth saving, just say the word STOP.`;

export const SKILL_REVIEW_PROMPT = `Review the conversation above and update the memory. Be ACTIVE - most sessions produce at least one update. A pass that does nothing is a missed learning opportunity, not a neutral outcome.

Signals to look for (any one warrants action):
  - User corrected your style, tone, format, or approach.
  - Non-trivial technique, fix, workaround, or debugging pattern emerged.
  - A previously learned pattern turned out wrong or outdated.

Preference order:
  1. Save a pattern using learn_pattern tool
  2. Update an existing pattern (same type + similar summary)

User-preference embedding: when the user expressed a style/format/workflow preference, save it as type=preference so it goes to USER.md.

Do NOT capture:
  - Environment-dependent failures (missing binaries, fresh-install errors)
  - Negative claims about tools or features that are temporary
  - Session-specific transient errors that resolved
  - One-off task narratives

If nothing is worth saving, just say the word STOP.`;

export const COMBINED_REVIEW_PROMPT = `Review the conversation above and update two things:

**Memory**: who the user is. Did the user reveal persona, desires, preferences, personal details, or expectations about how you should behave? Save facts about the user with learn_pattern (type=preference).

**Patterns**: what was learned. Be ACTIVE - most sessions produce at least one pattern worth saving.

Signals that warrant saving:
  - User corrected your style, tone, format, or approach.
  - Non-trivial technique, fix, workaround, or debugging path emerged.
  - A previously saved pattern turned out wrong or outdated - update it.

Preference order:
  1. Save a pattern using learn_pattern tool
  2. Update an existing pattern

User-preference embedding: when the user complains about how you handled a task, save it as type=preference in USER.md.

Do NOT capture:
  - Environment-dependent failures
  - Negative claims about tools or features
  - Session-specific transient errors
  - One-off task narratives

Act on whichever dimension has real signal. If genuinely nothing stands out, just say the word STOP.`;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getStoreDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "extensions", "hindsight");
}

export function getMemoryPath(): string {
  return join(getStoreDir(), "MEMORY.md");
}

export function getUserPath(): string {
  return join(getStoreDir(), "USER.md");
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeEntry(e: MemoryEntry, includeUserField: boolean): string {
  const lines = [
    `\u00a7 ${e.id}`,
    `type: ${e.type}`,
    `confidence: ${e.userStated ? 1.0 : e.confidence}`,
    `tags: [${e.tags.join(", ")}]`,
    `created: ${e.createdAt}`,
    e.lastApplied ? `applied: ${e.lastApplied}` : null,
    `source: ${e.source}`,
    includeUserField ? `user-stated: ${e.userStated}` : null,
    `---`,
    e.body,
    "",
  ];
  return lines.filter(Boolean).join("\n");
}

function parseChunks(text: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const blocks = text.split(/(?=^\u00a7 )/m);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed || !trimmed.startsWith("\u00a7 ")) continue;
    const lines = trimmed.split("\n");
    const idLine = lines[0]?.match(/^\u00a7\s+(\S+)/);
    if (!idLine) continue;
    const id = idLine[1]!;
    const meta: Record<string, string> = {};
    let bodyStart = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]!.trim() === "---") { bodyStart = i + 1; break; }
      const m = lines[i]!.match(/^(\w[\w-]*):\s*(.+)$/);
      if (m) meta[m[1]!] = m[2]!.trim();
    }
    const body = bodyStart > 0 ? lines.slice(bodyStart).join("\n").trim() : "";
    const c = parseFloat(meta.confidence ?? "0.5");
    const userStated = meta["user-stated"] === "true";
    entries.push({
      id,
      type: (meta.type as PatternType) ?? "effective-strategy",
      summary: body.split("\n")[0]?.slice(0, 120) ?? "",
      body,
      tags: (meta.tags ?? "[]").replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean),
      confidence: userStated ? 1.0 : isNaN(c) ? 0.5 : c,
      successCount: parseInt(meta.successCount ?? "0", 10) || 0,
      failCount: parseInt(meta.failCount ?? "0", 10) || 0,
      context: meta.context ?? "",
      createdAt: meta.created ?? new Date().toISOString(),
      lastApplied: meta.applied ?? null,
      source: meta.source ?? (userStated ? "user" : "unknown"),
      userStated,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// File-level operations
// ---------------------------------------------------------------------------

async function readEntries(path: string): Promise<MemoryEntry[]> {
  try {
    return parseChunks(await readFile(path, "utf-8"));
  } catch {
    return [];
  }
}

async function writeEntries(path: string, entries: MemoryEntry[]): Promise<void> {
  const dir = getStoreDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const content = entries.map((e) => serializeEntry(e, true)).join("\n") + "\n";
  await writeFile(path, content, "utf-8");
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function loadAll(): Promise<{
  memory: MemoryEntry[];
  user: MemoryEntry[];
  all: MemoryEntry[];
}> {
  const memory = await readEntries(getMemoryPath());
  const user = await readEntries(getUserPath());
  return { memory, user, all: [...user, ...memory] };
}

export async function saveMemoryEntry(entry: MemoryEntry): Promise<void> {
  const { memory, user } = await loadAll();
  if (entry.userStated) {
    user.push(entry);
    await writeEntries(getUserPath(), user);
    return;
  }
  const first = entry.body.split("\n")[0]?.trim().toLowerCase() ?? "";
  const idx = memory.findIndex(
    (e) => !e.userStated && e.type === entry.type && e.body.split("\n")[0]?.trim().toLowerCase() === first,
  );
  if (idx >= 0) {
    const cur = memory[idx]!;
    if (entry.confidence > cur.confidence) cur.confidence = entry.confidence;
    cur.successCount += entry.successCount;
    cur.failCount += entry.failCount;
    cur.lastApplied = new Date().toISOString();
    if (entry.body.length > cur.body.length) cur.body = entry.body;
    memory[idx] = cur;
  } else {
    memory.push(entry);
  }
  memory.sort((a, b) => b.confidence - a.confidence || b.createdAt.localeCompare(a.createdAt));
  if (memory.length > 100) memory.splice(100);
  await writeEntries(getMemoryPath(), memory);
}

export async function queryRelevant(context: string, minConfidence = 0.3): Promise<MemoryEntry[]> {
  const { all } = await loadAll();
  const ctx = context.toLowerCase();
  return all.filter((e) => {
    const conf = e.userStated ? 1.0 : e.confidence;
    if (conf < minConfidence) return false;
    if (!ctx) return true;
    return e.body.toLowerCase().includes(ctx) || e.tags.some((t) => t.toLowerCase().includes(ctx));
  });
}

export async function getStats(): Promise<MemoryStats> {
  const { memory, user, all } = await loadAll();
  const byType: Record<string, number> = {};
  let totalConf = 0;
  let highest = 0;
  for (const e of all) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    totalConf += e.userStated ? 1.0 : e.confidence;
    if (e.confidence > highest) highest = e.confidence;
  }
  return {
    total: all.length, memoryCount: memory.length, userCount: user.length,
    byType,
    avgConfidence: all.length > 0 ? totalConf / all.length : 0,
    highestConfidence: highest,
  };
}

export async function addUserPreference(body: string, tags: string[]): Promise<MemoryEntry> {
  const entry: MemoryEntry = {
    id: `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type: "preference",
    summary: body.split("\n")[0]?.slice(0, 120) ?? body.slice(0, 120),
    body, tags,
    confidence: 1.0,
    successCount: 0, failCount: 0, context: "",
    createdAt: new Date().toISOString(),
    lastApplied: new Date().toISOString(),
    source: "user",
    userStated: true,
  };
  await saveMemoryEntry(entry);
  return entry;
}

export async function deleteEntry(id: string): Promise<boolean> {
  const { memory, user } = await loadAll();
  const memBefore = memory.length;
  const userBefore = user.length;
  const newMem = memory.filter((e) => e.id !== id);
  const newUser = user.filter((e) => e.id !== id);
  if (newMem.length !== memBefore) {
    await writeEntries(getMemoryPath(), newMem);
    return true;
  }
  if (newUser.length !== userBefore) {
    await writeEntries(getUserPath(), newUser);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

export function formatAsPrompt(entries: MemoryEntry[], max = 5): string {
  if (entries.length === 0) return "";
  const sorted = [...entries].sort((a, b) => {
    if (a.userStated && !b.userStated) return -1;
    if (!a.userStated && b.userStated) return 1;
    return b.confidence - a.confidence;
  });
  const lines = sorted.slice(0, max).map((e, i) => {
    const prefix = e.userStated ? "[USER]" : `[${(e.confidence * 100).toFixed(0)}%]`;
    const first = e.body.split("\n")[0] ?? e.summary;
    return `${i + 1}. ${prefix} ${first}`;
  });
  return [
    "",
    "---",
    "## Hindsight (learned patterns + user preferences)",
    "[USER] = user-stated preference (fixed). [XX%] = learned pattern (confidence).",
    ...lines,
    "---",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Background review output parser (ported from Hermes summarize_background_review_actions)
// ---------------------------------------------------------------------------

export interface ReviewAction {
  tool: string;
  action: string;
  target: string;
  summary: string;
}

export function summarizeReviewActions(
  reviewOutput: string,
): ReviewAction[] {
  const actions: ReviewAction[] = [];
  const lines = reviewOutput.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // Look for learn_pattern tool call results
    if (trimmed.startsWith("Learned:") || trimmed.startsWith("learn_pattern")) {
      actions.push({
        tool: "learn_pattern",
        action: "created",
        target: "memory",
        summary: trimmed.replace(/^(Learned:|learn_pattern)/, "").trim().slice(0, 80),
      });
    }
    // Look for recall results
    if (trimmed.startsWith("Found pattern") || trimmed.startsWith("recall result")) {
      actions.push({
        tool: "recall",
        action: "queried",
        target: "memory",
        summary: trimmed.slice(0, 80),
      });
    }
    // Detect STOP signal
    if (trimmed === "STOP" || trimmed === "Nothing to save.") {
      return actions; // Nothing saved
    }
  }
  return actions;
}
