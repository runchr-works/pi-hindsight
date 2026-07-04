/**
 * Minimal type stubs for Pi Extension API.
 * These are inline type definitions matching the subset of Pi's ExtensionAPI
 * that pi-hindsight uses. No runtime dependency on @earendil-works packages.
 */

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string | unknown;
}

export interface ToolResultMessage {
  content?: unknown;
  isError?: boolean;
  toolCallId?: string;
  toolName?: string;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
}

export interface BeforeAgentStartEventResult {
  systemPrompt?: string;
}

export interface AfterProviderResponseEvent {
  type: "after_provider_response";
  status: number;
}

export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
}

export interface TurnEndEvent {
  type: "turn_end";
  turnIndex: number;
  message: AgentMessage;
  toolResults: ToolResultMessage[];
}

export interface TurnStartEvent {
  type: "turn_start";
  turnIndex: number;
  timestamp: number;
}

export interface SessionStartEvent {
  type: "session_start";
  reason: "startup" | "reload" | "new" | "resume" | "fork";
}

export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason: "quit" | "reload" | "new" | "resume" | "fork";
}

export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  reason: "manual" | "threshold" | "overflow";
}

export interface ToolCallEvent {
  type: "tool_call";
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: "tool_result";
  toolName: string;
  content: unknown;
  isError?: boolean;
}

export interface ContextEvent {
  type: "context";
  messages: AgentMessage[];
}

export interface ContextEventResult {
  messages?: AgentMessage[];
}

// ---------------------------------------------------------------------------
// Command context
// ---------------------------------------------------------------------------

export interface ExtensionCommandContext {
  args?: string;
}

// ---------------------------------------------------------------------------
// Extension API (pi parameter in factory function)
// ---------------------------------------------------------------------------

export type ExtensionHandler<E, R = void> = (event: E, ctx: Record<string, unknown>) => R | Promise<R>;

export interface ExtensionAPI {
  on(event: string, handler: (...args: any[]) => any): void;
  registerCommand(name: string, options: {
    description: string;
    handler: (ctx: ExtensionCommandContext) => Promise<void> | void;
  }): void;
  registerTool(tool: Record<string, unknown>): void;
  registerFlag(name: string, options: {
    description?: string;
    type: "boolean" | "string";
    default?: boolean | string;
  }): void;
  getFlag(name: string): boolean | string | undefined;
  sendMessage(message: { customType: string; content: string; display?: string }): void;
  sendUserMessage(content: string): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;
  setSessionName(name: string): void;
  getSessionName(): string | undefined;
  exec(command: string, args: string[], options?: Record<string, unknown>): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  setModel(model: Record<string, unknown>): Promise<boolean>;
  events: { on(event: string, handler: (...args: unknown[]) => void): void };
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
