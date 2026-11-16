# Codex ZCode Tandem FAQ

[简体中文](faq.zh-CN.md) · [Home](../README.md)

## What is Codex ZCode Tandem?

Codex ZCode Tandem is an open-source Windows skill connecting OpenAI Codex to native ZCode over ACP (Agent Client Protocol). Codex scopes and reviews work; native ZCode implements, tests, or reviews a defined task using the user's GLM Coding Plan. It is intended for people already using both tools.

## Does this replace Codex or ZCode?

No. Install both separately. Tandem connects a particular collaboration flow. Your selected Codex controller model is unchanged.

## Is it an official integration?

No. It is an independent community project. Product names identify the tools it connects; they do not imply endorsement.

## Why use this instead of copying prompts?

A saved session, structured progress, queued follow-ups, explicit pauses and native workflow recovery make repeated handoffs easier to inspect. If a task is tiny or a one-off answer is enough, copying a prompt or using a single agent can be simpler. We do not claim measured token savings or faster completion.

## Can Codex talk to ZCode while it works?

Codex can read progress immediately and submit a question or correction. A correction uses negotiated native now/next delivery; a question runs as a separate follow-up. The native engine may queue a correction until a safe boundary, and accepting it does not prove it was implemented. Already-running workflow actors need an explicit amendment or pause/readback/resume.

## Can I use my Coding Plan? Is an API key included?

You use your own installed and signed-in native ZCode. No account, subscription or API key is included. There is no automatic paid-API fallback. Account availability and model access depend on ZCode and your plan.

## Is provider_config.json required?

No. It is optional custom-provider configuration, not the Coding Plan login file. An explicitly supplied path must exist; an absent default file is allowed. Use the native connection probe to check the actual setup.

## Does “local” mean my prompts never leave my PC?

No. The adapter runs locally, but the native ZCode engine uses its service for model inference. ZCode's own data handling and account terms still apply. Tandem's tool checks are not an OS sandbox.

## Which models and platforms are supported?

Windows with Node 24.19.0 and ACP 0.85.3. For v1.6.0, the tested native baseline is Desktop 3.18.2.10443 / CLI 0.17.1. GLM-5.3 and GLM-5.3-Flash default to max reasoning. macOS/Linux and arbitrary provider/model combinations are not supported claims.

## Does pause undo edits? Does resume execute exactly once?

No to both. Pause stops current owned work; completed effects remain. Native saved nodes may be reused on resume or amendment. Read back uncertain effects before retrying and review which nodes were cached.

## Will it replace a zcode-native skill I already have?

No. Public Tandem installs as codex-zcode-tandem. It has a separate source root and entry. Invoke the intended skill explicitly if you keep both. There is no automatic synchronization between them.

## How do I report a bug?

Open an issue with versions, a small reproduction, expected/actual behavior and a redacted error excerpt. Do not upload complete native sessions, login files or private project data. See [security](../SECURITY.md) for sensitive reports.

## Is independent code review enabled by default?

Yes, for development requests from 1.5. A fresh native session reviews each candidate. Failed findings or checks cannot become a ready handoff; two unsuccessful repair rounds return a blocker. Read-only queries skip this loop.

## Does this run Codex on GLM, or connect Codex to ZCode?

It connects two tools. Codex remains the controller with its selected model; native ZCode uses the user's GLM Coding Plan to implement and test. It does not replace the Codex model, proxy the Codex API or transfer one subscription to another service.

## Is Tandem an MCP server?

No. Tandem is a Codex skill with a local ACP adapter. ACP carries the ZCode session and control messages. Install the skill using the [Windows installation guide](../references/installation.md); an MCP server configuration is not its installation method.

## Is it free? Do I need both accounts?

Tandem's code is MIT licensed, with no fee charged by this project. You still need access to Codex and a working ZCode account with the relevant model permissions. Their subscriptions, quotas and data-handling terms are separate. Independent review can consume additional ZCode usage; no cost reduction is guaranteed.

## Can ZCode validate a web interface without a vision model?

It can run authorized functional checks, such as project browser tests, and inspect text or DOM evidence when the task provides suitable tools. Screenshots remain pending visual acceptance by a vision-capable controller. File hashes prove which images were handed over, not whether the layout looks correct.
