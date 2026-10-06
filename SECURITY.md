# Security / 安全说明

## English

Tandem launches a separately installed native ZCode engine. Its model requests use ZCode's service and your account. Local execution does not mean offline inference or that no project data leaves the machine.

Tool policies, script hashes and observed workflow inputs help check scope. They are not OS isolation. Resumed native sessions may omit permission callbacks; observations after execution cannot prevent or reverse an action. Use a disposable checkout and appropriate OS/user permissions for untrusted work.

Do not post tokens, provider/login files, private code or complete session logs in public issues. For a vulnerability with sensitive details, open a minimal issue asking for a private reporting channel without publishing the exploit or affected data. Wait for the maintainer to arrange a channel. No response-time commitment is currently offered.

MIT covers this project's code. ZCode, account access and dependencies retain their own terms. The adapter does not grant authorization to publish, access credentials, alter production or act in other repositories.

## 简体中文

Tandem 启动的是另外安装的原生 ZCode，引擎请求使用 ZCode 的服务和你的账号。本地执行不代表离线推理，也不代表项目数据不会离开电脑。

工具规则、脚本哈希和实际工作流输入有助于核对范围，但不提供操作系统隔离。恢复的原生会话可能省略权限回调，执行后的观察无法预防或撤销动作。不可信任务应使用可丢弃的工作副本和适当的系统、用户权限。

不要在公开 Issue 中提交令牌、供应商或登录文件、私人代码、完整会话。涉及敏感细节的漏洞，请先提交不含利用方式和受影响数据的简短 Issue，申请私密反馈渠道，等待维护者安排。目前不承诺响应时限。

MIT 适用于本项目代码；ZCode、账号访问和依赖各自遵循原条款。适配器不授予发布、读取凭据、变更生产或操作其他仓库的权限。
