# 实时控制与续接

[English](live-control.md) · [返回首页](../README.zh-CN.md)

用安装入口记录的 Node 运行源码目录下的 runtime/control.mjs PROGRESS.json COMMAND.json。任务原子写入 progressFile，记录 invocation ID、ACP session ID、进程归属及收件箱。不要手改活动进度快照。

## 控制语义

| 操作 | 生效方式 |
| --- | --- |
| status | 直接读本地快照，不推理、不打断 |
| ask / steer | 同会话排队，在安全回合边界、后续阶段之前执行 |
| pause | 取消前台并停止已绑定工作流，不撤销已完成效果 |
| answer | 仅回答普通问题的准确 interactionId 与已提供选项 |
| workflow-status / events | 获取原生状态与事件，日志按游标分页 |
| workflow-settings | 仅修改已绑定运行的 maxConcurrency，范围 1 到 4 |

心跳不等于真实进展。“已提交”不等于已执行；查看 controls.history 的完成回执和后续回合。

单个长提示没有中间提示边界；需要响应及时就划分有意义的阶段。前台纠偏不能直接改写后台角色的指令；修改目标采用已审查修订或暂停后续接。

## 命令文件

以下每行分别保存为一个 JSON 文件：

```json
{"action":"status"}
{"action":"ask","message":"说明已完成部分和当前阻碍。"}
{"action":"steer","message":"现有范围内更新要求：保留接口，调整输入校验。"}
{"action":"answer","interactionId":"准确的问题标识","optionId":"原生提供的选项标识"}
{"action":"pause"}
{"action":"workflow-status"}
{"action":"workflow-events","runId":"已绑定的运行标识","afterSequence":0}
{"action":"workflow-settings","runId":"已绑定的运行标识","maxConcurrency":2}
```

工具授权、计划审批不属于普通问答；answer 不能替代。过期答案、其他调用的问题或未提供选项会被拒绝。

结果在本次收件箱 results 子目录，回执带结果路径和截断标志。进程必须仍在运行才能处理命令。退出后用原 sessionId/cwd 发起新的有界请求，只续接未完成工作。已处理命令不重放。

## 生命周期

默认总时限 90 分钟，上限两小时。短 idleSeconds 为收尾追问保留进程，不是永久调度器。退出时清理本次拥有的后台进程。

暂停退出码为 3，有界执行器可能归为非零退出，应读取 status=paused。未知写入先读回。机器级额度恢复保持关闭，不切换付费渠道、不降低强度。只有用户要求时才配置定时跟进。
