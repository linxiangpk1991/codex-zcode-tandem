[English](delivery.md)

# 交回前先审、修复和验证

ZCode 写完代码后，先读取最终差异，检查原始要求、调用方、失败分支和测试，再修正发现的问题。Codex 接收的是经过这一轮整理的候选；它仍负责独立审查和最终验收。

## 派发实现任务

`action=run` 中启用 `edit`，或为执行命令/原生工作流声明了 `workspace.ownedPaths` 的请求，会自动追加 `tandem:first-pass-review`。只读查询、额度和连接探针不会追加。这个阶段在所有原有提示之后执行，沿用现有权限和总时限，没有额外授权。旧的自审提示可以保留为中途检查，也可以移除以节省重复工作。

在原请求里添加：

```json
{
  "delivery": {
    "candidateFiles": ["src/editor.ts", "tests/editor.test.ts"],
    "userPaths": ["edit-save-refresh"],
    "validation": "required",
    "visualReview": "controller"
  },
  "verification": [
    {
      "preparedFile": "C:/projects/example/work/save-prepared.json",
      "receiptFile": "C:/projects/example/work/save-receipt.json"
    }
  ]
}
```

`candidateFiles` 是相对项目根目录的具体文件，不接受目录、通配符或越界路径。包含本次首审需要覆盖的源码、测试和配置；删除的文件也可列入，审查其删除差异。漏填时仍会进入首审，但不能得到可交付状态。

`userPaths` 给功能流程起稳定名字。没有用户交互的任务可省略。给 `check-evidence.mjs prepare` 的原有 SPEC 增加同名 `userPaths`，测试通过后相应流程才算有验证记录。名字和覆盖范围必须由总控检查；给单测改个名字不能证明真实浏览器或业务流程通过。

验证继续由项目已有工具执行。SPEC 里的 `candidateFiles` 绑定该检查依赖的实际输入，运行前 prepare，运行后 inspect。回执必须来自执行器，不能由模型按照文字总结填写。没有涉及行为的说明文字修改，可以使用 `validation: "not_applicable"` 并填写具体 `validationReason`；不能据此跳过声明的功能路径或掩盖失败检查。

## 首审具体检查什么

- 先验证最短的核心使用流程，再扩大到其他模块。保存功能至少覆盖打开、编辑、实际提交、响应和刷新后的读回。
- 核对真实差异与接入点。组件已经写好不等于已注册，接口函数通过测试不等于表单发出了正确字段。
- 修正后重新查看改动，只重跑依赖变化的检查；复用仍然有效的通过结果。
- 失败先区分产品、测试/fixture、环境和已证实的基线问题。连续两次同因失败且没有新证据时，诊断原因或交回阻塞，不无限重试。
- 无命令权限或无法访问验证环境时，如实标待验证。总控提供执行结果后，再修复其中的实际缺陷。

自动首审会要求实际读代码的工具记录以及结构化 `tandem-review` 声明，记录已修复和未解决的问题，并绑定完成时的候选内容。执行器能检查阶段、内容绑定和回执，不能从一份声明证明审查足够深入，也不能保证模型没有漏检。

## 功能与视觉分工

GLM-5.3 可以读取页面元素、网络请求和测试输出，适合做浏览器功能检查。页面是否协调、截图是否符合设计、图片是否合适，由总控中具备视觉能力的模型或人判断。`visualReview: "controller"` 始终报告 `pending_controller`；功能检查通过不会把视觉验收一并标绿。本功能不自动切换模型；模型有视觉能力，也不等于当前 ACP 会话已经提供可用的图片理解工具。

## 读取状态和恢复

| `delivery.status` | 总控接下来做什么 |
| --- | --- |
| `needs_review` | 补齐首审或候选范围；检查暂停、首审后纠偏、内容变化和证据缺口 |
| `changes_requested` | 处理首审里尚未解决的问题 |
| `awaiting_validation` | 运行缺少的验证，或修复失败/过期的检查 |
| `ready_for_controller_review` | 开始独立审查；需要视觉验收的仍由总控完成 |
| `not_applicable` | 本次是未声明交付检查的操作，不能拿来证明实现已验收 |

`status: completed` 保留“原生调用结束”的含义；交付未就绪时 CLI 返回 **4**。原有 1/2/3 仍分别表示错误、超时/取消和暂停。接入脚本要适配退出码 4，不能把它当成需要重跑全部任务的原生引擎崩溃。

若总控补齐了原请求指定位置的验证回执，只读检查即可，无需再调用模型：

```powershell
node.exe scripts/check-evidence.mjs handoff C:/projects/example/work/result.json
```

此命令使用结果里保存的交付声明，重新检查当前文件和回执，不修改旧结果。返回 0 才表示可交给总控复审，4 表示仍有缺口。不要改写旧报告来消除问题。

暂停后用原 `sessionId` 续接未完成工作，并重新传入同一所有权、候选范围和验证要求。执行器会追加新的最终首审，不必重放完成的实现。首审后收到新的纠偏，即使文件没变，也需要核对新的要求。已启动的原生后台工作必须完成，不能拿管理命令 `workflow-resume` 的结束状态代替交付；随后发起带交付声明的 `run` 做最终首审。

升级不修改旧调用。控制旧任务继续用其记录的 `runtimeRoot`；新版只承接新的调用。
