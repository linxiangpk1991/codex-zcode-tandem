# 默认独立复审、修复与验证

开发任务写完代码后，会自动进入下面的流程。它由执行器调度，不依赖模型记住提示，也不需要启用 `nativeWorkflow` 或复制工作流示例。

1. 新建原生审查会话，传入原始需求、后续纠偏、候选文件和检查信息。审查者不继承开发者的对话，只能使用读取和搜索工具。
2. 如有具体范围内缺陷，交回原开发会话修复。原有文件归属、禁止效果和权限继续生效。
3. 执行已授权的检查，或读取仍有效的真实回执。修复改变输入后重新准备输入哈希并验证；不重跑未受影响的通过检查。
4. 修复后再用新会话独立复核。最多两轮修复，未解决问题会阻止交付。

只读查询、额度和连接探针不进入此流程。需要修改文件的普通请求、续接请求，以及声明了负责路径的命令/后台工作流请求均默认进入。不能通过 `delivery: false` 关闭它。同会话自审仍可用于开发途中，但不能替代最后的独立复审。

## 准备验证

总控先审查项目现有测试的实际效果，准备命令、源码、测试与配置输入：

```json
{
  "name": "editor save",
  "cwd": "C:/projects/example",
  "command": ["C:/tools/node.exe", "--test", "tests/editor.test.mjs"],
  "candidateFiles": ["src/editor.mjs", "tests/editor.test.mjs"],
  "userPaths": ["edit-save-refresh"]
}
```

运行 `node.exe scripts/check-evidence.mjs prepare SPEC.json PREPARED.json`，然后在开发请求中声明：

```json
{
  "delivery": {
    "candidateFiles": ["src/editor.mjs", "tests/editor.test.mjs"],
    "userPaths": ["edit-save-refresh"],
    "visualReview": "controller"
  },
  "verification": [{
    "preparedFile": "C:/projects/example/work/check-prepared.json",
    "receiptFile": "C:/projects/example/work/check-receipt.json",
    "execute": true,
    "timeoutSeconds": 120
  }]
}
```

`execute: true` 是对该准确检查的执行授权。入口在模型开始前锁定完整 argv、cwd、输入和功能路径；之后修改准备文件不能换成其他命令。可执行文件必须为绝对路径，检查目录必须是任务 cwd，不接受 Shell 管道包装。每项检查默认 120 秒，范围 1..600 秒，也受整个任务剩余时限约束。执行器保存真实退出码和有界输出，取消时清理自己启动的进程树。该路径适合本地测试；需要服务、端口租约、外部写入或宿主专用控制时继续使用已有执行器，不用本字段绕过相应规则。

原有外部执行器回执仍支持：省略 execute 即不授予自动执行权限。环境只能由总控使用时，由总控运行检查；缺失/失败/过期结果保持不可交付，不生成假回执。模型不能手填回执。确实不适用运行测试的文档任务可声明 `validation: "not_applicable"` 并给出具体理由，不能借此跳过声明的功能路径。

准备文件和回执文件自动受编辑保护，即使位于 ownedPaths 内也不授予模型编辑权限。导入回执在调用开始时绑定内容；调用中被修改后须由总控用 handoff 显式读回。启动前已经存在的回执属于总控提供的可信输入，应先核实来源；本工具不为任意外部 JSON 提供签名认证。只复用已确认来源、输入未变的通过结果。

## 状态与恢复

`qualityLoop` 展示当前 reviewing/repair/validation 阶段、各次独立审查的 sessionId、原开发 sessionId、结果文件、用量以及检查结果。每个审查会话都有独立记录。父会话 metrics 不包含子审查用量，按需读取 `qualityLoop.reviews[].metrics`。

| delivery.status | 含义 |
| --- | --- |
| needs_review | 审查未完成、证据不全、文件变化或中断 |
| changes_requested | 仍有未解决的审查问题 |
| awaiting_validation | 真实验证缺失、失败、过期或未覆盖功能路径 |
| ready_for_controller_review | 独立复审与声明验证就绪，可进入总控最终验收 |
| not_applicable | 本次是普通只读等无需开发交接的操作 |

原生调用 `completed` 不代表可交付；交付未就绪时 CLI 返回 4。暂停会连同独立审查一起取消并等待清理；续接只处理剩余开发工作，再自动独立审查。审查后的纠偏会重新触发审查，旧记录不会覆盖。总控补齐原请求指定的回执后，可只读运行 `node.exe scripts/check-evidence.mjs handoff RESULT.json` 重新判定，不改写旧报告。

## 仍由总控负责的判断

新会话有独立上下文及更窄的原生工具配置，但不是操作系统沙箱，也不能保证模型不漏检。执行器检查全部声明文件的实际读取证据、候选哈希、会话身份与真实验证结果；它不能从一份声明判断审查深度。候选范围和测试选择仍需总控负责。

GLM 做代码和功能检查，浏览器功能以 DOM、请求/响应和持久化读回为依据。截图、排版与视觉效果由具备视觉能力的总控或人验收。`visualReview: "controller"` 始终保留 `pending_controller`。

升级只影响新调用；旧任务继续用其 runtimeRoot。旧版同会话首审报告不会被新执行器提升为已完成独立复审。
