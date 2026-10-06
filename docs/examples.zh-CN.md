# 三个实际使用场景

[English](examples.md) · [返回首页](../README.zh-CN.md)

下面是任务表达方式，不是性能测试结果。请替换为真实项目、路径和测试命令。第一次使用时，建议先在一个小型试验项目里跑通。

## 1. 修复一个可以复现的问题

在 Codex 中说：

> $codex-zcode-tandem 搜索框把全空格当成有效关键词了。让 ZCode 在搜索模块修复，并补一个回归测试。保持 API 格式不变，先检查并保留已有修改。你负责复核实际 diff 和测试输出，再判断是否完成。

Codex 应先看项目，确定负责文件和现有测试命令，再把这些背景交给 ZCode。要拿回的是实际改动、相关测试结果和未解决问题。

执行中可以继续补充：

> 问一下 ZCode 已经检查了哪些输入情况。
>
> 保留原来的报错文案，只调整空值识别。

前一句是排队追问，后一句是排队纠偏。两者都不能改变已经开始的工具调用。要看完成回执，才能确认要求已处理。

## 2. 找一个独立会话审查

> $codex-zcode-tandem 让一个新的 ZCode 会话对照最初的导出需求，审查当前 diff。只读，重点看日期边界和漏行问题。给出文件位置与触发输入，不修改代码、不执行 shell 命令。

把原始要求和真实候选交给审查者，使用独立会话、工具限制和明确范围。Codex 再逐项判断发现是否成立。静态审查不能证明测试已经运行。

## 3. 拆开工作，同时保留最后的集成

例如，一个改动包含相互独立的输入标准化、输出格式化，以及依赖两者的集成测试：

> $codex-zcode-tandem 准备一个原生 ZCode 工作流：一个角色负责输入标准化，一个负责输出格式化；测试节点等待两者完成，再让独立角色审查实际候选。开始前列清文件归属和测试命令，不得跨角色改文件或自行发布。

项目确实有可并行部分时，再用[原生工作流](../references/native-workflows.zh-CN.md)。Codex 审查脚本并绑定哈希和模型。暂停或中断后可以保留节点结果，但外部写入结果未知时，仍然要先读回，不能直接重试。

## 直接调用运行器

通常由技能准备请求。需要手动运行时，把 runtime/request.example.json 复制为 work/request.json，替换所有占位路径。这个示例只允许读取与搜索，用于只读检查。

```powershell
New-Item -ItemType Directory -Path work -Force | Out-Null
Copy-Item runtime/request.example.json work/request.json
# 编辑 work/request.json：填入绝对 cwd、progressFile 和 resultFile。
node.exe runtime/run-task.mjs work/request.json
```

任务运行时，在另一个 PowerShell 窗口查看：

```powershell
node.exe runtime/control.mjs --progress work/example-progress.json --action status
```

进度路径要与请求一致。实际产出包括进度快照、结果 JSON，以及授权任务改过的项目文件。进程退出后无法再处理追问，需要用保存的会话标识发起新请求。

阶段模板和结果字段见[委派模板](../references/worker-prompts.zh-CN.md)。
