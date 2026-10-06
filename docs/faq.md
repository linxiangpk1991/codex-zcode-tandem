# Frequently asked questions

[简体中文](faq.zh-CN.md) · [Home](../README.md)

## What is Codex ZCode Tandem?

A Windows Codex skill and local ACP adapter. Codex scopes and reviews work; native ZCode implements, tests, or reviews a defined task using the user's Coding Plan. It is intended for people already using both tools.

## Does this replace Codex or ZCode?

No. Install both separately. Tandem connects a particular collaboration flow. Your selected Codex controller model is unchanged.

## Is it an official integration?

No. It is an independent community project. Product names identify the tools it connects; they do not imply endorsement.

## Why use this instead of copying prompts?

A saved session, structured progress, queued follow-ups, explicit pauses and native workflow recovery make repeated handoffs easier to inspect. If a task is tiny or a one-off answer is enough, copying a prompt or using a single agent can be simpler. We do not claim measured token savings or faster completion.

## Can Codex talk to ZCode while it works?

Codex can read progress immediately and submit a question or correction. The message runs at the next safe foreground turn boundary, before remaining phases. It cannot interrupt a tool mid-call. Already-running workflow actors need an explicit amendment or pause/readback/resume.

## Can I use my Coding Plan? Is an API key included?

You use your own installed and signed-in native ZCode. No account, subscription or API key is included. There is no automatic paid-API fallback. Account availability and model access depend on ZCode and your plan.

## Is provider_config.json required?

No. It is optional custom-provider configuration, not the Coding Plan login file. An explicitly supplied path must exist; an absent default file is allowed. Use the native connection probe to check the actual setup.

## Does “local” mean my prompts never leave my PC?

No. The adapter runs locally, but the native ZCode engine uses its service for model inference. ZCode's own data handling and account terms still apply. Tandem's tool checks are not an OS sandbox.

## Which models and platforms are supported?

Windows with Node 24.19.0 and ACP 0.65.1. The tested native baseline is Desktop 3.14.4.7912 / CLI 0.16.9. GLM-5.3 and GLM-5.3-Flash default to max reasoning. macOS/Linux and arbitrary provider/model combinations are not supported claims.

## Does pause undo edits? Does resume execute exactly once?

No to both. Pause stops current owned work; completed effects remain. Native saved nodes may be reused on resume or amendment. Read back uncertain effects before retrying and review which nodes were cached.

## Will it replace a zcode-native skill I already have?

No. Public Tandem installs as codex-zcode-tandem. It has a separate source root and entry. Invoke the intended skill explicitly if you keep both. There is no automatic synchronization between them.

## How do I report a bug?

Open an issue with versions, a small reproduction, expected/actual behavior and a redacted error excerpt. Do not upload complete native sessions, login files or private project data. See [security](../SECURITY.md) for sensitive reports.
