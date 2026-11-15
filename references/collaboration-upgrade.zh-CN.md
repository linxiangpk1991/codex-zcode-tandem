# 新版协作能力

本轮适配 ZCode 桌面 3.18.2.10443、CLI 0.17.1 和 ACP 适配器 0.85.3。ACP 适配器是社区项目，与 ZCode 桌面的版本号不同。

## 运行中提出修改

总控可以在任务执行时发送 `steer`。`priority: "now"` 请求尽快纠偏；原生引擎也可能把它排到安全边界。`priority: "next"` 明确排队。`ask` 仍然作为独立的后续回合执行。

```json
{"action":"steer","priority":"now","message":"补充要求：空输入必须返回明确错误，不要修改接口签名。"}
```

提交成功只表示命令进入收件箱。进度中的 `controls` 记录接收与处理，`steering.events` 记录原生回复。排队消息使用真实 `turn.steerDrained` 事件、输入标识和完整文本哈希关联；结果未知时不会自动重发。送达也不代表代码正确，最后仍需要复审和真实验证。

开发任务默认执行：实现 → 新会话独立审查 → 原会话修复 → 运行已授权检查 → 新会话复核。最多两轮修复。后续纠偏会使旧复审失效；未解决的问题、未知的纠偏结果或缺少验证都会阻止交接。

## 多问题与多选答案

原生 `AskUserQuestion` 现在可以一次交来多道题。进度会显示 `pendingInput.format: "form"`、准确的 `interactionId` 和 `schema`。总控按实际字段回答，不能猜选项或把普通回答用于计划审批。

```json
{"action":"answer","interactionId":"复制当前问题标识","answers":{"q_0":"Windows","q_1":["JSON","Markdown"]}}
```

保存为命令文件后，用 `node.exe runtime/control.mjs PROGRESS.json ANSWER.json` 提交。也可把答案对象保存到文件，使用 `--action answer --interactionId ID --answers-file answers.json`。旧的单选 `optionId` 方式继续有效。错误类型、未提供的选项、过期问题和重复答案会被拒绝；暂停会取消等待，不会代选答案。

## 在正确的 worktree 中继续

由总控选择或创建 worktree，把绝对路径作为请求的 `cwd`。运行器记录真实目录、Git worktree 元数据目录、分支和 HEAD，并在后续回合和交接前核对。普通未提交文件不会触发分支身份错误；运行期间切换分支或提交新 HEAD 则需要重新建立调用。

续接时，把上一份可信结果的 `workspaceBinding` 原样放进新请求，同时提供原 `sessionId` 与 `cwd`。这样可以在恢复前发现目录或基线已经变化。没有传入旧绑定时，检查从本次调用开始，不声称已经证明历史会话的目录身份。非 Git 目录只绑定真实目录，不自动初始化仓库。

## 把视觉判断交给能看图的总控

GLM 文本开发会话可以检查 DOM、交互状态、日志和测试结果。页面是否美观、截图是否符合设计，仍由有视觉能力的总控判断。

```json
{"delivery":{"candidateFiles":["src/page.tsx"],"userPaths":["signup"],"visualReview":"controller","visualArtifacts":["artifacts/signup-desktop.png","artifacts/signup-mobile.png"]}}
```

截图路径相对任务目录，可使用 PNG、JPEG 或 WebP。结果中的 `visualEvidence` 记录绝对路径、大小、SHA-256 和被复审候选的哈希。路径越界、文件缺失或后续变化不能得到有效交接。`pending_controller` 表示需要总控看图；文件哈希和功能测试都不代表视觉已经通过。

## 验证范围

已在 Windows 原生任务中验证：运行中要求进入 ZCode；独立审查发现预置缺陷；原开发会话修复；真实检查通过；第二个独立会话复核后交接。另一个原生任务完成了两题表单，保留单选及两个多选值。

工作目录变化、重复/过期答案、权限与问答隔离、截图变化、认证来源限制和失败回合判定由针对性回归覆盖。这些记录不代表任意项目已经通过验收，也不代表其他操作系统已经获得支持。
