# Contributing / 参与贡献

[Home](README.md) · [中文首页](README.zh-CN.md)

## English

Start with a reproducible problem or a concrete documentation correction. An issue explaining the user outcome is useful before a broad runtime change. English and Chinese are both welcome.

Use Windows and Node 24.19.0. Install the pinned dependencies with `npm.cmd ci --prefix runtime --ignore-scripts --no-audit --no-fund`, then run `npm.cmd test --prefix runtime`. Offline tests do not require an account. Native checks require your own signed-in ZCode; label their results separately.

Keep changes focused. Preserve installer idempotency, invocation ownership, model/permission checks and exact workflow bindings. Add a regression test when changing behavior, and update the corresponding English/Chinese page when user-facing behavior changes. Never fix a failure by silently relaxing a pin or switching inference providers.

A pull request should explain the problem, changed behavior, checks actually run and remaining limits. Do not include runtime/config.json, logs, .env files, credentials, full sessions, private source or local installation pointers. The public skill name stays separate from personal variants.

Read [architecture](references/project-map.md) for module ownership. The project uses MIT; contributions are submitted under the same license. Generated artwork is described in [asset credits](assets/README.md).

## 简体中文

欢迎从可以复现的问题或具体文档修正开始。较大的运行逻辑改动，建议先用 Issue 说明用户遇到什么问题。中文、英文都可以。

使用 Windows 和 Node 24.19.0。按锁文件运行 `npm.cmd ci --prefix runtime --ignore-scripts --no-audit --no-fund`，再执行 `npm.cmd test --prefix runtime`。离线测试不需要账号；原生验证需要自己的 ZCode 登录，请分开说明结果。

保持改动聚焦。保留安装幂等性、调用归属、模型与权限检查、工作流精确绑定。行为变化要有相关回归测试；用户可见变化要更新对应中英文文档。不要通过放宽版本锁定或切换推理渠道掩盖失败。

PR 说明问题、变化后的行为、实际执行的检查和剩余限制。不要提交本机配置、日志、环境文件、凭据、完整会话、私人源码或安装指针。公开版技能名与个人变体保持独立。

模块责任见[项目结构](references/project-map.zh-CN.md)。项目采用 MIT，贡献也按同一许可证提交。生图资产来源见[图片说明](assets/README.md)。
