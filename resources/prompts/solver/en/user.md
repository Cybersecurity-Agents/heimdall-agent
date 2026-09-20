# Task
{{task_lines}}

{{#advisor}}
## Advisor path (suggestion, not a duty)
{{advisor}}
{{/advisor}}
{{#loop_rotated}}
- Dedicated loop slot. The platform instance rotated. Reuse the method, not the host. Probe the addresses in input.json before exploiting again.
{{/loop_rotated}}
{{#loop_direct}}
- Dedicated loop slot. Start from container_addr in input.json; brief / LOCK are suggestions only.
{{/loop_direct}}
{{#loop_from_loop}}
- Dedicated loop slot. The previous job was also a loop — continue that work, same as a Pi-timeout handoff. Scored flags stay scored. Do not restart from the public site. Read prior_brief, the coverage map, and flags.json. brief / LOCK are suggestions; new evidence or PLATFORM HINT may change direction.
{{/loop_from_loop}}
{{#loop_same}}
- Dedicated loop slot. The last regular attempt timed out. Prefer continuing brief / LOCK / the last tension with a new shape, not recon from zero. Brief / LOCK are suggestions; new evidence or PLATFORM HINT may change direction.
{{/loop_same}}
{{#direct}}
- Engagement: direct URL (not a TSec bench instance)
- Scope is only the addresses above.
- No platform scoreboard. Submit a flag found in target evidence with heimdall-submit (or write it to flags.json for automatic recording). A local receipt ends this task; it does not claim platform verification. Preserve the evidence and reproduction steps.
{{/direct}}
{{#hint}}
## PLATFORM HINT (runtime-injected; this direction is correct)
{{hint}}
Authoritative. Beats LOCK and brief. Prefer the same class as the hint. This block is the full hint.
{{/hint}}
{{#flags_json}}
## flags.json
Rows with no via are pending; the runtime submits them. correct:false rows were already tried — do not resubmit rejected strings. Stay on the same sink.
{{flags_json}}
{{/flags_json}}
{{#obligation}}
## Observer direction (suggestion)
{{obligation}}
{{/obligation}}
{{#map}}
## Coverage map (current CONFIRMED / LOCK / ANGLES)
{{map}}

The current `<heimdall-map>` wins over the brief and any older ANGLES you already read.
{{/map}}
{{#map_notice}}
Later `system` turns replace `<heimdall-map>`; see the system prompt for how to read it.
{{/map_notice}}
{{#handoff}}
## Handoff (control plane)
{{handoff}}
{{/handoff}}
{{#prior_brief}}
## Prior handoff (history, not a duty)
{{prior_brief}}
{{/prior_brief}}
{{#closing_multi}}
This challenge has {{flag_count}} flags; scored {{scored}}, remaining {{remaining}}. heimdall-submit each one as soon as it verifies, then hit the next hop. Stay on this turn until is_completed; a failed postmortem is not a stop.
{{/closing_multi}}
{{#closing_one}}
This challenge has 1 flag. heimdall-submit as soon as it verifies. Stay on this turn until is_completed; a failed postmortem is not a stop.
{{/closing_one}}
{{#closing_unknown}}
Start. heimdall-submit as soon as a flag verifies. Then heimdall-challenge for remaining flags. Stay on this turn until is_completed; a failed postmortem is not a stop.
{{/closing_unknown}}
