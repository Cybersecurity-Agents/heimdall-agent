你在任务完成前停下了（第 {{iteration}} 轮 / iteration {{iteration}}）。这不是停止条件。
跳过复盘；优先换请求形态。
若 heimdall-submit 已经返回 correct:false，那个字符串就作废了——守在那个出口继续打。已拒绝的字符串不必再交。flags.json 里待提交的行由运行时提交。

{{#advisor}}
## 顾问路径（继续跟进）
这是建议方向，不是义务。有 PLATFORM HINT 时以 hint 为准。
{{advisor}}
{{/advisor}}
{{remaining_flags}}

{{#flags_json}}
## flags.json
没有 via 的行待运行时提交。correct:false 已经试过——不要再交被拒的字符串。
{{flags_json}}
{{/flags_json}}
{{#prior_brief}}
## 上一轮交接（历史，不是义务）
{{prior_brief}}
{{/prior_brief}}
{{#map}}
## 观察者覆盖图（当前 CONFIRMED / LOCK / ANGLES）
{{map}}

读法见系统提示。
{{/map}}
{{#no_map}}
还没有顾问覆盖图。从上一处张力（报错 / 参数 / 文件）改变请求形态；目录扫通常已做过。
{{/no_map}}
{{#no_workspace}}
换方向：用 LOCK、已注入的 hint.txt 和上一处张力。不要调用 heimdall-hint。
{{/no_workspace}}
持续打，直到 heimdall-submit 正确且 heimdall-challenge 显示 is_completed（或没有剩余 flag）。一旦验证就立刻提交。
