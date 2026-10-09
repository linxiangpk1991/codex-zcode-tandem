# 项目结构与维护边界

[English](project-map.md) · [返回首页](../README.zh-CN.md)

## 数据流

run-task.mjs 读请求，经 config.mjs、request.mjs 校验后交给 runner.mjs。transport.mjs 启动 bridge.mjs，由锁定版本 ACP 调用原生 CLI 和已有 Coding Plan。

discovery.mjs 从接收者的用户目录、Windows 环境和显式配置发现路径。scripts/setup.mjs 自检并登记技能入口，不安装依赖、不复制登录资料。该版本只支持经过验证的 Windows 运行路径。

control.mjs 将命令写入本次收件箱；inbox.mjs 验证归属并消费。progress.mjs 与 jsonio.mjs 保存原子快照和结果。私有配置仅传路径，本项目不读其内容。

| 模块 | 责任 |
| --- | --- |
| runner | 配置读回、串行阶段、控制队列、问答、后台等待和统一收尾 |
| bridge | 上游实例捕获、通知边界、工作流管理接口和 PID 观察 |
| native-guards / policy | 权限校验、工具范围、脚本/模型/运行绑定 |
| workflow-observation | 核对实际工具输入，属于观察而非沙箱 |
| evidence | 限制日志体积并保留后续游标 |
| transport | 子进程、ACP 连接及有界 IPC 生命周期 |
| native-identity | 本地版本/SHA检查；成功兼容 probe 才保存本树基线，元数据快查不替代重哈希 |
| tests | 离线协议、状态、权限、恢复与清理回归 |

## 权威来源与恢复

文件看真实 diff；模型与思考强度看生效配置；工作流看原生运行和节点事件；控制命令看完成回执。心跳、end_turn、退出码不能单独证明业务完成。

调度、缓存、推理由上游负责，适配器不另造调度系统。升级先查契约和兼容连接，再做受影响的离线与原生测试，锁版本交付。

源码可放在接收者选定的目录，技能入口记录该目录及 Node 位置。直接放入 Codex 技能目录时保留原始 SKILL.md。回退前停止任务、读回效果，恢复安装器备份或已保留的旧版本；不自动回滚用户文件。

Git 仅保存源码、锁文件、示例和脱敏摘要。work、acceptance、rollback、config.json、依赖被忽略。推送不等于部署或业务验收。

## 公开版与个人版

公开版包名为 codex-zcode-tandem-runtime，技能名为 codex-zcode-tandem。另行安装的 zcode-native 有独立源码和入口，两者不自动同步、迁移路径或转移账号。需要共享的改进应明确审查后移植，不能把本机配置、执行日志或私人仓库历史带入公开版。

## 1.1 的执行证据

workspace-policy 在权限回调中检查文件归属和完整命令；verification 与 scripts/check-evidence 绑定声明的测试输入、读取已有执行器回执，不负责执行测试；reporting 提供启动诊断和紧凑摘要。模型状态与测试验收分别报告。

scope-observer 在日志压缩前保留有界的权限相关输入，将未知范围证据与确认的策略违规分别记录。

`delivery.mjs` 负责自动首审、候选内容绑定和交付状态，复用已有验证回执，不执行测试、不授予独立验收。
