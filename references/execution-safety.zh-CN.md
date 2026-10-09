# 工作区保护与可信交接

## 1.2 额度摘要

`summary.quotaSnapshots.before/after` 与 `action=quota` 的 `summary.quota` 展示 GLM provider 状态、窗口 remainingPercent/usedPercent、UTC resetsAt 和原始毫秒 nextResetTime。缺失或非法值为 null；成功 ACP 响应可能包含 auth_error、rate_limited 或 unavailable，完整原始响应保留在 resultFile。共享额度不是任务账单；上游未提供手动重置次数，本技能不推算或触发重置。

一次任务完成，只说明模型回合结束。能否合入，还要看它改了哪些文件，以及测试究竟跑出了什么结果。

## 先把责任写进请求

编辑和执行工具现在需要 `workspace`。路径相对 `cwd`；目录包含其子目录。`preservedPaths` 优先于 `ownedPaths`，Git 元数据不可编辑。符号链接和 Windows junction 按实际目标检查。

```json
{
  "workspace": {
    "ownedPaths": ["src/cache", "tests/cache.test.mjs"],
    "preservedPaths": ["src/cache/controller-notes.md"],
    "commands": ["git status --short", "node --test tests/cache.test.mjs"]
  },
  "allowToolKinds": ["read", "search", "edit", "execute"]
}
```

`commands` 逐字匹配完整 Bash 命令，不能只填写 `node` 或 `git` 这样的前缀。总控先检查脚本、参数和实际效果；不要批准运行时拼出的任意脚本。未列出的命令会被拒绝，需要换命令时重新准备请求。受保护路径约束适用于文件工具，不能限制已批准脚本内部的写入。

常见的直接 `git stash/reset/clean/switch/checkout/restore/worktree` 调用也会被拒绝。独立基线和 worktree 由总控准备。别把“先收起所有改动”当成测试准备的一部分。

这是权限回调检查，不是操作系统沙箱，也不是完整 Shell 解析器。原生自动允许的工具、恢复会话、后台角色可能不发回调。客户端还会比对完成的工具事件：观察到违规会标记 needs_attention 并停止后续计划阶段，但事后观察不能撤销已经发生的效果。需要隔离的修改应放到独立 checkout。不要把外部 MCP 工具或脚本执行误认为受文件路径策略约束。

## 保留测试执行器的真实结果

继续使用项目已有的测试执行器。先准备一个输入文件：

```json
{
  "name": "cache regression",
  "cwd": "C:/projects/example",
  "command": ["C:/tools/node.exe", "--test", "tests/cache.test.mjs"],
  "candidateFiles": ["src/cache/store.mjs", "tests/cache.test.mjs", "package-lock.json"]
}
```

先运行 `node scripts/check-evidence.mjs prepare SPEC.json PREPARED.json`，再用现有执行器直接运行同一 argv，最后运行 `node scripts/check-evidence.mjs inspect PREPARED.json RECEIPT.json`。文件名应每次独立，回执留在项目的本地工作目录。

准备文件绑定命令、目录、时间及声明输入的 SHA-256。`candidateFiles` 必须包括本次结论依赖的源码、测试和配置；未列入的文件不在验证范围内。不要在测试以后补做准备文件。先执行，再单独筛选日志；不要把 `test | grep ...; echo done` 当成测试命令。

支持现有 `codex-bounded-command` schema 2 回执，但无需安装它。其他执行器可提供下面的通用格式，字段必须取自执行器，不能让模型根据日志猜填：

```json
{
  "kind": "tandem-command-receipt", "version": 1,
  "cwd": "C:/projects/example",
  "command": ["C:/tools/node.exe", "--test", "tests/cache.test.mjs"],
  "startedAt": "2026-10-07T01:00:00.000Z",
  "finishedAt": "2026-10-07T01:00:02.000Z",
  "exitCode": 1, "outcome": "fail", "outputTruncated": false
}
```

任务请求中的 `verification` 可写入 `[{"preparedFile":"绝对路径","receiptFile":"绝对路径","failureClass":"unclassified"}]`。`failureClass` 可选 `product`、`fixture`、`environment`、`known_baseline`；它说明失败归属，不改变失败结果。旧基线同样失败，也不能标绿。

没有回执是 `not_run`，输入变化是 `stale`，命令或时间不匹配是 `invalid`，输出截断是 `incomplete`。只有全部声明检查通过，汇总才是 `pass`。这些本地文件是可审阅记录，不具备防篡改或第三方签名保证。

## 把长任务拆成能纠偏的阶段

按任务需要设置 `prompts`：方案/兼容性、实现、测试、自审。每个阶段应有连贯产出，不要拆成每条命令一次调用，也不要把一小时工作全部塞进第一回合。纠偏在当前前台回合结束后、下一计划阶段之前串行执行。

控制记录保留 `submittedAt`、`acceptedAt`、`startedAt`、`completedAt`。`queueDurationMs` 是提交到开始，`executionDurationMs` 是开始到结束；两者不要混为响应延迟。排队超过默认五分钟，在进度中显示 `waiting_for_foreground_boundary`，不额外调用模型。暂停后的未执行消息保留 rejected，不自动重放。

新版进度同时记录 runtimeRoot。控制入口必须来自该目录；对于旧版没有目录绑定的进度，继续用原来的 control.mjs。只读 status 仍可跨版本查看。升级可准备并行版本目录，让新的调用使用新版，旧调用继续原目录，禁止热替换运行中的文件。

## 启动诊断与紧凑结果

ACP 0.65.1 的环境探针使用 POSIX 的 `-l -c env -0`。当 SHELL 指向 PowerShell/pwsh 时可能失败并继承当前环境；这里保留上游 stderr，同时报告 `ACP_LOGIN_SHELL_FALLBACK`。没有改写上游依赖或全局 PATH。原生会话成功只证明引擎能启动，项目 Python、构建工具仍要检查。子进程显式使用 Python UTF-8，避免中文输出受本机 GBK 默认值影响。

`summaryFile` 可指定单独摘要文件，包含状态、测试结论、最近控制记录和证据边界；详情继续留在 `resultFile`。`previewTruncated` 表示单回合预览只保留前 2000 字符，兼容旧字段 `truncated`。`evidence.*Truncated` 才说明对应完整记录的保留边界。未统计的传输字节是 `null`。

权限相关的输入在日志压缩前单独保留，文件内容不会占用这份记录。若仍超出预算，摘要记录 unverifiedToolScopes 并要求检查，不把未知输入说成已确认的违规。

`quotaSnapshots: true` 可在前后各读取一次共享账号额度。不可用时明确记录 unavailable；不后台轮询，不自动付费切换，不把共享额度变化称为精确任务账单，也不从回复字数推算 token。

## 按改动选择验证

- 修改缓存语义：检查已有热缓存、新建冷缓存，以及失效后的重算；只测空缓存可能漏掉真实问题。
- 修改 DOM、安全转义或可见文本：需要时用真实浏览器确认；手写 fixture 的转义错误先修 fixture，不据此改动正确产品逻辑。
- 隔离目录缺文件、漏应用补丁、子进程编码错误：先核对总控准备和执行环境，不能直接归因为原生模型或业务代码缺陷。

这些提示只在相关改动中使用，不要求每个任务跑浏览器或全套回归。
