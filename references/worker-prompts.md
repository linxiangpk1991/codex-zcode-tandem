# Write a useful task brief

[简体中文](worker-prompts.zh-CN.md) · [Home](../README.md)

Pass the context needed for this task. Do not forward an entire chat or secret configuration. Inspect the project before naming files, existing edits or test commands.

## Implementation, debugging and tests

```text
You are the native ZCode worker for this task.
Outcome: <observable behavior>.
Project: <absolute path>; baseline: <branch/commit and existing edits>.
Context and decisions: <original requirement, relevant design and rationale>.
Read first: <applicable AGENTS.md, entry points and relevant project docs>.
Own: <files/modules you may change>.
Preserve: <existing or other people's work>; do not revert it.

Requirements: <behavior, boundaries, compatibility>.
Forbidden effects: <out-of-scope publication, production data writes, etc.>.
Do not add undeclared workers, permanent background services or adjacent features.
If more scope is needed, return evidence and the smallest proposed change.

Verify: run <real command> within <time/attempt limits>.
Report environment, permission or quota errors honestly; do not switch paid channels.
Return changed behavior/files, actual commands and exit codes, unfinished items and risks.
Do not commit, push or deploy unless that action was separately authorized.
```

## Keep coherent phases together

A normal handoff can contain implementation, self-review and reporting in the prompts array, sharing one session. This self-review is not independent review.

Self-review phase:

```text
Inspect the actual diff, test output, edge cases and regression risks.
Fix relevant defects and rerun affected checks.
Do not expand the request or change test expectations to hide a bug.
State which paths you checked, even if you found no blocking issue.
```

Reporting phase:

```text
Report changed behavior, files, actual commands and exit codes,
visual evidence paths if relevant, unfinished items and risks.
Explicitly state which tests were not run.
```

## Follow up in the same session

```text
Continue the same task; preserve unaffected passing work.
Review finding: <defect and location>.
Evidence: <failing input, output or code path>.
Expected behavior: <correct result>.
Change only <scope> and run <affected check>.
If you disagree with the diagnosis, explain with evidence.
Return this round's changes and real execution results.
```

## Independent review

Use a new session or a named independent actor with the original requirement and actual candidate, not just the implementer's summary. For tool-restricted static review, use build mode, allow read/search, and explicitly disallow Bash, Write, Edit, MultiEdit, ApplyPatch, Task, Agent and workflow creation/amendment/resume. These controls are not an OS sandbox.

```text
Independently review <candidate/scope> against <original requirement>.
Inspect <source/diff/tests>, focusing on <correctness, boundaries and integration>.
Read only. Do not edit, execute shell commands, delegate or audit unrelated modules.
Report actionable findings with severity, file, trigger, effect and suggestion.
If none are blocking, say so. Static review does not mean you ran the tests.
```

## Request and result fields

Put prompts in JSON, not interpolated shell strings. Use absolute cwd/resultFile/progressFile, an explicit model, thought=max, mode=build, tool scope and deadline. The default deadline is 5400 seconds, maximum 7200; reserve cleanup time in any outer runner.

Inspect status, stopReason, modelEffective, thoughtEffective, modeEffective, permissions, tools, turns, and the actual diff. Do not read only response. Every required phase must complete its end_turn. After a timeout, inspect turns and continue the unfinished portion with the original sessionId instead of replaying the entire task.
