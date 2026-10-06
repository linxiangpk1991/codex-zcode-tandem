---
name: codex-zcode-tandem
description: Coordinate Codex and native ZCode over ACP on Windows. Use when the user asks to delegate implementation, testing, or independent review to ZCode, or to inspect, steer, pause, or resume that work.
---

# Codex × ZCode · Tandem

Use the native ZCode engine and the user's own Coding Plan. Preserve their chosen Codex model and reasoning setting. Default to GLM-5.3 for core work/review and GLM-5.3-Flash for small bounded tasks, both at thought=max. Do not silently substitute another engine or paid API.

This file's directory is the source root. The installed pointer records its actual location and Node executable. Resolve runtime/ and references/ from this source root, not from the user's project. Never borrow another person's paths or account.

Windows and Node 24.19.0 are required; ACP is pinned to 0.65.1. Run runtime/run-task.mjs REQUEST.json. For installation issues, read [installation](references/installation.md), then use scripts/setup.mjs --check. [中文操作说明](references/skill.zh-CN.md).

## Delegate a coherent piece of work

Codex owns scope, project baseline, allowed and preserved paths, decisions, integration, and final acceptance. ZCode owns the assigned implementation/test/fix phase. Do not create a duplicate executor for a phase already assigned to ZCode.

ZCode does not inherit this chat. Send the necessary original requirement and applicable project rules using [task briefs](references/worker-prompts.md). An implementation session's self-review is not independent review; use a separate restricted session or explicitly named workflow actor when independence matters.

The skill does not authorize publication, production writes, credential access, or unrelated delegation. Keep the project's existing effect and authorization boundaries.

## Execute and follow progress

Use absolute cwd, resultFile and progressFile. Set model, thought=max, mode=build, allowToolKinds and timeoutSeconds explicitly. The default deadline is 5400 seconds, maximum 7200. The client enforces the deadline and cleans up its owned process tree. Use the host's bounded runner when required or already provided; no private Harness installation is a dependency.

action=probe checks the connection and effective configuration without model inference. Read the effective model, thought and mode. A heartbeat is not work: inspect controls, pendingInput, currentTurn, lastTool, workflow and error.

Read [live control](references/live-control.md) before querying, asking, steering, answering or pausing. New prompts run serially at safe boundaries. Pause does not undo writes. Read back unknown outcomes before continuing.

Do not switch to a paid provider on quota failure. Machine-wide auto-resume is disabled. Scheduling follow-ups requires a user request.

## Native workflows, when useful

Use ordinary prompt phases for sequential work. Read [native workflows](references/native-workflows.md) for parallel actors, joins, saved results, concurrency or recovery.

Review the complete script and bind its SHA-256 and canonical model before launch/amendment. Amendments also bind the predecessor run ID. Check both permission callbacks and observed tool inputs. Resumed native sessions may omit callbacks: these checks cannot guarantee prevention before execution and are not an OS sandbox.

Only use declared actors and responsibilities. Do not recursively expand delegation. Separate contexts are not tool isolation. ACP session IDs and workflow run IDs are different.

Queued foreground steering does not rewrite a running actor's instructions. Use a reviewed amendment, or pause, inspect effects, then continue.

## Accept results and recover

Check the actual diff, meaningful tests, permissions and native state. ACP end_turn is not product acceptance. Ordinary background handoff needs both native terminal state and completed notification. Follow log cursors when output is truncated.

After interruption, retain the original session/cwd and continue only unfinished work. Reuse unaffected passing results. Diagnose repeated failures rather than blindly replaying tasks or unknown external writes.

Report changed behavior/files, actual commands and results, session/run identifiers and remaining limitations. A configured 90-minute deadline is not an endurance-test result. See [verification](references/acceptance.md).

Stop active invocations before upgrading. Existing changed entries need setup --replace, which backs up the old entry. Do not let old clients take over active newer sessions. The public skill codex-zcode-tandem and a private zcode-native installation are separate; never overwrite one to update the other.
