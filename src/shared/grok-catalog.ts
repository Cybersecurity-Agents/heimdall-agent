import type { ModelRecord, Profile } from "./model-capabilities.js";

export const XAI_HOSTS = ["api.x.ai", "us.api.x.ai"] as const;

// Checked against docs.x.ai on 2026-10-07. Keep aliases exact and provider-scoped.
// The reasoning guide says xhigh on pre-4.6 models is treated as high, even though
// some model cards list it as accepted. Expose the effective levels, not aliases.
export const GROK_PROFILES: Record<string, Profile> = {
  grok: { adapter: "grok", levels: ["low", "medium", "high", "xhigh"], aliases: { minimal: "low", max: "xhigh" } },
  "grok-4.5": { adapter: "grok", levels: ["low", "medium", "high"], aliases: { minimal: "low", xhigh: "high", max: "high" } },
  "grok-4.3": { adapter: "grok", levels: ["off", "low", "medium", "high"], aliases: { minimal: "low", xhigh: "high", max: "high" } },
  "grok-default": { adapter: "reasoning-default", levels: ["high"] },
  "grok-redirect-low": { adapter: "grok", levels: ["low", "medium", "high"], aliases: { minimal: "low", xhigh: "high", max: "high" } },
  "grok-non-reasoning": { adapter: "grok", levels: ["off"] },
};
const record = (id: string, profile: string, contextWindow: number, aliases: string[] = [], extra: Partial<ModelRecord> = {}): ModelRecord => ({
  provider: "xai", id, profile, contextWindow, aliases, input: ["text", "image"],
  protocols: ["openai-responses", "openai-completions"], ...extra,
});
export const GROK_MODELS: ModelRecord[] = [
  record("grok-4.7", "grok", 500000),
  record("grok-4.6", "grok", 500000),
  record("grok-4.5", "grok-4.5", 500000, ["grok-4.5-latest", "grok-build-latest"]),
  record("grok-4.3", "grok-4.3", 1000000, ["grok-4.3-latest"], { maxTokens: 30000 }),
  record("grok-build-0.1", "grok-default", 256000, ["grok-code-fast-1", "grok-code-fast", "grok-code-fast-1-0825"]),
  record("grok-4.20-0309-reasoning", "grok-default", 1000000, [
    "grok-4.20-reasoning-latest", "grok-4.20", "grok-4.20-reasoning", "grok-4.20-0309", "grok-4.20-beta-0309-reasoning",
    "grok-4.20-beta", "grok-4.20-beta-0309", "grok-4.20-beta-latest", "grok-4.20-beta-latest-reasoning", "grok-4.20-beta-reasoning",
    "grok-4.20-experimental-beta-0304-reasoning", "grok-4.20-experimental-beta-0304", "grok-4.20-experimental-beta-reasoning-latest",
    "grok-4.20-experimental-beta-latest", "grok-4.20-reasoning-gv2",
  ]),
  record("grok-4.20-0309-non-reasoning", "none", 1000000, [
    "grok-4.20-non-reasoning", "grok-4.20-non-reasoning-latest", "grok-4.20-beta-non-reasoning", "grok-4.20-beta-latest-non-reasoning",
    "grok-4.20-experimental-beta-0304-non-reasoning", "grok-4.20-experimental-beta-non-reasoning-latest", "grok-4.20-beta-0309-non-reasoning", "grok-4.20-non-reasoning-gv2",
  ]),
  // The dedicated multi-agent guide explicitly excludes client-side function tools.
  record("grok-4.20-multi-agent-0309", "grok", 1000000, [
    "grok-4.20-multi-agent", "grok-4.20-multi-agent-latest", "grok-4.20-multi-agent-beta-latest", "grok-4.20-multi-agent-experimental-beta-0304",
    "grok-4.20-multi-agent-experimental-beta-latest", "grok-4.20-multi-agent-beta-0309",
  ], { protocols: ["openai-responses"], supportsTools: false }),
  // Retired slugs still resolve upstream. Keep their documented reasoning defaults.
  ...["grok-4-1-fast-reasoning", "grok-4-fast-reasoning", "grok-4-0709"].map(id => record(id, "grok-redirect-low", 1000000, [], { maxTokens: 30000, defaultThinking: "low" })),
  ...["grok-4-1-fast-non-reasoning", "grok-4-fast-non-reasoning", "grok-3"].map(id => record(id, "grok-non-reasoning", 1000000, [], { maxTokens: 30000 })),
];
