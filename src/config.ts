/**
 * Configuration for pi-hindsight reflection provider/model.
 * Stored at ~/.pi/agent/extensions/hindsight/config.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface HindsightConfig {
  /** Provider ID for reflection calls (e.g. "openai", "anthropic"). Omit to use Pi default. */
  provider?: string;
  /** Model name for reflection calls (e.g. "gpt-4o-mini"). Omit to use Pi default. */
  model?: string;
  /** Enable auto-reflection after each agent run */
  autoReflect: boolean;
  /** Minimum confidence for pattern injection (0.0-1.0) */
  minConfidence: number;
}

const DEFAULT_CONFIG: HindsightConfig = {
  autoReflect: true,
  minConfidence: 0.3,
};

function getConfigDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "extensions", "hindsight");
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export async function loadConfig(): Promise<HindsightConfig> {
  try {
    const raw = await readFile(getConfigPath(), "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: HindsightConfig): Promise<void> {
  const dir = getConfigDir();
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

export function buildProviderArgs(config: HindsightConfig): string[] {
  const args: string[] = [];
  if (config.provider) args.push("--provider", config.provider);
  if (config.model) args.push("--model", config.model);
  return args;
}
