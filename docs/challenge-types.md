# 工作区类型与调度类型一致性

本次通过代码和隔离测试确认了类型传递缺陷。检查时仓库没有 `config.yaml`、`workspace_strategy.yaml` 或运行台账，因此这里不把代码复现结果当作某个运行实例的现场诊断。

## 原因

原来的两条路径使用不同的数据来源：

- 项目界面按任务的 `workspace` 或项目的 `workspace_strategy` 展示类型。
- 调度的排序、内网限额、直入 loop、超时和镜像读取 `Config.type_*`。全局默认是 `all`。

已有的 `projectSolveOverlay` 只转换项目策略，没有加入任务单独指定的 workspace；空规则还会继承全局规则、等级映射。恢复任务时只覆盖工作区路径和项目 ID，遗漏项目类型策略。

启动过程又出现两次重新分类：`prepareWorkspace` 不接收已选类型，`imageFor(cfg, challengeType, code)` 在有题号时忽略 `challengeType`。手动选择靠 `pinChallengeWorkspace` 临时修改内存中的 `type_overrides` 衔接，控制器重启后这个修改消失。此前保存的 goal 也可能没有最终解析出来的类型。

因此，“工作区显示 pwn，调度仍按 all 处理”可能影响镜像、按类型设置的超时、内网并发限制和是否直接进入 loop，不只是显示问题。

## 修复后的规则

`src/shared/workspace-strategy.ts` 统一前后端规则解析及导出转换：题号不区分大小写，精确题号优先，然后按顺序匹配前缀/正则，最后使用项目默认类型。别名统一使用 `canonicalType`。

项目调度先加载项目策略与保存的任务 workspace。固定任务类型覆盖项目策略；`auto` 使用项目策略。项目的空规则和 `all` 默认值也会生效，不再混入全局 `type_*`。同题号在不同项目中可以有不同类型。

执行入口在同步平台信息之后、资源准入之前确定类型，并将同一结果传给：

- 作业记录中的 `challenge_type`、镜像和资源准入；
- 工作区模板、`.heimdall/challenge_type`、`input.json`；
- 按类型选择的超时、loop 上下文及运行环境；
- goal 的 `runOptions.challengeType`，用于后续重试。

显式启动参数仍可覆盖本次类型。手动选择不再修改共享配置；显式重新启动会按当前配置重新确定类型。重启恢复也会加载项目策略与项目超时等设置，兼容没有保存类型的旧 goal。

镜像仍允许 `images.rules` 显式覆盖；未命中时使用已经解析的类型。`images.rules: []` 现在确实表示没有题号镜像规则。

## 独立 daemon 的配置

没有项目上下文的独立 daemon 使用全局 `types`。默认 `all` 是有效配置，不能从多个项目里猜一个类型。需要 TSec 预设时可在配置中设置 `types.preset: tsecbench-v1`，也可导出一个项目的策略：

```bash
bin/heimdall export-strategy --project <项目ID> --out workspace_strategy.yaml
```

导出的是项目策略；任务单独指定的 workspace 如需用于独立 daemon，应写入导出文件的 `types.overrides`。策略文件放在 `config.yaml` 同目录，或通过 `HEIMDALL_WS_STRATEGY_FILE` 指定。加载器兼容导出的 `types` 格式、界面的 workspace 规则格式和包含 `workspace_strategy` 的格式。

构建后重启使用旧代码的 console/daemon，后续启动和恢复会使用修复逻辑。修复不改写历史作业记录。

## 验证

`test/challenge-types.test.ts` 覆盖界面/调度/导出结果一致性、项目隔离、固定任务类型参与排序和内网资源限制、直入 loop、镜像和超时一致性，以及新控制器恢复旧任务。执行测试使用本地临时数据、模拟 runner 和本地验收，无需连接目标或调用模型。
