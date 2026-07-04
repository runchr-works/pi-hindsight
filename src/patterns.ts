// ---------------------------------------------------------------------------
// Pattern Types — what pi-hindsight learns and persists
// ---------------------------------------------------------------------------

export type PatternType =
  | "effective-strategy"  // something that worked well
  | "anti-pattern"        // something to avoid
  | "preference"          // user preference (e.g., "uses tabs not spaces")
  | "common-error"        // recurring mistake
  | "workflow";           // common command sequence

export interface HindsightPattern {
  id: string;
  type: PatternType;
  summary: string;
  detail: string;
  tags: string[];
  confidence: number;       // 0.0 ~ 1.0
  successCount: number;
  failCount: number;
  context: string;          // brief context like language/framework/project type
  createdAt: string;        // ISO-8601
  lastApplied: string | null;
  sourceSession: string;    // pi session name or ID
}

export interface HindsightStore {
  version: number;
  patterns: HindsightPattern[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HindsightConfig {
  maxPatterns: number;
  minConfidence: number;
  autoInject: boolean;
}
