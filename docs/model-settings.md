# Model settings

Settings → Models configures Pi Solver and Claude Loop independently. For native xAI setup and Grok-specific mappings, see [Grok models](grok-models.md). Connection details, reasoning capabilities and token capacities are separate. The saved effective configuration shows the requested and mapped thinking levels, capability source, catalog version and context source. It describes the outgoing configuration, not proof that a gateway honors it.

Saving applies to new jobs. Running jobs keep their environment. Console overrides persist under `data/console/llm.yaml` and take precedence over `tools.env.yaml`. Blank tuning fields restore defaults; blank credential fields keep existing credentials. Invalid LLM settings leave the previous LLM configuration unchanged.

## Adding a new model without a code update

1. Enter the **exact API model ID**, endpoint and credentials. Slashes, colons and `[1m]` suffixes are preserved; they do not imply capabilities or capacity.
2. Select a compatible **capability profile** based on the provider's documented contract. For example, a future DeepSeek version can reuse `deepseek` if its thinking protocol is unchanged. This is an explicit choice; Heimdall does not assume that a future model supports a protocol because its name looks similar.
3. Configure context and output limits from the new model's documentation. Reusing a reasoning profile does **not** inherit the previous model's token capacities.
4. Save and inspect the effective configuration. Test the provider when appropriate. HTTP 200 alone cannot establish whether reasoning parameters were honored.

For a hypothetical new model with the existing DeepSeek contract:

```yaml
HEIMDALL_AGENT_MODEL: "vendor/deepseek-v4.2:preview"
HEIMDALL_CAPABILITY_PROFILE: "deepseek"
HEIMDALL_THINKING: "max"
# Set these only after confirming the new model's capacities:
HEIMDALL_CONTEXT_WINDOW: ""
HEIMDALL_MAX_OUTPUT_TOKENS: ""
```

The example ID is illustrative, not a claim that this model is available. Loop uses the corresponding `HEIMDALL_LOOP_*` keys and requires an Anthropic-compatible endpoint.

## Profiles and thinking semantics

| Profile | Contract |
|---|---|
| `deepseek` | Chat Completions: `thinking.type` + `reasoning_effort`; Anthropic: `thinking.type` + `output_config.effort`. Native levels off/low/high/max; minimal→low, medium→high, **xhigh→high**. |
| `thinking-toggle` | `thinking.type` enabled/disabled. `high` denotes enabled; no graduated effort parameter is sent. |
| `anthropic-budget` | Anthropic `thinking.type=enabled` with `budget_tokens`; no effort field. |
| `claude-adaptive` | Anthropic adaptive thinking with `output_config.effort`. Reusable profile permits low/medium/high/xhigh/max; select a catalog-specific profile or custom profile to restrict levels. |
| `grok` | Native Grok Responses `reasoning.effort` or Chat Completions `reasoning_effort`. low/medium/high/xhigh, max→xhigh, cannot disable. Use the catalog for older models. |
| `grok-default` | Reasoning is always enabled by the model; omit effort and thinking controls (Grok Build / 4.20). |
| `openai-effort` | Chat Completions `reasoning_effort` or Responses `reasoning.effort`, including `none` when off. Select only if the provider documents this contract. |
| `none` | Omit reasoning controls. |
| `custom` | A validated JSON profile using one of the above adapters. No executable configuration. |

Auto uses exact catalog records. It distinguishes toggle-only Kimi/GLM models from models with effort levels. Models that cannot disable thinking reject an off selection. Budget and adaptive profiles reject incompatible settings and protocols. Solver defaults to high, Loop to max, mapped to the chosen profile. When a requested level is unsupported, an explicit alias takes priority; otherwise the next supported level, or highest available level, is selected and shown in the saved preview.

Unknown models in auto mode **omit reasoning controls**. Choose a profile to enable them. `REASONING=true` alone cannot declare a wire protocol. A manual profile is marked **manual**, an exact scoped record **catalog**, an exact ID on an unidentified gateway **catalog-unverified**, and an unrecognized ID **unknown**. Aliases match only within the selected provider namespace or a recognized official hostname. `HEIMDALL_CAPABILITY_PROVIDER` is separate from Pi's provider registration and the API protocol.

Custom profile example:

```json
{"adapter":"deepseek","levels":["off","low","high","max"],"aliases":{"minimal":"low","medium":"high","xhigh":"high"}}
```

The final request adapter applies the selected contract for the main model across Pi SDK, Pi RPC and Claude SDK, including compaction requests. It retains paths, authentication, streaming and upstream error responses; requests for a different small model retain their own controls. It does not retry rejected parameters by silently dropping them.

## Versioned capability catalog

