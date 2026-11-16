# Keeping the project easy to find / 项目描述维护

[Home](../README.md) · [中文首页](../README.zh-CN.md)

## Describe the actual project / 说明真实用途

Use **Codex ZCode Tandem** as the plain-text name and **Codex × ZCode · Tandem** as the display name. The installable skill is `codex-zcode-tandem`. State the relationship directly: OpenAI Codex coordinates; native ZCode implements with the user's GLM Coding Plan; ACP connects them; development handoffs require independent review, repairs and verification.

中英文介绍应表达相同的用途：Codex 总控、原生 ZCode 执行、用户自己的 GLM Coding Plan、Windows 安装，以及默认独立审查。说明适合的任务，再给出安装入口。避免把历史更新记录放在首页开头。

## Maintain one owner for each fact / 保持事实一致

| Fact / 信息 | Source / 维护位置 |
| --- | --- |
| Purpose, supported users, quick start / 用途与安装入口 | README.md and README.zh-CN.md |
| Dependency pins / 依赖版本 | runtime/package.json |
| Tested native versions and evidence / 已验证版本与证据 | references/acceptance.md and its Chinese translation |
| Authentication / 认证方式 | references/installation.md and its Chinese translation |
| Review and delivery rules / 审查与交付规则 | references/delivery.md and its Chinese translation |
| Documentation links / 文档索引 | llms.txt |
| Historical changes / 历史更新 | CHANGELOG.md |

When a release changes one of these facts, update its owning guide and any README/FAQ summary in the same change. Keep historical records clearly dated. The documentation index should link to maintained version sources rather than repeat another list of version numbers.

发布后同步中英文首页与 FAQ；旧版验收保留日期，当前验收放在前面。保持下载、安装、审查机制和使用场景之间的链接有效。

## GitHub About and topics / 仓库简介与标签

GitHub About should explain the collaboration and include relevant terms such as Codex, ZCode, GLM Coding Plan, ACP, Windows and independent code review in a readable sentence. Link the website field to the quick start while the project has no separate website.

Use topics for tools, protocol, platform and actual use: `codex`, `openai-codex`, `zcode`, `codex-skill`, `agent-skills`, `agent-client-protocol`, `glm`, `glm-coding-plan`, `coding-plan`, `coding-agents`, `ai-coding`, `multi-agent`, `agent-orchestration`, `code-review`, `windows`.

GitHub settings are edited separately; this document does not apply them automatically. Do not add unrelated tool names, untested platforms or `mcp-server` as topics. Tandem's transport is ACP.

## Check discovery without promising rankings / 检查发现性

[GitHub documents](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories) separate searches in names, descriptions, topics and README content. Record the query, date, result URL and whether this repository appears. Separate a scoped metadata check from an unscoped discovery test:

- Scoped check: `repo:linxiangpk1991/codex-zcode-tandem "Coding Plan" in:description`.
- Broader GitHub searches: `codex zcode in:name,description`, `codex "coding plan" in:description`, `topic:code-review zcode`.
- Human questions to inspect in web/AI search: “How can Codex delegate coding to ZCode?”, “Codex GLM Coding Plan collaboration”, “如何让 Codex 和 ZCode 协作开发？”, “ZCode 开发完成后怎样自动复审、修复并验证？”.
- Treat GitHub traffic and actual user reports as separate observations; do not infer visits or installations from a keyword match.

`llms.txt` helps readers and assistants navigate the existing documentation. It is not a ranking signal we can promise. [Google's AI search guidance](https://developers.google.com/search/docs/appearance/ai-features) requires no special AI text file or schema and does not guarantee indexing. GitHub controls its hosted pages and crawler rules; adding robots.txt or JSON-LD to a repository is not equivalent to configuring a website.

不要把单次搜索结果、补充标签或增加 llms.txt 写成“排名提升”或“已被所有 AI 收录”。没有测量数据时，不宣称节省比例、速度优势或使用人数。向第三方目录投稿是单独的推广行为，需要维护者明确决定。
