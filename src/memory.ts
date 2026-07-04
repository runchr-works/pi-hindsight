/**
 * Markdown-based memory storage for pi-hindsight.
 * Stores learned patterns as \u00a7-delimited entries in MEMORY.md,
 * matching Hermes Agent's memory format. Human-readable, git-friendly.
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
}

export interface MemoryStats {
  total: number;
  byType: Record<string, number>;
  avgConfidence: number;
  highestConfidence: number;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getStoreDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "extensions", "hindsight");
}

function getMemoryPath(): string {
  return join(getStoreDir(), "MEMORY.md");
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeEntry(e: MemoryEntry): string {
  const lines = [
    `\u00a7 ${e.id}`,
    `type: ${e.type}`,
    `confidence: ${e.confidence}`,
    `tags: [${e.tags.join(", ")}]`,
    `created: ${e.createdAt}`,
    e.lastApplied ? `applied: ${e.lastApplied}` : null,
    `source: ${e.source}`,
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
      const m = lines[i]!.match(/^(\w+):\s*(.+)$/);
      if (m) meta[m[1]!] = m[2]!.trim();
    }
    const body = bodyStart > 0 ? lines.slice(bodyStart).join("\n").trim() : "";
    const c = parseFloat(meta.confidence ?? "0.5");
    entries.push({
      id, type: (meta.type as PatternType) ?? "effective-strategy",
      summary: body.split("\n")[0]?.slice(0, 120) ?? "", body,
      tags: (meta.tags ?? "[]").replace(/^\[|\]$/g, "").split(",").map(t => t.trim()).filter(Boolean),
      confidence: isNaN(c) ? 0.5 : c,
      successCount: parseInt(meta.successCount ?? "0", 10) || 0,
      failCount: parseInt(meta.failCount ?? "0", 10) || 0,
      context: meta.context ?? "",
      createdAt: meta.created ?? new Date().toISOString(),
      lastApplied: meta.applied ?? null,
      source: meta.source ?? "unknown",
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function loadAll(): Promise<MemoryEntry[]> {
  try {
    return parseChunks(await readFile(getMemoryPath(), "utf-8"));
  } catch {
    return [];
  }
}

export async function saveAll(entries: MemoryEntry[]): Promise<void> {
  const dir = getStoreDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(getMemoryPath(), entries.map(serializeEntry).join("\n") + "\n", "utf-8");
}

export async function addEntry(entry: MemoryEntry): Promise<MemoryEntry[]> {
  const entries = await loadAll();
  const firstLine = entry.body.split("\n")[0]?.trim().toLowerCase() ?? "";
  const idx = entries.findIndex(
    (e) => e.type === entry.type && e.body.split("\n")[0]?.trim().toLowerCase() === firstLine,
  );
  if (idx >= 0) {
    const cur = entries[idx]!;
    if (entry.confidence > cur.confidence) cur.confidence = entry.confidence;
    cur.successCount += entry.successCount;
    cur.failCount += entry.failCount;
    cur.lastApplied = new Date().toISOString();
    if (entry.body.length > cur.body.length) cur.body = entry.body;
    entries[idx] = cur;
  } else {
    entries.push(entry);
  }
  entries.sort((a, b) => b.confidence - a.confidence || b.createdAt.localeCompare(a.createdAt));
  if (entries.length > 100) entries.splice(100);
  await saveAll(entries);
  return entries;
}

export async function deleteEntry(id: string): Promise<boolean> {
  const entries = await loadAll();
  const before = entries.length;
  const filtered = entries.filter((e) => e.id !== id);
  if (filtered.length !== before) {
    await saveAll(filtered);
    return true;
  }
  return false;
}

export async function queryRelevant(context: string, minConfidence = 0.3): Promise<MemoryEntry[]> {
  const entries = await loadAll();
  const ctx = context.toLowerCase();
  return entries.filter((e) => {
    if (e.confidence < minConfidence) return false;
    if (!ctx) return true;
    return e.body.toLowerCase().includes(ctx) || e.tags.some((t) => t.toLowerCase().includes(ctx));
  });
}

export async function getStats(): Promise<MemoryStats> {
  const entries = await loadAll();
  const byType: Record<string, number> = {};
  let totalConf = 0;
  let highest = 0;
  for (const e of entries) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    totalConf += e.confidence;
    if (e.confidence > highest) highest = e.confidence;
  }
  return {
    total: entries.length, byType,
    avgConfidence: entries.length > 0 ? totalConf / entries.length : 0,
    highestConfidence: highest,
  };
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

export function formatAsPrompt(entries: MemoryEntry[], max = 5): string {
  if (entries.length === 0) return "";
  const lines = entries.slice(0, max).map((e, i) =>
    `${i + 1}. [${(e.confidence * 100).toFixed(0)}%] ${e.body.split("\n")[0] ?? e.summary}`,
  );
  return ["", "---", "## Hindsight (learned from past sessions)",
    "The following patterns were learned from previous work. Consider them when relevant.",
    ...lines, "---", "",
  ].join("\n");
}

export function buildReflectionPrompt(turnSummary: string): string {
  return `## Background Self-Improvement Review

Review the conversation above. Identify if there\'s anything worth remembering:
- Effective strategy or workflow to repeat?
- Mistake or anti-pattern to avoid?
- User preference to record?
- Recurring error pattern?

If you find something worth remembering, call the \`learn_pattern\` tool to save it.
Be selective \u2014 only save high-value, reusable patterns.
If nothing is worth remembering, do nothing.`;
}
