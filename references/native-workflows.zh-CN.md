# 原生工作流

[English](native-workflows.md) · [返回首页](../README.zh-CN.md)

并行角色、依赖汇合、持久节点结果或恢复有实际收益时使用。顺序工作可只用同会话阶段包。编写脚本前读 ZCode 的 dynamic-workflows 技能，沿用原生接口。

## 审查与绑定

审查完整脚本、角色责任及每条 world.run 命令。按准确 UTF-8 字节算 SHA-256，绑定规范模型标识。脚本变化后，总控在既有授权范围内重新审查。

修订还需 workflowRunId 指向前序运行。恢复会话可能不触发权限回调；同时检查 workflowObservations 的脚本、模型、目标，以及 permissions 中实际回调。观察不能回滚已经执行的工具，也不是沙箱。

附加字段示例：

```json
{
  "nativeWorkflow": true,
  "waitForBackground": true,
  "approvedWorkflowSha256": "准确的SHA-256",
  "approvedWorkflowModel": "account:bigmodel-individual-coding-plan/GLM-5.3$max",
  "prompts": [
    {
      "label": "launch",
      "requiredTools": ["CreateWorkflow"],
      "text": "读取 dynamic-workflows，按已审查路径和 GLM-5.3$max 调用 CreateWorkflow。返回标识并结束本回合，由客户端等待后台。"
    },
    {
      "label": "readback",
      "requiredTools": ["GetWorkflowRun"],
      "text": "读回已结束运行，报告原生结果、测试、独立审查和风险。不要重放工作。"
    }
  ]
}
```

另需 cwd、model、thought=max、build 模式、工具范围、输出路径和时限。一个工作流的角色共用绑定模型。角色上下文独立，但提示词中的只读声明不是工具隔离；需要强制只读时限制实际工具。只允许声明的角色，不递归扩展。

## 运行与恢复

一次调用管理一个工作流；修订保留前序身份，观察后继后以其为当前运行。下一次修订使用新请求、新前序绑定。

ACP sessionId 与 workflowRunId 不同。实时控制仅操作当前会话、目录中的绑定运行。settings 只接受 1 到 4 的 maxConcurrency，用原生 run-caps-changed 事件确认。

中断后先用 action=workflow-status、原 sessionId/cwd 读回。action=workflow-events 另加 workflowRunId、afterSequence；通过上游管理方法查询，无需推理。根据 nextAfterSequence、hasMore、truncated 取后续日志。

action=workflow-resume 必须提供准确会话、目录和运行，只恢复原生标为可恢复的停止、取消或失败运行，拒绝重放已完成运行。节点结果可复用；未知外部效果仍需读回，不宣称恰好执行一次。

## 通知边界与修订

CLI 0.16.9 的管理恢复可能不生成总结通知。该动作不允许附带下一条前台提示，可在原生日志达到终态后返回 notificationDisposition=not_observed_no_foreground_handoff；backgroundNotificationFinished 仍为 false，不声称完成交接。

普通启动/读回阶段仍要求原生终态与通知回合均结束；通知失败作为错误处理。

修订沿用原对话，绑定已审查的新脚本、模型和前序运行，要求实际 AmendWorkflow。检查缓存命中与节点事件；复用缓存不等于测试重跑。

不启用全局恢复、无人值守调度或付费回退。[验收说明](acceptance.zh-CN.md) 列明实测范围。
