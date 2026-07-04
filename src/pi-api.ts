// Minimal type stubs for Pi Extension API

export interface AgentMessage {
  role: "user" | "assistant" | "tool";
  content: string | unknown;
}

export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
}

export interface BeforeAgentStartEventResult {
  systemPrompt?: string;
}

export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
}

export interface TurnEndEvent {
  type: "turn_end";
  turnIndex: number;
  message: AgentMessage;
}

export interface SessionStartEvent {
  type: "session_start";
  reason: "startup" | "reload" | "new" | "resume" | "fork";
}

export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason: "quit" | "reload" | "new" | "resume" | "fork";
}

export interface ToolCallEvent {
  type: "tool_call";
  toolName: string;
  input: Record<string, unknown>;
}

export type ExtensionCommandContext = { args?: string };

export interface ExtensionAPI {
  on(event: string, handler: (...args: any[]) => any): void;
  registerCommand(name: string, opts: {
    description: string;
    handler: (ctx: ExtensionCommandContext) => Promise<void> | void;
  }): void;
  registerTool(tool: Record<string, unknown>): void;
  sendMessage(msg: { customType: string; content: string; display?: string }): void;
  sendUserMessage(content: string, opts?: { deliverAs?: "steer" | "followUp" }): void;
  setSessionName(name: string): void;
  exec(cmd: string, args: string[], opts?: Record<string, unknown>): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
