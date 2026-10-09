# Architecture and maintenance boundaries

[简体中文](project-map.zh-CN.md) · [Home](../README.md)

## Data flow

run-task.mjs reads the request. config.mjs and request.mjs validate it; runner.mjs coordinates execution. transport.mjs starts bridge.mjs, which uses the pinned ACP adapter to call the separately installed native ZCode CLI and the user's Coding Plan.

discovery.mjs resolves paths from the recipient's environment and explicit configuration. scripts/setup.mjs checks the installation and writes a skill pointer. It does not download packages or copy login files.

control.mjs writes invocation-bound commands; inbox.mjs validates and consumes them. progress.mjs and jsonio.mjs write atomic snapshots/results. Optional provider configuration is passed as a path; the adapter does not read its credential contents. The native engine's data handling remains governed by ZCode.

| Module | Responsibility |
| --- | --- |
| runner | Effective configuration, ordered phases, control queue, questions, background wait and cleanup |
| bridge | Upstream instance access, notification boundary, workflow management and PID observation |
| native-guards / policy | Tool scope and script/model/run binding |
| workflow-observation | Checks actual tool input; observation is not a sandbox |
| evidence | Bounds log output and preserves cursors |
| transport | Child processes, ACP connection and bounded IPC lifecycle |
| native-identity | Local versions/SHA inspection and per-source-root successful connection baseline; metadata checks do not replace fresh hashing |
| tests | Offline protocol, state, permission, recovery, installer and cleanup regressions |

## Which evidence to trust

Read file changes from the real diff; models and reasoning from effective settings; workflow progress from native run/node events; control completion from receipts. A heartbeat, end_turn or exit code alone cannot establish product acceptance.

Upstream owns inference, scheduling and node caching. This project adapts those capabilities rather than implementing another scheduler. Upgrade by checking the upstream contract and compatibility, then running affected offline and native checks.

## Public and personal installations

The public package is codex-zcode-tandem-runtime, public skill codex-zcode-tandem. A separate zcode-native installation has its own source and entry. There is no automatic sync, path migration or account transfer between them.

Changes intended for both variants should be explicitly reviewed and ported. Never copy local config, execution logs or private repository history into the public project.

## Recovery and retained data

Keep the checkout because the skill points to it. Stop active tasks and inspect their effects before switching versions. Reinstall a retained checkout or restore an entry backup. Adapter rollback does not roll back the user's working files.

Git includes source, lockfile, examples, bilingual docs and artwork. Local config, node_modules, work, acceptance, rollback, dist, native state and environment files are ignored. Logs may contain project material, so inspect and redact before sharing them.

## Execution evidence in 1.1

workspace-policy checks ownership and exact command grants at permission callbacks. verification and scripts/check-evidence bind declared test inputs and import existing runner receipts; they do not execute tests. reporting produces startup diagnostics and a compact handoff. Model status and test acceptance have separate fields.

scope-observer keeps bounded policy-relevant inputs before log compaction and separates unknown scope evidence from confirmed policy violations.

`delivery.mjs` owns automatic first-pass review, candidate binding and handoff readiness. It reuses verification receipts; it does not execute tests or grant independent acceptance.
