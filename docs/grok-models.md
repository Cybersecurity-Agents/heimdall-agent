# Grok / xAI models

Pi SDK and Pi RPC support xAI's native **Responses API** and the legacy **Chat Completions API**. The integration includes model capabilities, exact provider-scoped aliases, effort mapping, local function tools, encrypted reasoning continuation, session resume, context accounting, compaction settings, observer injection and usage/session records. Text-and-image input capability is enabled for the listed models.

## Configure in Settings

In **Pi Solver**:

| Field | Recommended value |
|---|---|
| Base URL | `https://api.x.ai/v1` |
| Model | `grok-4.7` |
| API key | Your xAI key |
| API protocol | Responses, or Auto on the official endpoint |
| Capability profile | Auto |
| Catalog provider | Auto, or `xai` |
| Thinking | high or xhigh; max maps to xhigh |
| Context / output | Leave blank for metadata and local defaults, or set explicit limits |

`https://us.api.x.ai/v1` also selects Responses automatically. The US endpoint currently serves Grok 4.7 and 4.6; availability of other IDs is an upstream concern. Use base URLs ending in `/v1`, not full `/v1/responses` operation URLs. The host must be an exact match for automatic provider detection. On a gateway, select the protocol that gateway actually exposes and set catalog provider `xai` if its aliases follow xAI's catalog.

An Anthropic-compatible gateway such as CLIProxy (`http://127.0.0.1:8317`) can keep model `grok-4.7`, provider `xai`, and protocol Anthropic Messages. Catalog context and effort mapping stay in effect. The outgoing body uses adaptive thinking and `output_config.effort`, which the gateway translates. Official `api.x.ai` and `us.api.x.ai` hosts still reject Anthropic Messages.

Equivalent `tools.env.yaml` fields inside the existing `claude:` group (the group name is historical; this slot runs Pi):

```yaml
claude:
  ANTHROPIC_BASE_URL: "https://api.x.ai/v1"
  ANTHROPIC_MODEL: "grok-4.7"
  ANTHROPIC_API_KEY: "<your-xai-key>"
  HEIMDALL_LLM_API: "responses"
  HEIMDALL_CAPABILITY_PROFILE: "auto"
  HEIMDALL_CAPABILITY_PROVIDER: "xai"
  HEIMDALL_THINKING: "xhigh"
  HEIMDALL_CONTEXT_WINDOW: ""
  HEIMDALL_MAX_OUTPUT_TOKENS: ""
```

The console synchronizes these historical key names into Pi's connection environment. Direct agent invocations also accept `XAI_API_KEY`, `HEIMDALL_LLM_BASE_URL` and `HEIMDALL_AGENT_MODEL`.

## Model-specific behavior

Catalog version `2026-10-07.2` includes the public text/code lineup documented on October 7, 2026:

| Models | Context | Effective thinking controls |
|---|---:|---|
| `grok-4.7`, `grok-4.6` | 500,000 | low / medium / high / xhigh; minimal→low, max→xhigh; off rejected |
| `grok-4.5` | 500,000 | low / medium / high; xhigh/max→high; off rejected |
| `grok-4.3` | 1,000,000 | off / low / medium / high; xhigh/max→high |
| `grok-build-0.1` and documented `grok-code-fast*` aliases | 256,000 | Native reasoning; no guessed effort or toggle parameters |
| `grok-4.20-0309-reasoning` and documented aliases | 1,000,000 | Native reasoning; no guessed effort or toggle parameters |
| `grok-4.20-0309-non-reasoning` and documented aliases | 1,000,000 | No reasoning controls |

The official model cards list xhigh as accepted for some older models, but the reasoning guide states pre-4.6 models treat it as high. The catalog reports the effective mapping instead of implying additional depth. Grok 4.7/4.6/4.5 have no separate published text output cap in their overview pages; their local output settings still reserve input space and obey the context window. Pi defaults to at most 32,768 output tokens. Grok 4.3 retains the pinned catalog's 30,000 output cap.

The documented retired slugs `grok-4-1-fast-reasoning`, `grok-4-fast-reasoning` and `grok-4-0709` continue to resolve to Grok 4.3; their default effort is low unless explicitly configured. The non-reasoning fast slugs and `grok-3` follow their documented non-reasoning redirect. `grok-code-fast-1` follows the current model card's Grok Build 0.1 alias. Request IDs remain exactly as entered; Heimdall does not rewrite them to a replacement model.

**Multi-Agent research variants** are recognized but rejected for solver use: the dedicated official guide says they do not support client-side function calling, which Heimdall requires. This takes precedence over the generic model card's broader “Function calling: Yes” label. Grok Imagine, Voice and the non-public Grok 4.7 Fast variant are not solver models and are outside this integration.

## Claude Code SDK

Claude SDK speaks Anthropic Messages. Pointing it at the native `api.x.ai` or `us.api.x.ai` endpoint is rejected before starting a request. A valid Pi Grok configuration can still be saved while the separate Claude slot is unconfigured; Settings explains that the Loop connection needs an Anthropic-compatible endpoint.

To use Grok through Claude SDK, provide a gateway that actually offers Anthropic Messages and select its **documented capability profile** explicitly, for example `claude-adaptive` only if it accepts adaptive thinking and `output_config.effort`. Choosing a profile does not translate Responses into Anthropic. Native Grok catalog metadata is not evidence that a gateway supports these fields. The Claude SDK test covers an Anthropic-compatible Grok fixture; no native Anthropic xAI endpoint is assumed.

## Continuation and observability

Responses requests use `max_output_tokens` and `reasoning.effort`; no Chat Completions or Anthropic-only thinking fields are sent. Pi retains `store: false`, the per-session `prompt_cache_key`, and `reasoning.encrypted_content` for client-managed continuation. The adapter preserves encrypted input items without decoding them. Unsupported xAI reasoning penalties/stop settings and OpenAI-only summary/cache-retention options are removed from native requests.

The LLM tap handles `/responses` alongside existing endpoints. It injects current observer guidance into instruction messages without altering encrypted reasoning, tool calls, tool results or images. Session records display text and tool interactions; ciphertext is not rendered as prose. Usage accounting reads terminal Responses events and separates cached input from uncached input, avoiding double counting. Reasoning token usage is included in the provider's total output tokens.

Tests use the real pinned Pi SDK, Pi RPC CLI and Claude SDK against local protocol fixtures. They verify outgoing bodies, streamed tool calls, continuation, resume and accounting. They do not establish account-specific availability or live xAI behavior.

## Future Grok versions

For a new exact ID with the same native effort contract, select the `grok` profile and the appropriate protocol. Set capacities independently or add a model record to the versioned catalog. Do not guess capabilities from a name suffix. Existing workspaces keep their catalog snapshots; start a new workspace to pick up a newer catalog.

## Official references

- [Models](https://docs.x.ai/developers/models)
- [Grok 4.7](https://docs.x.ai/developers/grok-4-7)
- [Reasoning and encrypted continuation](https://docs.x.ai/developers/model-capabilities/text/reasoning)
- [Responses migration](https://docs.x.ai/developers/model-capabilities/text/comparison)
- [May 15 model retirement](https://docs.x.ai/developers/migration/may-15-retirement)
- [Multi-Agent limitations](https://docs.x.ai/developers/model-capabilities/text/multi-agent#limitations)
- [Regional endpoints](https://docs.x.ai/developers/advanced-api-usage/regions)