The initial catalog combines pinned Pi metadata with current [Grok metadata](grok-models.md) and an explicit DeepSeek-V4.1-Flash record: official ID `deepseek-flash`, context 1,000,000 and output capacity 384,000. `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are provider-scoped aliases. The request model ID is never replaced by the canonical catalog ID.

Aggregator gateways often serve these vendors under display-cased IDs. Catalog IDs fold case when the match is unique, so `GLM-5.3`, `Kimi-K3` and `DeepSeek-V4.1-Flash` resolve on an unidentified gateway without manual settings. Checked against vendor docs on 2026-10-16:

- **GLM-5.3 / GLM-5.3-Flash** (zai): 1M context, 128K max output; reasoning always on, `reasoning_effort` low/high/max; `thinking.type` only supports `enabled`. `glink/GLM-5.3:glink_domestic` is a provider-scoped alias.
- **Kimi K3** (moonshotai): 1M context; reasoning always on, top-level `reasoning_effort` low/high/max (default max).
- **DeepSeek-V4.1-Flash** (deepseek): 1M context, 384K max output; effort mapping minimal→low, medium→high, xhigh→high, plus `max` above high.

These records map onto the `deepseek` adapter so both wire contracts work: Chat Completions (`thinking.type` + `reasoning_effort`) and Anthropic Messages (`thinking.type` + `output_config.effort`).

Sources for that record:
- <https://api-docs.deepseek.com/quick_start/pricing>
- <https://api-docs.deepseek.com/guides/thinking_mode>
- <https://docs.z.ai/guides/llm/glm-5.3> (GLM-5.3 capacities and reasoning parameters)
- <https://platform.moonshot.cn/docs/guide/kimi-k3> and <https://platform.kimi.com/docs/guide/use-reasoning-effort.md> (Kimi K3 context and reasoning_effort)

Expand **Capability catalog** in Settings to view/export the current state, import JSON, refresh from a chosen HTTPS URL or roll back. There is no background refresh or default external source. Import/refresh expects the `active` catalog document from `GET /api/llm-catalog`, not the surrounding state/history object. Example catalog shape:

```json
{
  "schemaVersion": 1,
  "version": "my-catalog-2",
  "profiles": {
    "deepseek": {"adapter":"deepseek","levels":["off","low","high","max"],"aliases":{"medium":"high","xhigh":"high"}}
  },
  "models": [
    {"provider":"example","id":"exact-model-id","aliases":["alias-in-this-provider"],"profile":"deepseek","contextWindow":128000,"maxTokens":32768}
  ]
}
```

Imports replace the complete active catalog. For routine updates, export `active`, edit it and give it a new version. Schema validation and compatibility checks against saved Solver/Loop settings finish before activation. Versions are immutable. The cache under `data/console/model-capabilities.json` retains five prior versions. Failed downloads, validation failures and concurrent update conflicts leave the active version unchanged. HTTPS refresh is bounded to 96 KiB and 15 seconds and does not follow redirects. Model records can additionally specify `input` modalities, `protocols`, `supportsTools` and `defaultThinking`. New wire protocols require adapter code; new IDs, aliases, capacities or supported levels use catalog data only.

At launch, local and Docker runners save the catalog to `.heimdall/model-capabilities.json` in the workspace and pass its contents to the child environment. Existing workspaces, including resumed jobs, keep that snapshot. A catalog refresh or rollback affects new workspaces only. To adopt a new catalog for an old task, start a new workspace. Direct agent CLI usage uses the bundled catalog unless `HEIMDALL_CAPABILITY_CATALOG` contains a validated snapshot.

## Context, output and compaction

Pi uses exact catalog context metadata; unknown models use a visibly marked **128,000-token fallback**. Its default output cap is at most 32,768, limited further by the catalog and context size. Claude leaves native/unknown defaults to its SDK unless overridden; recognized third-party capacity is passed through the window override. Custom capacities configure local accounting, not upstream limits. Explicit output caps also constrain the outgoing request.

Auto compaction defaults to 70%. Pi reserves `ceil(context × (100 − threshold) / 100)` tokens and retains the smaller of 250,000 tokens or 25% of context. Claude uses its own summary retention strategy. Validation checks integer ranges and room for input, output and thinking. Disabling compaction disables Pi's automatic and post-turn mechanisms, including RPC, or sets Claude's `DISABLE_AUTO_COMPACT`.

**Migration:** older versions stripped prefixes/colon suffixes and removed `[1m]` from GLM IDs; those transformations are removed. Replace any old shorthand with the provider's exact accepted model ID. `[1m]` no longer declares a local 1M context. Previously unknown models received guessed reasoning fields; choose an explicit profile if the endpoint supports reasoning. Fixed token budgets now require the `anthropic-budget` profile. Known profile/protocol mismatches are rejected and need an explicitly compatible profile.

## Environment reference

Use `HEIMDALL_` for Solver and `HEIMDALL_LOOP_` for Loop:

| Suffix | Values / default |
|---|---|
| `CAPABILITY_PROFILE` | Blank/auto, catalog profile ID, or custom |
| `CAPABILITY_PROVIDER` | Optional catalog namespace, e.g. deepseek / anthropic / moonshotai / zai |
| `CAPABILITY_CUSTOM` | JSON profile when selection is custom |
| `THINKING` | off/minimal/low/medium/high/xhigh/max; mapped by profile |
| `THINKING_MODE` | auto/adaptive/enabled/disabled; validated against profile |
| `THINKING_BUDGET` | Budget profile only; integer ≥1024 leaving ≥1024 for answer |
| `CONTEXT_WINDOW` | Blank/auto or 8192–10000000 |
| `MAX_OUTPUT_TOKENS` | Blank/auto or 1024–1000000, within catalog/context limits |
| `COMPACT_ENABLED` | true (default) / false |
| `COMPACT_PCT` | 10–90; default 70 |
| `COMPACT_KEEP_RECENT_TOKENS` | Pi recent-history budget below trigger |
| `REASONING` | auto/true/false; cannot substitute for a capability profile |

Pi's `HEIMDALL_LLM_API` selects anthropic, openai (Chat Completions), or responses; blank/auto infers from URL. Official xAI global/US hosts select Responses. Observer shares the Loop connection by default but has independent tuning via `HEIMDALL_COACH_*`, avoiding leaked Claude budgets. Startup events include a credential-free `effective_config`. SDK upgrades still require transport compatibility checks; catalog data cannot fix SDK protocol changes.
