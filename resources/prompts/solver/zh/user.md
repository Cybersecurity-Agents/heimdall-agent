# 任务
{{task_lines}}

{{#advisor}}
## 顾问路径（建议，不是义务）
{{advisor}}
{{/advisor}}
{{#loop_rotated}}
- 这是一个专属 loop 槽位。平台实例已轮换。复用方法，而不是主机。再次利用前先探测 input.json 里的地址。
{{/loop_rotated}}
{{#loop_direct}}
- 这是一个专属 loop 槽位。从 input.json 的 container_addr 开打；brief / LOCK 只是建议。
{{/loop_direct}}
{{#loop_from_loop}}
- 这是一个专属 loop 槽位。上一轮也是 loop，按 Pi 超时续跑同样接进度。已得分的 flag 仍然有效，不要从公网站重开。先读 prior_brief、覆盖图和 flags.json。brief / LOCK 只是建议；新证据或 PLATFORM HINT 可以换方向。
{{/loop_from_loop}}
{{#loop_same}}
- 这是一个专属 loop 槽位。上一次常规尝试超时了。优先接着 brief / LOCK / 上一处张力换形态，而不是从零侦察。brief / LOCK 只是建议；新证据或 PLATFORM HINT 可以换方向。
{{/loop_same}}
{{#direct}}
- 任务模式：URL 直连，范围仅限上述地址。
- 无平台判分。找到有目标证据支持的 flag 后调用 heimdall-submit，或写入 flags.json 由工具自动记录。本地记录后结束任务，不代表已通过平台验证；保留证据和复现步骤。
{{/direct}}
{{#hint}}
## PLATFORM HINT（运行时已注入，这个方向是对的）
{{hint}}
权威方向，高于 LOCK 和 brief。优先沿 hint 同类推进。本块已是完整 hint。
{{/hint}}
{{#flags_json}}
## flags.json
没有 via 的行是待提交的，运行时会提交它们。correct:false 的行已经试过——已拒绝的字符串不必再交。守在同一个出口继续打。
{{flags_json}}
{{/flags_json}}
{{#obligation}}
## 观察者方向（建议）
{{obligation}}
{{/obligation}}
{{#map}}
## 覆盖图（当前 CONFIRMED / LOCK / ANGLES）
{{map}}

以当前 `<heimdall-map>` 为准；brief 与自己读过的旧 ANGLES 让路。
{{/map}}
{{#map_notice}}
后续 `system` 轮次会替换 `<heimdall-map>`；读法见系统提示。
{{/map_notice}}
{{#handoff}}
## 交接（控制面）
{{handoff}}
{{/handoff}}
{{#prior_brief}}
## 上一轮交接（历史参考，不是义务）
{{prior_brief}}
{{/prior_brief}}
{{#closing_multi}}
本题有 {{flag_count}} 个 flag，已计分 {{scored}}，剩余 {{remaining}}。每验证出一个就立刻 heimdall-submit，再打下一跳。在 is_completed 之前继续本轮；复盘失败不算停止。
{{/closing_multi}}
{{#closing_one}}
本题有 1 个 flag。一验证出来就立刻 heimdall-submit。在 is_completed 之前继续本轮；复盘失败不算停止。
{{/closing_one}}
{{#closing_unknown}}
开始。一验证出来就立刻 heimdall-submit。然后用 heimdall-challenge 看是否还有剩余 flag。在 is_completed 之前继续本轮；复盘失败不算停止。
{{/closing_unknown}}
