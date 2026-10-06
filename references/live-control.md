# Follow, steer and pause a task

[简体中文](live-control.zh-CN.md) · [Home](../README.md)

The request's progressFile is an atomic snapshot with invocation ID, ACP session ID, owner processes and the control inbox. Do not edit an active snapshot by hand.

## Read progress

From the source root, while the invocation is running:

```powershell
node.exe runtime/control.mjs --progress work/example-progress.json --action status
```

This reads a file; it does not call a model or interrupt work. Look at currentTurn, lastTool, pendingInput, controls, workflow and error. A changing heartbeat alone does not mean progress.

## Ask, steer or pause

```powershell
node.exe runtime/control.mjs --progress work/example-progress.json --action ask --message 'What is finished, and what is blocking you?'
node.exe runtime/control.mjs --progress work/example-progress.json --action steer --message 'Keep the existing API. Change only the input validation.'
node.exe runtime/control.mjs --progress work/example-progress.json --action pause
```

A successful submission means the command was queued. Inspect controls.history and the command receipt to confirm execution. Ask/steer run in the same session at a safe foreground boundary, before later planned phases. A long prompt has no intermediate prompt boundary; split genuinely distinct phases when responsiveness matters.

Steering does not rewrite instructions of an actor already running in a background workflow. Use a reviewed amendment or pause, read back effects, and resume with the revised plan.

Pause cancels the foreground turn and stops the bound workflow. It does **not** undo completed writes. Exit code 3 means paused; an outer runner may call that a nonzero exit, so read status=paused.

## Answer an ordinary question

```powershell
node.exe runtime/control.mjs --progress work/example-progress.json --action answer --interactionId '<pending-id>' --optionId '<offered-option-id>'
```

Use the exact pending interaction and one of its options. Expired answers, other invocations' questions and invented options are rejected. Plan approvals and tool permissions are not ordinary questions; answer cannot replace those controls.

## Workflow controls

```powershell
node.exe runtime/control.mjs --progress work/example-progress.json --action workflow-status
node.exe runtime/control.mjs --progress work/example-progress.json --action workflow-events --runId '<bound-run-id>' --afterSequence 0
node.exe runtime/control.mjs --progress work/example-progress.json --action workflow-settings --runId '<bound-run-id>' --maxConcurrency 2
```

Only bound runs are accepted. Concurrency is restricted to 1–4. Check native events for the result; setting submission is not proof that the engine applied it. See [workflows](native-workflows.md) for recovery after the owning invocation exits.

You can also save one command object to JSON and use `node.exe runtime/control.mjs PROGRESS.json COMMAND.json`:

```json
{"action":"steer","message":"Keep the API; adjust input validation only."}
```

Command results are stored in this invocation's inbox/results directory. Read result paths and truncation flags; fetch later log pages as needed. The owner process must be alive to consume live commands.

## After the invocation exits

Use the original sessionId/cwd in a new bounded request, inspect what happened, and continue only unfinished work. Do not replay commands already processed. Default total deadline is 90 minutes, maximum two hours. A short idleSeconds window keeps a finished invocation available for follow-up; it is not a permanent service.

If an external write has an unknown result, read its authoritative state before retrying. Machine-wide quota recovery stays disabled. Scheduling requires a user's request.
