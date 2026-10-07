# Verification and known limits

## 1.1 validation

136 offline checks cover Windows behavior, including large tool inputs, duplicate controls and closing/deadline races. Installation into a separate skills directory and a native GLM-5.3/max connection probe passed. The shared execution core was exercised in an isolated temporary repository: owned writes and reviewed Git status worked, controller-owned content remained unchanged, and a stash request was denied. Live steering ran before the next planned phase with separate queue/execution timestamps. Replaying those real tool records through the final input observer found no policy violations.

The real maintained-runner receipt was imported with matching source inputs, argv, cwd and exit code. Tests cover missing, stale, truncated, failed and mismatched receipts. Native startup fallback and optional quota snapshots were observed; shell-family classification is tested offline. These are same-machine checks, not validation on another physical PC or a cross-platform claim. Older results below remain historical baselines.

[简体中文](acceptance.zh-CN.md) · [Home](../README.md)

Last checked: **2026-10-07**. These results describe the adapter on the maintainer's Windows machine, not acceptance of a user's business project.

## Public edition 1.0.0

| Check | Observed result |
| --- | --- |
| Offline regressions | 109 passed, 0 failed, including a new public/private installation separation test |
| Independent source directory | Locked dependencies installed in the public checkout; no private local configuration copied |
| Skill installation | Installed into a separate recipient path containing Chinese characters and spaces; repeated setup created no extra backups |
| Skill format | Source and generated entry passed the official skill structure validator |
| Native connection | GLM-5.3 / max / build probe completed without model inference |
| Real inference smoke | GLM-5.3-Flash / max / build returned TANDEM-READY; this was an inference check, not a coding benchmark |
| Process ownership | The native processes owned by the two checks were cleaned up |
| Existing personal entry | Its file hash remained unchanged; the public entry uses codex-zcode-tandem |

The public change separates naming/installation and adds bilingual documentation. Runtime execution modules retain the previously tested V3.1 implementation. Public package version 1.0.0 and progress protocol version 3 are different version domains.

This is validation on one Windows computer, not a second-machine or cross-platform qualification. GitHub CI runs offline tests only; it has no native account and cannot prove ZCode compatibility.

## Native baseline

| Component | Tested value |
| --- | --- |
| Node | 24.19.0 |
| ACP adapter | zcode-acp-server 0.65.1, pinned in the lockfile |
| ZCode Desktop / CLI | 3.14.4.7912 / 0.16.9 |
| Models | Native Coding Plan GLM-5.3 and GLM-5.3-Flash |
| Reasoning / mode | max / build |

## Inherited workflow evidence

Earlier native checks on the unchanged execution core exercised:

- An ordinary user question, its exact answer, and queued steering before later foreground phases.
- Stopping and resuming a bound workflow, and retaining a changed concurrency limit.
- Two implementation actors, a separate reviewer, dependency joins and a completed notification.
- An amendment that reused five saved nodes and ran a new node.
- Bridge-crash handling and task-owned native process cleanup.

Independent GLM-5.3/max static review covered the core and follow-up corrections. Lightweight native workflow fixtures used GLM-5.3-Flash/max. These longer workflows were not all rerun merely for the public naming and documentation change.

A previous lifecycle test exposed a notification wait problem in management resume. The branch was corrected and covered by affected offline tests; the old client timeout is not reported as a successful client completion.

## Boundaries

Queued control is not mid-call injection. Resumed sessions may omit workflow permission callbacks. Observed input does not prevent or reverse execution, and tool policy is not an OS sandbox.

Management resume without a later foreground prompt can return terminal journal state without a notification; it explicitly records that the notification was not observed. Ordinary background handoff still needs the notification turn to complete.

Logs may be truncated; follow their cursors. Heartbeats and end_turn are insufficient for user acceptance. A configured 90-minute deadline has not been proven by a 90-minute unattended endurance run.

Raw results remain outside Git because they can contain local paths and project content. This page retains only the public verification summary. No production deployment, business-data write, remote-control service or scheduled watcher is included in these claims.
