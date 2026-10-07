# Changelog / 更新记录

## 1.1.0 — 2026-10-07

File tools now check ownership and preserved paths; Bash needs an exact reviewed command. Test receipts bind declared source inputs, argv, cwd and the real exit code. Steering records queue and execution time separately. Startup fallback is visible, Python children use UTF-8, and optional quota snapshots are separate from task billing. A compact summary keeps model completion separate from verification. Control commands are bound to the invocation's runtime directory. Deadline cancellation retains timeout status.

文件工具开始检查负责与保留路径，Bash 需要完整已审命令。测试回执绑定声明的源码输入、参数、目录和真实退出码。纠偏区分排队与执行时间，启动回退会明确警告，Python 子进程使用 UTF-8。可选额度快照不等于任务账单；摘要分别报告模型完成和验证结果。控制命令绑定任务的运行目录，超时取消保留 timeout 状态。

**Migration / 迁移：** existing edit/execute requests need workspace; keep using the original control entry for older running tasks. 旧的编辑/执行请求须补 workspace，仍在运行的旧任务继续使用原控制入口。See [English](references/execution-safety.md) / [中文](references/execution-safety.zh-CN.md).

Permission callbacks and completed tool observations are not an OS sandbox. 权限回调及事后工具观察都不是操作系统沙箱。

## 1.0.0 — 2026-10-07

### English

First public edition of **Codex × ZCode · Tandem**, derived from the locally verified V3.1 adapter.

- Independent repository and skill name: codex-zcode-tandem.
- Windows installer with path discovery, conflict checks, entry backup and idempotent updates.
- Native Coding Plan integration through ACP 0.65.1, with structured progress, queued feedback, ordinary questions, pauses and workflow management.
- English/Chinese documentation, task examples, FAQ, MIT license and original generated cover art.
- Separate public/personal installation targets; no automatic migration of a zcode-native entry.

This release line starts at 1.0.0. Progress protocol version 3 and older internal V3 verification references describe the inherited adapter; they are not public version numbers. See [verification](references/acceptance.md).

### 简体中文

**Codex × ZCode · Tandem** 首个公开版本，基于已在本机验证的 V3.1 适配器整理。

- 独立仓库与技能名 codex-zcode-tandem。
- Windows 安装器，支持路径发现、冲突检查、入口备份和幂等更新。
- 通过 ACP 0.65.1 使用原生 Coding Plan，支持结构化进度、排队反馈、普通问答、暂停和工作流管理。
- 中英文文档、使用场景、FAQ、MIT 许可证及原创生图封面。
- 公开版和自用版安装目标独立，不自动迁移 zcode-native。

公开版本从 1.0.0 开始。进度协议 version 3 和内部 V3 验证记录属于继承的适配器，不是公开版版本号。见[验收范围](references/acceptance.zh-CN.md)。
