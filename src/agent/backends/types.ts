import type { EventSink } from "../../shared/events.js";

export type AgentRunResult = {
  backend: string;
  ok: boolean;
  exitCode: number;
  error?: string | null;
  retryable?: boolean;
  turns?: number;
  toolUses?: number;
  messages?: number;
  fallbackFrom?: string | null;
  extra?: Record<string, unknown>;
};

export type BackendRunOpts = {
  systemPrompt: string;
  userPrompt: string;
  workspace: string;
  permissionMode: string;
  maxTurns: number;
  model: string | null;
  events: EventSink;
  resume?: string | null;
  continueConversation?: boolean;
  signal?: AbortSignal;
  /** Native Claude goal condition. Omit for one-shot auxiliary queries. */
  goal?: string;
};

export type Backend = {
  name: string;
  run(opts: BackendRunOpts): Promise<AgentRunResult>;
  close?(): Promise<void> | void;
  maybeCompact?(threshold?: number): Promise<boolean> | boolean;
};
