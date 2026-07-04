import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HindsightStore, HindsightPattern } from "./patterns.js";

// ---------------------------------------------------------------------------
// Storage paths
// ---------------------------------------------------------------------------

function getStoreDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "extensions", "hindsight");
}

function getStorePath(): string {
  return join(getStoreDir(), "patterns.json");
}

// ---------------------------------------------------------------------------
// Default store
// ---------------------------------------------------------------------------

const DEFAULT_STORE: HindsightStore = {
  version: 1,
  patterns: [],
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function loadStore(): Promise<HindsightStore> {
  try {
    const raw = await readFile(getStorePath(), "utf-8");
    const store = JSON.parse(raw) as HindsightStore;
    if (store.version === 1 && Array.isArray(store.patterns)) {
      return store;
    }
  } catch {
    // File doesn't exist yet
  }
  return { ...DEFAULT_STORE, patterns: [] };
}

export async function saveStore(store: HindsightStore): Promise<void> {
  const dir = getStoreDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(getStorePath(), JSON.stringify(store, null, 2), "utf-8");
}

export async function addPattern(pattern: HindsightPattern): Promise<HindsightStore> {
  const store = await loadStore();
  store.patterns.push(pattern);
  // Deduplicate by summary+type — keep the one with higher confidence
  const seen = new Map<string, HindsightPattern>();
  for (const p of store.patterns) {
    const key = `${p.type}::${p.summary.toLowerCase()}`;
    const existing = seen.get(key);
    if (!existing || p.confidence > existing.confidence) {
      seen.set(key, p);
    }
  }
  store.patterns = [...seen.values()];
  // Sort by confidence desc, then by createdAt desc
  store.patterns.sort((a, b) => b.confidence - a.confidence || b.createdAt.localeCompare(a.createdAt));
  // Trim to max 100 patterns
  if (store.patterns.length > 100) {
    store.patterns = store.patterns.slice(0, 100);
  }
  await saveStore(store);
  return store;
}

export async function getRelevantPatterns(context: string, minConfidence = 0.3): Promise<HindsightPattern[]> {
  const store = await loadStore();
  const ctx = context.toLowerCase();
  return store.patterns.filter((p) => {
    if (p.confidence < minConfidence) return false;
    if (!ctx) return true; // no context filter
    return (
      p.summary.toLowerCase().includes(ctx) ||
      p.tags.some((t) => t.toLowerCase().includes(ctx)) ||
      p.context.toLowerCase().includes(ctx)
    );
  });
}

export async function getAllPatterns(): Promise<HindsightPattern[]> {
  const store = await loadStore();
  return store.patterns;
}

export async function deletePattern(id: string): Promise<boolean> {
  const store = await loadStore();
  const before = store.patterns.length;
  store.patterns = store.patterns.filter((p) => p.id !== id);
  if (store.patterns.length !== before) {
    await saveStore(store);
    return true;
  }
  return false;
}

export function formatPatternsAsPrompt(patterns: HindsightPattern[]): string {
  if (patterns.length === 0) return "";
  const lines = patterns.map(
    (p, i) =>
      `${i + 1}. [${p.type}] ${p.summary}` +
      (p.detail ? `\n   ${p.detail}` : "") +
      `\n   (confidence: ${(p.confidence * 100).toFixed(0)}%)`,
  );
  return `\n\n---\n[Hindsight Lessons (learned from past sessions)]\n${lines.join("\n")}\n---\n`;
}
