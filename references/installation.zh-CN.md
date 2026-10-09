# 安装、自检、更新与回退

[English](installation.md) · [返回首页](../README.zh-CN.md)

本版支持 Windows，固定 Node 24.19.0 和 ACP 0.65.1。可独立安装，不要求本机有作者的其他技能。使用者必须先安装 ZCode 并登录自己的 Coding Plan。

## 1. 准备环境

确认 node.exe --version 输出 v24.19.0，并让 npm.cmd 使用同一套 Node。缺少 Node 时先安装对应版本。安装器会拒绝未验证的平台与 Node 版本，不会自动降低锁定要求。

从本项目公开仓库或源码 ZIP 取得本项目。路径可以含中文、空格，也可以在非系统盘。解压后的目录必须保留；安装器记录它的绝对位置。

在源码目录执行：

```powershell
npm.cmd ci --prefix runtime --ignore-scripts --no-audit --no-fund
node.exe scripts/setup.mjs
```

依赖由 npm 按锁文件下载，安装器本身不下载依赖、不接触凭据内容。首次联网安装失败应处理网络或 npm 错误，不删除锁文件、不替换成其他代理引擎。

## 2. 路径与登录

默认检查当前用户 LocalAppData/Programs/ZCode 和系统 Program Files 下的安装位置。自定义盘符不进行全盘扫描，请指定：

```powershell
node.exe scripts/setup.mjs --zcode-bin 'D:/Apps/ZCode/resources/glm/zcode.cjs'
```

账号由 ZCode 原生环境管理，请先在 ZCode 中登录。provider_config.json 是可选的自定义供应商配置，使用内置 Coding Plan 时可以不存在；它不是登录凭据文件。--provider-file 仅用于显式指定已存在的该类配置，不用于转移账号。默认路径跟随原生 ZCODE_HOME；未设置时使用 HOME 或当前用户目录下的 .zcode。不要把令牌粘贴进聊天、config.json 或 Git，也不要复制别人的登录文件。

路径优先级为：本次安装参数 > runtime/config.json > ZCODE_NATIVE_BIN / ZCODE_NATIVE_PROVIDER_FILE 环境变量 > 自动发现。相对 config.json 的路径以 runtime 目录解析；安装参数中的相对路径以当前 shell 目录解析，建议使用绝对路径。

## 3. Codex 技能入口

新安装默认使用当前用户的 .agents/skills/codex-zcode-tandem，与 [OpenAI 官方技能说明](https://learn.chatgpt.com/docs/build-skills) 的用户级发现目录一致。已有旧版 CODEX_HOME/skills/codex-zcode-tandem（未设 CODEX_HOME 时为 .codex/skills）会复用，避免重复。两个位置都有同名技能时明确报错，不自动删除。可显式指定技能父目录：

```powershell
node.exe scripts/setup.mjs --skills-dir 'D:/MySkills'
```

自定义目录需要由 Codex 的技能发现配置覆盖；常规用户直接用默认目录。兼容旧布局可用 --codex-home 指定 Codex 配置根目录，入口写入其 skills 子目录；两个路径参数不能同时使用。

已有同名技能时，默认停止且不覆盖。确认是本次需要更新的入口后，添加 --replace；安装器先生成 SKILL.md.backup-*，保留同目录其他文件。

若源码本身就在该技能目录中，安装器不会覆盖原始 SKILL.md。其他位置采用轻量入口，指向源码和本次运行的 Node。目录或 Node 位置改变后重新执行安装命令，不能继续使用旧指针。

## 4. 自检和真实连接

只检查本地环境、不写任何文件：

```powershell
node.exe scripts/setup.mjs --check
```

`--check` 读取文件元数据、锁定 ACP 和本树上次成功 probe 的缓存，不启动 CLI、不重新计算 SHA256、不写文件。没有基线显示 `not_verified`；`metadata_unchanged` 不能证明源码相同。

桌面自动更新或怀疑兼容性变化时，执行 `node.exe scripts/setup.mjs --doctor`。它重新读取桌面产品版本、CLI `--version`、ACP 版本和原生入口 SHA256，比较旧基线但不刷新它。版本号相同而 SHA 不同仍报告 `changed`，建议运行 probe；不隐式联网、升级或阻断普通任务。

成功且安装身份稳定的 probe 将连接配置与身份写入本源码目录的 `work/native-identity.json`；失败、清理未确认或安装变化不会刷新通过基线。缓存不读取凭据。自定义布局找不到相邻 `ZCode.exe` 时桌面版本为 null，并说明原因。

ACP 0.65.1 没有受支持的 Windows 跳过入口，POSIX 登录探针失败仍显示 `ACP_LOGIN_SHELL_FALLBACK`。查看 `environment.toolPaths`，用项目工具的绝对可执行文件或已安装 dispatcher 检查继承环境；不要改 SHELL 或注入 Bash 来消除警告。

通过仅代表路径、版本和依赖存在，不证明登录、额度或原生连接。用无模型推理的 probe 验证：

```powershell
New-Item -ItemType Directory -Path work -Force | Out-Null
$probe = @{
  action = 'probe'
  cwd = (Get-Location).Path
  model = 'GLM-5.3'
  thought = 'max'
  mode = 'build'
  timeoutSeconds = 60
  progressFile = (Join-Path (Get-Location).Path 'work/probe-progress.json')
  resultFile = (Join-Path (Get-Location).Path 'work/probe-result.json')
}
$probe | ConvertTo-Json | Set-Content -LiteralPath work/probe-request.json -Encoding utf8
node.exe runtime/run-task.mjs work/probe-request.json
```

查看 result 中 status=completed、正确的 Coding Plan 模型、thoughtEffective=max、modeEffective=build 和 cleanup。探针不证明实际推理额度充足，首次真实任务仍检查工具、回合与结果。

## 5. 更新与回退

先暂停并读回活动任务，保留其会话标识和结果。更新源码后执行 npm ci，再运行 setup --check、setup --replace 和 probe。已有 config.json 的路径和调优值会保留；仅实际变化的配置或入口才生成备份，重复安装不反复备份。

回退时停止新版本调用，恢复保留的旧源码和对应锁文件，再恢复原入口备份或对旧源码重新安装。不要用旧版本接管仍运行的新版本会话。卸载技能只涉及已生成入口；源码、业务文件和 ZCode 登录资料不由安装器自动删除。

## 常见问题

| 情况 | 处理 |
| --- | --- |
| 找不到 zcode.cjs | 指定真实 ZCode 安装目录中的 resources/glm/zcode.cjs |
| 没有 provider_config.json | 内置 Coding Plan 可以没有此文件；用 probe 检查真实连接，账号问题在 ZCode 中处理 |
| ACP 版本不对或缺依赖 | 按当前锁文件重新 npm ci |
| 原生版本不同或 probe 失败 | 保留错误，核对当前 ZCode 版本；不把路径自检视为兼容通过 |
| 已有同名技能 | 核实目标后用 --replace；原入口会备份 |
| 已安装但 Codex 未显示 | 重新加载技能或重启 Codex，核对标准发现目录和实际使用的配置根目录 |
| 配额不足 | 等待或由使用者处理自己的订阅，禁止自动切换付费渠道 |

公开版安装名为 codex-zcode-tandem；已有 zcode-native 入口会保留，不会自动迁移。源码移动或 Node 路径变化后，需要重新安装入口。
