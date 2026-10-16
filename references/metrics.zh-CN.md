# 用量与复审统计

[English](metrics.md) · [返回首页](../README.zh-CN.md)

请求中的每条提示可以填写 `phase`：`implementation`、`review`、`repair`、`validation` 或 `other`。未填写时归入 `other`；自动首审归入 `review`。一条普通纠偏消息不会被自动当成一次修复。

```json
{"label":"修复边界条件","phase":"repair","text":"根据已确认的问题修复，并运行已批准的检查。"}
```

`result.metrics`、`progress.metrics` 与 `summary.metrics` 来自同一份统计。`total` 是全部已结束提示回合，`stages` 按明确填写的阶段分组，`turns[].metrics` 保留每回合数据。`elapsedMs` 是本地从发出提示到收到结果的时间，包含等待和工具执行；失败或取消的回合也有记录。

Token 只读取对应 ACP `PromptResponse.usage`。`reportedByField` 表示该字段有多少回合提供了有效数字：例如总共 3 回合、只有 2 回合上报 `totalTokens`，汇总就只覆盖这 2 回合，不能称为全任务账单。缺失或非法值为 `null`，有效的 0 保留为 0。输入 Token 不包含缓存读取与写入，缓存字段单独记录，不再重复加算。

新版原生 `turnState` 通知没有回合 ID，也会在压缩上下文时触发。客户端只订阅一个别名，把它作为会话忙闲提示，不把通知中的用量或 `turnMs` 归给当前提示。因此 `nativeTurnMs` 暂为 `null`。后台工作流角色的用量不在前台提示账单覆盖范围内；账号额度快照也不是任务账单。

`firstPass` 的已修复/未解决问题数量来自模型首审声明，标记为 `model_reported`。首审后继续纠偏会使该声明失效。没有采集总控发现数时，`controllerFindings` 保留为 `null`，不会据此计算质量提升率。
