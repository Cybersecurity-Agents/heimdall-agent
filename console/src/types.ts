import type { NodeDetails, Publication } from "../../src/shared/observer-contract";
import type { WorkspaceStrategy } from "./lib/workspace";
import type { TaskStatus } from "../../src/shared/task-status";

export type Campaign = {
  status?: string;
  queued?: number;
  running?: string[];
  finished?: number;
  pending?: string[];
  done?: string[];
  retry_wait?: string[];
  unfinished?: string[];
  task_states?: Record<string, TaskStatus>;
  codes?: string[];
  total?: number;
  synced?: number;
  error?: string;
};

export type SolvePreset = {
  id: string;
  label_zh?: string;
  label_en?: string;
  hint_zh?: string;
  hint_en?: string;
  workspace_strategy?: WorkspaceStrategy;
  loop_direct_codes?: string[];
};

export type ProjectProgress = {
  done?: number;
  total?: number;
  live?: number;
};

export type Project = {
  id: string;
  name: string;
  note?: string;
  task_count?: number;
  progress?: ProjectProgress;
  campaign?: Campaign;
  settings?: Record<string, number | string>;
  workspace_strategy?: WorkspaceStrategy;
  solve_presets?: SolvePreset[];
};

export type Task = {
  id: string;
  name: string;
  kind?: string;
  url?: string;
  code?: string;
  workspace?: string;
  project_id?: string;
};

export type TokenRow = {
  id?: string;
  code?: string;
  project_id?: string;
  name?: string;
  role?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  calls?: number;
  total_tokens?: number;
};

export type Tokens = {
  total?: TokenRow;
  projects?: TokenRow[];
  unassigned?: TokenRow[];
  challenges?: TokenRow[];
  models?: TokenRow[];
};

export type WorkspaceItem = { id: string };

export type PromptSlot = { name: string; zh?: string; en?: string };

export type PromptItem = {
  id: string;
  group?: string;
  title_zh?: string;
  title_en?: string;
  inject_zh?: string;
  inject_en?: string;
  path?: string;
  content?: string;
  injected?: boolean;
  exists?: boolean;
  kind?: string;
  using_default?: boolean;
  resettable?: boolean;
  slots?: PromptSlot[];
};

export type GraphNode = NodeDetails & {
  source?: "system";
  id: string;
  label?: string;
  group?: string;
  sub?: string;
  status?: string;
  coverage?: string;
  later?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type GraphEdge = {
  from: string;
  to: string;
  dashes?: boolean;
  tone?: string;
};

export type GraphPayload = {
  publication: Publication;
  schemaVersion?: number;
  width?: number;
  height?: number;
  view?: { nodes?: GraphNode[]; edges?: GraphEdge[] };
};

export type ObserverRecap = {
  status: "pending" | "running" | "published" | "failed" | "disabled";
  reason: "flag_accepted" | "succeeded" | "timeout";
  terminal: boolean;
  error?: string;
};
